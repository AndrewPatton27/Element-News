// Runs summarizers in order (a plain list: adding a provider is one entry).
// 1. License gate before any provider: only public-domain and filing text.
// 2. Each AI provider (Gemini, then Groq): skipped when its own daily cap is reached;
//    one retry with the validator errors; a 429, 5xx, timeout or other provider error,
//    or two rejected drafts, moves on to the next provider. A provider whose key is
//    missing is simply not in the list (see providers.ts).
// 3. The template summarizer is the last resort and never calls an AI.
// Pacing and caps are per provider: Groq does not wait on Gemini's timer.
// 4. A 429 puts that provider in a cooldown (config.rateLimitCooldownMs) for the rest of
//    the run when the caller passes a ChainState: later items skip it instead of hammering it.
// 5. Everyday relevance (same AI call): an AI draft scored below opts.minRelevance is returned at
//    once with low_relevance = true (no validation, no retry), so a skipped item costs one AI call.
//    With opts.requireRelevance, an AI draft without a valid 1-5 score counts as rejected.
// 6. Safety net: if a draft's only problems are length errors and the headline fits, the
//    body is cut after the last whole sentence that fits, then the draft is re-validated.
// Inputs: SummarizeInput, the provider list, a usage counter and options (caps, cooldown, relevance).
// Outputs: ChainResult (draft, provider, model, relevance, log lines without text or keys).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { aiDailyCap, config } from '../config.ts';
import { assertSummarizable, checkRelevance, checkShape, requiresFigures, trimBodyToFit, validateDetail, validateDraft, type SourceText } from '../validate.ts';
import { templateSummarizer } from './template.ts';
import type { SummarizeInput, Summarizer, SummaryDraft } from '../types.ts';

export interface UsageCounter {
  used(provider: string): number;
  add(provider: string): void;
}

/** In-memory counter (tests, dry runs). */
export function memoryCounter(): UsageCounter {
  const m = new Map<string, number>();
  return { used: (p) => m.get(p) ?? 0, add: (p) => m.set(p, (m.get(p) ?? 0) + 1) };
}

/** Per-day counter stored in a local JSON file (resets when the UTC date changes). */
export function fileCounter(path: string, today = () => new Date().toISOString().slice(0, 10)): UsageCounter {
  const load = (): { day: string; counts: Record<string, number> } => {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'));
      if (s.day === today()) return s;
    } catch { /* first run */ }
    return { day: today(), counts: {} };
  };
  return {
    used: (p) => load().counts[p] ?? 0,
    add: (p) => {
      const s = load();
      s.counts[p] = (s.counts[p] ?? 0) + 1;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(s));
    },
  };
}

/** Keeps calls to one provider at least minIntervalMs apart (free tiers have a requests-per-minute limit). */
const lastCall = new Map<string, number>();
async function pace(provider: string, minIntervalMs: number): Promise<void> {
  const wait = (lastCall.get(provider) ?? 0) + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(provider, Date.now());
}

/** Per-run state shared across items: when each provider may be called again after a 429. */
export interface ChainState {
  coolUntil: Map<string, number>;
}
/** Fresh ChainState (no provider cooling down). */
export const createChainState = (): ChainState => ({ coolUntil: new Map() });

export interface ChainResult {
  draft: SummaryDraft;
  provider: string;
  ai_generated: boolean;
  model: string | null;
  log: string[];                     // what happened, for the run report (no text, no keys)
  relevance: number | null;          // AI everyday_relevance score (1-5); null for template drafts
  low_relevance?: boolean;           // true: below opts.minRelevance, do not publish
}

/**
 * The card passed; now the detail. A detail that fails its checks (or is missing) is dropped
 * (detail null) and the card is still used: the card is the product, the detail is extra.
 */
function finishDetail(draft: SummaryDraft, source: SourceText, provider: string, log: string[]): SummaryDraft {
  if (draft.detail === undefined || draft.detail === null) return { ...draft, detail: null };
  const v = validateDetail(draft.detail, source, source.category ?? draft.category);
  if (v.ok) return draft;
  log.push(`${provider}: detail dropped (card kept): ${v.errors.join('; ')}`);
  return { ...draft, detail: null };
}

/**
 * Summarizes one item through the provider chain (see the header for the full rules). Outline:
 * license gate -> for each AI provider: cooldown check, then up to 2 attempts of
 * [cap check, pace, call, shape + relevance check, low-relevance exit, validate, length trim] ->
 * template fallback. Throws NotSummarizableError before any provider sees unlicensed text.
 */
export async function summarizeWithChain(
  input: SummarizeInput,
  providers: Summarizer[],
  counter: UsageCounter,
  // cap / minIntervalMs override every provider's own values (tests); normally each provider carries its own.
  opts: {
    cap?: number; minIntervalMs?: number; state?: ChainState; cooldownMs?: number; now?: () => number;
    minRelevance?: number; requireRelevance?: boolean;
  } = {},
): Promise<ChainResult> {
  const now = opts.now ?? Date.now;
  const state = opts.state ?? createChainState();      // no state passed: no memory between items
  assertSummarizable(input.item.license_class);   // throws before any provider sees the text
  const source = {
    text: input.text, licenseClass: input.item.license_class, tickers: input.item.tickers.map((t) => t.symbol), category: input.item.category,
    requireFigures: requiresFigures(input.item),      // event_type earnings (set in code) -> the body must have figures
    checkFlow: true,                                  // AI drafts must not repeat themselves (template drafts never come through here)
  };
  const log: string[] = [];

  for (const p of providers) {
    if (!p.usesAi) continue;                        // template runs last, below
    const coolLeft = (state.coolUntil.get(p.name) ?? 0) - now();
    if (coolLeft > 0) {
      log.push(`${p.name}: cooling down after a rate limit (${Math.ceil(coolLeft / 1000)} s left), skipped`);
      continue;
    }
    const cap = opts.cap ?? p.dailyCap ?? aiDailyCap();
    let retryErrors: string[] | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (counter.used(p.name) >= cap) {
        log.push(`${p.name}: daily cap ${cap} reached`);
        break;
      }
      await pace(p.name, opts.minIntervalMs ?? p.minIntervalMs ?? 0);
      counter.add(p.name);
      let draft: SummaryDraft;
      try {
        draft = await p.summarize({ ...input, retryErrors });
      } catch (e) {
        log.push(`${p.name}: ${(e as Error).name}: ${(e as Error).message}`);
        if ((e as Error).name === 'RateLimitedError') {
          state.coolUntil.set(p.name, now() + (opts.cooldownMs ?? config.rateLimitCooldownMs));
        }
        break;                                       // rate limit, timeout or provider error: next provider
      }
      const shape = [...checkShape(draft), ...checkRelevance(draft ?? {}, !!opts.requireRelevance)];
      const relevance = typeof draft?.everyday_relevance === 'number' && !shape.length ? draft.everyday_relevance : null;
      if (relevance !== null && opts.minRelevance !== undefined && relevance < opts.minRelevance) {
        log.push(`${p.name}: everyday_relevance ${relevance} below ${opts.minRelevance} (attempt ${attempt})`);
        return { draft, provider: p.name, ai_generated: true, model: p.model ?? null, log, relevance, low_relevance: true };
      }
      const v = shape.length ? { ok: false, errors: shape } : validateDraft(draft, source);
      if (v.ok) {
        log.push(`${p.name}: ok (attempt ${attempt})`);
        return { draft: finishDetail(draft, source, p.name, log), provider: p.name, ai_generated: true, model: p.model ?? null, log, relevance };   // the model that wrote it
      }
      log.push(`${p.name}: rejected (attempt ${attempt}): ${v.errors.join('; ')}`);
      // Length-only problems: one deterministic fix (whole sentences only), then full re-validation.
      // Done before the retry so a fixable draft costs no extra request.
      const fixed = trimBodyToFit(draft, v.errors);
      if (fixed) {
        const v2 = validateDraft(fixed, source);
        if (v2.ok) {
          log.push(`${p.name}: ok after trimming the body to whole sentences (attempt ${attempt})`);
          return { draft: finishDetail(fixed as SummaryDraft, source, p.name, log), provider: p.name, ai_generated: true, model: p.model ?? null, log, relevance };
        }
        log.push(`${p.name}: trimmed body still rejected: ${v2.errors.join('; ')}`);
      }
      retryErrors = v.errors;
    }
  }

  const draft = await templateSummarizer.summarize(input);
  log.push('template: used');
  return { draft, provider: 'template', ai_generated: false, model: null, log, relevance: null };
}
