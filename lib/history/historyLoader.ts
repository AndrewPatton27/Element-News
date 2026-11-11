// Lazy, cached loading of series history for data cards. Many cards ask in the same moment, so asks are collected
// for a short window and sent as batches of at most MAX_SERIES_PER_CALL series (one api.macro_history call each).
// Answers are cached (a series with no history too), failures only briefly, so feed pages stay small and a card
// scrolled back into view never refetches. Pure: the fetch function is injected (node tests run it offline).

import { MAX_SERIES_PER_CALL, type MacroHistory, type SeriesHistory } from './seriesHistory.ts';

export interface HistoryLoaderOptions {
  fetchHistory: (ids: string[]) => Promise<MacroHistory>;
  ttlMs?: number;          // how long an answer is kept (default 10 minutes)
  failTtlMs?: number;      // how long a failure is remembered (default 60 seconds)
  batchMs?: number;        // collect window (default 30 ms)
  now?: () => number;
}

export interface HistoryLoader {
  /** The cached answer for these series, or a fresh one. Never rejects; a series with no data is simply absent. */
  load(ids: string[]): Promise<MacroHistory>;
  /** Cached answer right now (undefined while unknown), for the first render. */
  peek(ids: string[]): MacroHistory | undefined;
}

interface Entry { at: number; ok: boolean; value: SeriesHistory | null }

export function createHistoryLoader(opts: HistoryLoaderOptions): HistoryLoader {
  const ttl = opts.ttlMs ?? 600_000, failTtl = opts.failTtlMs ?? 60_000, batchMs = opts.batchMs ?? 30;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<void>>();
  let queue = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: { ids: string[]; done: () => void }[] = [];

  const fresh = (e: Entry | undefined) => !!e && now() - e.at < (e.ok ? ttl : failTtl);

  async function flush() {
    timer = null;
    const ids = [...queue];
    const mine = waiters;
    queue = new Set();
    waiters = [];
    for (let i = 0; i < ids.length; i += MAX_SERIES_PER_CALL) {
      const chunk = ids.slice(i, i + MAX_SERIES_PER_CALL);
      let answer: MacroHistory | null = null;
      try { answer = await opts.fetchHistory(chunk); } catch { answer = null; }
      for (const id of chunk) cache.set(id, { at: now(), ok: answer !== null, value: answer?.[id] ?? null });
    }
    for (const id of ids) inflight.delete(id);
    mine.forEach((w) => w.done());
  }

  const collect = (cached: MacroHistory) => (ids: string[]): MacroHistory => {
    for (const id of ids) { const v = cache.get(id)?.value; if (v) cached[id] = v; }
    return cached;
  };

  return {
    peek(ids) {
      if (!ids.every((id) => fresh(cache.get(id)))) return undefined;
      return collect({})(ids);
    },
    load(ids) {
      const want = [...new Set(ids)];
      const missing = want.filter((id) => !fresh(cache.get(id)));
      if (missing.length === 0) return Promise.resolve(collect({})(want));
      const waitFor = missing.filter((id) => inflight.has(id)).map((id) => inflight.get(id)!);
      const toQueue = missing.filter((id) => !inflight.has(id));
      let p: Promise<void> = Promise.resolve();
      if (toQueue.length) {
        p = new Promise<void>((resolve) => { waiters.push({ ids: toQueue, done: resolve }); });
        for (const id of toQueue) { queue.add(id); inflight.set(id, p); }
        if (!timer) timer = setTimeout(() => { void flush(); }, batchMs);
      }
      return Promise.all([p, ...waitFor]).then(() => collect({})(want));
    },
  };
}
