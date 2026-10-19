// AI usage caps backed by the database (core.ai_usage via api.ai_usage_take / api.ai_usage_get) instead
// of the laptop's ingest/state/ai-usage.json, so the daily caps (Gemini 500, Groq 74) hold across runs.
// How it fits the existing chain (ingest/src/summarizer/chain.ts, whose UsageCounter is synchronous):
//   - createUsageTracker() loads today's counts once (snapshot) and gives the chain a sync UsageCounter;
//   - every real AI call is wrapped (withUsage / textModelWithUsage) and first awaits an ATOMIC
//     api.ai_usage_take(provider, cap). A refused take throws CapReachedError, so the chain moves on to
//     the next provider (Groq, then the template) exactly as for a 429, and the provider is marked full.
//   - if the counter RPC fails (e.g. migration not applied), AI calls are refused: caps are never guessed.
// A time gate (budget.ts) can also close a provider: its dailyCap reads 0, so the chain skips it
// before pacing or counting.
// Inputs: a UsageStore (RPC or memory), providers. Outputs: wrapped providers, counts for the run log.

import type { Rpc } from './rpc.ts';
import type { Summarizer, TextModel, UsageCounter } from './ingest.ts';

export interface UsageStore {
  /** today's (UTC) calls per provider */
  get(): Promise<Record<string, number>>;
  /** atomically count one call if under `cap`; false = at the cap */
  take(provider: string, cap: number): Promise<boolean>;
}

/** The database store: service-role RPCs from 20261019040000_ai_usage.sql. */
export function rpcUsageStore(rpc: Rpc): UsageStore {
  return {
    async get() {
      const r = await rpc<Record<string, number> | null>('ai_usage_get', {});
      return r && typeof r === 'object' ? r : {};
    },
    async take(provider, cap) {
      return (await rpc<boolean>('ai_usage_take', { p_provider: provider, p_cap: cap })) === true;
    },
  };
}

/** In-memory store with the same semantics as the SQL (tests, dry runs). */
export function memoryUsageStore(initial: Record<string, number> = {}): UsageStore & { counts: Record<string, number> } {
  const counts: Record<string, number> = { ...initial };
  return {
    counts,
    async get() { return { ...counts }; },
    async take(provider, cap) {
      if ((counts[provider] ?? 0) >= cap) return false;
      counts[provider] = (counts[provider] ?? 0) + 1;
      return true;
    },
  };
}

export class CapReachedError extends Error {
  constructor(message: string) { super(message); this.name = 'CapReachedError'; }
}
export class TimeBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'TimeBudgetError'; }
}

export interface UsageTracker {
  /** sync view for the chain's own cap check: snapshot + calls this run; huge once the DB said no */
  counter: UsageCounter;
  /** calls the database granted this run, per provider */
  taken: Record<string, number>;
  /** takes the database refused (cap reached) or could not answer, per provider */
  denied: Record<string, number>;
  /** problems talking to the counter (no keys, no text) */
  errors: string[];
  /** awaits the atomic take; throws CapReachedError when refused or when the counter is unavailable */
  take(provider: string, cap: number): Promise<void>;
  totalTaken(): number;
}

const FULL = Number.MAX_SAFE_INTEGER;

export async function createUsageTracker(store: UsageStore): Promise<UsageTracker> {
  const errors: string[] = [];
  let snapshot: Record<string, number> = {};
  let available = true;
  try {
    snapshot = await store.get();
  } catch (e) {
    available = false;
    errors.push(`usage counter unavailable: ${(e as Error).message}`);
  }
  const local: Record<string, number> = {};
  const full = new Set<string>();
  const taken: Record<string, number> = {};
  const denied: Record<string, number> = {};
  const counter: UsageCounter = {
    used: (p) => (!available || full.has(p) ? FULL : (snapshot[p] ?? 0) + (local[p] ?? 0)),
    add: (p) => { local[p] = (local[p] ?? 0) + 1; },
  };
  return {
    counter, taken, denied, errors,
    totalTaken: () => Object.values(taken).reduce((a, b) => a + b, 0),
    async take(provider, cap) {
      let ok = false;
      if (available) {
        try {
          ok = await store.take(provider, cap);
        } catch (e) {
          errors.push(`usage take failed for ${provider}: ${(e as Error).message}`);
        }
      }
      if (!ok) {
        full.add(provider);
        denied[provider] = (denied[provider] ?? 0) + 1;
        throw new CapReachedError(`${provider}: daily cap ${cap} reached (database counter)${available ? '' : ' or counter unavailable'}`);
      }
      taken[provider] = (taken[provider] ?? 0) + 1;
    },
  };
}

/** Time gate: true if an AI call that may first wait `waitMs` (pacing) can still finish in time. */
export type AiGate = (waitMs: number) => boolean;

/**
 * Wraps a card summarizer. AI providers: dailyCap reads 0 when the time gate is closed (the chain
 * skips the provider without pacing or counting); summarize() and generate() (the report-card
 * scorer) await the atomic database take first. The template (usesAi false) passes through unchanged.
 */
export function withUsage(p: Summarizer, tracker: UsageTracker, cap: number, gate: AiGate = () => true): Summarizer {
  if (!p.usesAi) return p;
  const before = async (waitMs: number) => {
    if (!gate(waitMs)) throw new TimeBudgetError(`${p.name}: not enough time left in this run`);
    await tracker.take(p.name, cap);
  };
  const w: Summarizer = {
    name: p.name,
    usesAi: true,
    model: p.model,
    minIntervalMs: p.minIntervalMs,
    get dailyCap() { return gate(p.minIntervalMs ?? 0) ? cap : 0; },
    async summarize(input) {
      await before(0);                 // the chain already paced this call
      return p.summarize(input);
    },
  };
  if (p.generate) {
    const gen = p.generate.bind(p);
    w.generate = async (prompt, o) => { await before(0); return gen(prompt, o); };
  }
  return w;
}

/** Same for the brief-summary text models (ingest/src/briefSummary.ts TextModel). */
export function textModelWithUsage(m: TextModel, tracker: UsageTracker, gate: AiGate = () => true): TextModel {
  const cap = m.dailyCap;
  return {
    name: m.name,
    model: m.model,
    get dailyCap() { return gate(0) ? cap : 0; },
    async generate(prompt) {
      if (!gate(0)) throw new TimeBudgetError(`${m.name}: not enough time left in this run`);
      await tracker.take(m.name, cap);
      return m.generate(prompt);
    },
  };
}
