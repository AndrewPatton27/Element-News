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
// Watchdog additions (20261110000000_watchdog.sql): the cap itself lives in core.ai_caps (the cap passed here is
// the fallback), a few calls per provider are RESERVED for brief-summary (use_reserve), and a 429 that says the
// DAILY quota is used up sets today's use to the cap (exhaust), so the rest of the day skips that provider.
// Inputs: a UsageStore (RPC or memory), providers. Outputs: wrapped providers, counts for the run log.

import type { Rpc } from './rpc.ts';
import type { Summarizer, TextModel, UsageCounter } from './ingest.ts';

export interface UsageStore {
  /** today's (UTC) calls per provider */
  get(): Promise<Record<string, number>>;
  /** atomically count one call if under `cap` (minus the reserve unless useReserve); false = at the cap */
  take(provider: string, cap: number, useReserve?: boolean): Promise<boolean>;
  /** a daily-quota 429: use up today's calls for this provider */
  exhaust?(provider: string): Promise<void>;
}

/** The database store: service-role RPCs from 20261019040000_ai_usage.sql. */
export function rpcUsageStore(rpc: Rpc): UsageStore {
  return {
    async get() {
      const r = await rpc<Record<string, number> | null>('ai_usage_get', {});
      return r && typeof r === 'object' ? r : {};
    },
    async take(provider, cap, useReserve = false) {
      // p_use_reserve is only sent when true, so the call also fits the older 2-argument function.
      const body = useReserve ? { p_provider: provider, p_cap: cap, p_use_reserve: true } : { p_provider: provider, p_cap: cap };
      return (await rpc<boolean>('ai_usage_take', body)) === true;
    },
    async exhaust(provider) {
      await rpc('ai_usage_exhaust', { p_provider: provider });
    },
  };
}

/** In-memory store with the same semantics as the SQL (tests, dry runs). */
export function memoryUsageStore(
  initial: Record<string, number> = {},
  caps: Record<string, { cap: number; reserve: number }> = {},
): UsageStore & { counts: Record<string, number> } {
  const counts: Record<string, number> = { ...initial };
  return {
    counts,
    async get() { return { ...counts }; },
    async take(provider, cap, useReserve = false) {
      const c = caps[provider];
      const limit = c ? (useReserve ? c.cap : Math.max(c.cap - c.reserve, 0)) : cap;   // a table cap wins over the argument
      if ((counts[provider] ?? 0) >= limit) return false;
      counts[provider] = (counts[provider] ?? 0) + 1;
      return true;
    },
    async exhaust(provider) {
      const c = caps[provider];
      if (c) counts[provider] = Math.max(counts[provider] ?? 0, c.cap);
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
  take(provider: string, cap: number, useReserve?: boolean): Promise<void>;
  /** a daily-quota 429 came back: mark the provider full here and in the database (never throws) */
  exhaust(provider: string): Promise<void>;
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
    async exhaust(provider) {
      full.add(provider);
      if (available && store.exhaust) {
        try { await store.exhaust(provider); } catch (e) { errors.push(`usage exhaust failed for ${provider}: ${(e as Error).message}`); }
      }
    },
    async take(provider, cap, useReserve = false) {
      let ok = false;
      if (available) {
        try {
          ok = await store.take(provider, cap, useReserve);
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

/** True for a RateLimitedError whose 429 said the daily quota is gone (ingest/src/summarizer/gemini.ts). */
function isDailyLimit(e: unknown): boolean {
  return (e as Error)?.name === 'RateLimitedError' && (e as { daily?: boolean }).daily === true;
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
    get model() { return p.model; },
    get modelMissing() { return p.modelMissing; },
    minIntervalMs: p.minIntervalMs,
    get dailyCap() { return gate(p.minIntervalMs ?? 0) ? cap : 0; },
    async summarize(input) {
      await before(0);                 // the chain already paced this call
      try { return await p.summarize(input); }
      catch (e) { if (isDailyLimit(e)) await tracker.exhaust(p.name); throw e; }
    },
  };
  if (p.generate) {
    const gen = p.generate.bind(p);
    w.generate = async (prompt, o) => {
      await before(0);
      try { return await gen(prompt, o); }
      catch (e) { if (isDailyLimit(e)) await tracker.exhaust(p.name); throw e; }
    };
  }
  return w;
}

/** Same for the brief-summary text models (ingest/src/briefSummary.ts TextModel). */
export function textModelWithUsage(m: TextModel, tracker: UsageTracker, gate: AiGate = () => true): TextModel {
  const cap = m.dailyCap;
  return {
    name: m.name,
    get model() { return m.model; },
    get modelMissing() { return m.modelMissing; },
    get dailyCap() { return gate(0) ? cap : 0; },
    async generate(prompt) {
      if (!gate(0)) throw new TimeBudgetError(`${m.name}: not enough time left in this run`);
      await tracker.take(m.name, cap, true);           // the Brief may use the calls kept in reserve
      try { return await m.generate(prompt); }
      catch (e) { if (isDailyLimit(e)) await tracker.exhaust(m.name); throw e; }
    },
  };
}
