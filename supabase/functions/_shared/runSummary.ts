// The JSON summary one function call returns, and the matching ingest.run_log row (api.log_run).
// Pure functions: no I/O. Log lines are kept short and never contain keys (the pipeline never logs them;
// URLs with a FRED api_key are never logged, only hosts) or source text.
// Inputs: counts from the pipeline (RunStats), the publisher guard and the usage tracker.
// Outputs: RunSummary (HTTP reply) and the api.log_run payload.

import type { RunStats } from './ingest.ts';
import type { PublisherGuardCounts, StopReason } from './budget.ts';

export const LOG_TAIL_LINES = 40;
export const LOG_LINE_MAX = 300;

export interface RunSummary {
  source: string;
  ok: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  items_new: number;
  published: number;
  skipped: number;
  failed: number;
  ai_calls: number;
  deferred: number;
  stopped_by: StopReason | 'error';
  error: string | null;
  stats: Partial<RunStats>;
  ai_denied: Record<string, number>;
  log_tail: string[];
}

/** Keeps the last `n` log lines, each cut to LOG_LINE_MAX characters. */
export function logTail(lines: string[], n = LOG_TAIL_LINES): string[] {
  return lines.slice(-n).map((l) => (l.length > LOG_LINE_MAX ? `${l.slice(0, LOG_LINE_MAX - 1)}…` : l));
}

export function buildRunSummary(i: {
  source: string;
  startedAt: number;
  finishedAt: number;
  stats?: Partial<RunStats>;
  guard?: PublisherGuardCounts;
  aiCalls: number;
  aiDenied?: Record<string, number>;
  error?: string | null;
  log: string[];
}): RunSummary {
  const s = i.stats ?? {};
  const g = i.guard ?? { itemsNew: 0, deferredTime: 0, deferredCap: 0, stoppedBy: 'done' as StopReason };
  const deferred = g.deferredTime + g.deferredCap;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // The pipeline counts a deferred item as skipped ("already handled"); it was never started, so it is taken out.
  const skipped = Math.max(0, num(s.skipped) + num(s.duplicate) + num(s.ticker_cap) - deferred);
  const error = i.error ? i.error.slice(0, 1000) : null;
  return {
    source: i.source,
    ok: !error,
    started_at: new Date(i.startedAt).toISOString(),
    finished_at: new Date(i.finishedAt).toISOString(),
    duration_ms: Math.max(0, i.finishedAt - i.startedAt),
    items_new: g.itemsNew,
    published: num(s.published) + num(s.data_cards),
    skipped,
    failed: num(s.failed),
    ai_calls: i.aiCalls,
    deferred,
    stopped_by: error ? 'error' : g.stoppedBy,
    error,
    stats: s,
    ai_denied: i.aiDenied ?? {},
    log_tail: logTail(i.log),
  };
}

/** The api.log_run payload for a summary (same counts; the rest goes in `detail`). */
export function runLogPayload(r: RunSummary): Record<string, unknown> {
  return {
    source: r.source,
    started_at: r.started_at,
    finished_at: r.finished_at,
    items_new: r.items_new,
    published: r.published,
    skipped: r.skipped,
    failed: r.failed,
    ai_calls: r.ai_calls,
    error: r.error,
    detail: {
      duration_ms: r.duration_ms, deferred: r.deferred, stopped_by: r.stopped_by,
      stats: r.stats, ai_denied: r.ai_denied, log_tail: r.log_tail,
    },
  };
}
