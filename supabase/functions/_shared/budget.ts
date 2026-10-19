// Time and work budget for one Edge Function call (free tier: 150 s wall clock, 2 s CPU; network
// waits are not CPU). The pipeline (ingest/src/pipeline.ts) is not changed; the budget works through
// the injected dependencies instead:
//   - guardPublisher(): once the soft deadline has passed, or `workCap` new items were worked on,
//     publisher.upsertItem() answers "already handled" WITHOUT writing, so the pipeline starts no new
//     item (no page fetch, no AI call) and the item stays unrecorded for the next run;
//   - aiGate(): an AI call (after its pacing wait) must still fit before the hard deadline, otherwise
//     the provider is skipped (usage.ts) and the chain falls back like after a 429;
//   - guardFetch(): no network request is started after the hard deadline.
// Inputs: clock, soft/hard deadlines in ms from the start, the per-call timeout. Outputs: wrappers + counts.

import type { Deps, Publisher } from './ingest.ts';

export interface TimeBudget {
  startedAt: number;
  softMs: number;
  hardMs: number;
  elapsedMs(): number;
  /** a new item may be started (before the soft deadline) */
  canStartItem(): boolean;
  /** an AI call that first waits `waitMs` and may take up to callTimeoutMs still ends before the hard deadline */
  aiAllowed(waitMs: number): boolean;
  pastHard(): boolean;
}

export function createTimeBudget(opts: { softMs?: number; hardMs?: number; callTimeoutMs?: number; now?: () => number } = {}): TimeBudget {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const softMs = opts.softMs ?? 100_000;
  const hardMs = opts.hardMs ?? 140_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 20_000;
  const elapsedMs = () => now() - startedAt;
  return {
    startedAt, softMs, hardMs, elapsedMs,
    canStartItem: () => elapsedMs() < softMs,
    aiAllowed: (waitMs) => elapsedMs() + Math.max(0, waitMs) + callTimeoutMs <= hardMs,
    pastHard: () => elapsedMs() >= hardMs,
  };
}

export type StopReason = 'done' | 'time' | 'work_cap';

export interface PublisherGuardCounts {
  /** items worked on this call (new, or recorded earlier but still status 'new') */
  itemsNew: number;
  /** items not started because the soft deadline had passed */
  deferredTime: number;
  /** items not started because workCap was reached */
  deferredCap: number;
  stoppedBy: StopReason;
}

/** Wraps a Publisher so the pipeline stops starting new items at the deadline or the work cap. */
export function guardPublisher(pub: Publisher, budget: TimeBudget, workCap: number): { publisher: Publisher; counts: PublisherGuardCounts } {
  const counts: PublisherGuardCounts = { itemsNew: 0, deferredTime: 0, deferredCap: 0, stoppedBy: 'done' };
  const deferred = { id: '', is_new: false, status: 'deferred' };
  const publisher: Publisher = {
    ...pub,
    async upsertItem(item) {
      if (!budget.canStartItem()) {
        counts.deferredTime++;
        counts.stoppedBy = 'time';
        return deferred;
      }
      if (counts.itemsNew >= workCap) {
        counts.deferredCap++;
        if (counts.stoppedBy === 'done') counts.stoppedBy = 'work_cap';
        return deferred;
      }
      const row = await pub.upsertItem(item);
      if (row.is_new || row.status === 'new') counts.itemsNew++;
      return row;
    },
  };
  return { publisher, counts };
}

/** Wraps fetchText so no request starts after the hard deadline (the error is logged by the pipeline). */
export function guardFetch(fetchText: Deps['fetchText'], budget: TimeBudget): Deps['fetchText'] {
  return async (url, kind, ttl) => {
    if (budget.pastHard()) throw new Error(`time budget used up; not fetching ${new URL(url).hostname}`);
    return fetchText(url, kind, ttl);
  };
}
