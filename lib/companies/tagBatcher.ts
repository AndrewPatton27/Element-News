// Collects the card ids that need company tags during one short window and asks for them in one
// request (api.card_companies, at most 50 ids). Answers are cached for the session; a failed request
// caches "no tags" for those ids for FAILED_TAGS_TTL_MS (60 s) only, so a broken network never loops
// but one bad request does not hide the "About:" chips for the rest of the session. Pure: no React
// (tested in node).

import type { CardCompany } from './companyLogic.ts';

export interface TagBatcher {
  /** Cached tags, or undefined while unknown (then call request). */
  get(id: string): CardCompany[] | undefined;
  /** Queue an id; the callback runs once its tags (maybe []) are known. Returns an unsubscribe. */
  request(id: string, done: (tags: CardCompany[]) => void): () => void;
}

/** How long a failed request's "no tags" answer is kept before the ids are asked for again. */
export const FAILED_TAGS_TTL_MS = 60_000;

export function createTagBatcher(
  fetchTags: (ids: string[]) => Promise<Record<string, CardCompany[]>>,
  opts: { windowMs?: number; maxIds?: number; schedule?: (fn: () => void, ms: number) => unknown; now?: () => number; failedTtlMs?: number } = {},
): TagBatcher {
  const windowMs = opts.windowMs ?? 25;
  const maxIds = opts.maxIds ?? 50;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  const failedTtlMs = opts.failedTtlMs ?? FAILED_TAGS_TTL_MS;
  const cache = new Map<string, CardCompany[]>();
  const expires = new Map<string, number>(); // only failed entries expire
  const waiting = new Map<string, Set<(tags: CardCompany[]) => void>>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  let timer = false;

  const cached = (id: string): CardCompany[] | undefined => {
    const until = expires.get(id);
    if (until !== undefined && now() >= until) { cache.delete(id); expires.delete(id); return undefined; }
    return cache.get(id);
  };

  const settle = (id: string, tags: CardCompany[], failed = false) => {
    cache.set(id, tags);
    if (failed) expires.set(id, now() + failedTtlMs);
    else expires.delete(id);
    inFlight.delete(id);
    const subs = waiting.get(id);
    waiting.delete(id);
    subs?.forEach((fn) => fn(tags));
  };

  const flush = () => {
    timer = false;
    const ids = [...queued].slice(0, maxIds);
    ids.forEach((id) => { queued.delete(id); inFlight.add(id); });
    if (queued.size) { timer = true; schedule(flush, windowMs); }
    if (!ids.length) return;
    fetchTags(ids).then(
      (byId) => ids.forEach((id) => settle(id, byId[id] ?? [])),
      () => ids.forEach((id) => settle(id, [], true)),
    );
  };

  return {
    get: (id) => cached(id),
    request(id, done) {
      const hit = cached(id);
      if (hit) { done(hit); return () => undefined; }
      const subs = waiting.get(id) ?? new Set();
      subs.add(done);
      waiting.set(id, subs);
      if (!inFlight.has(id)) queued.add(id);
      if (!timer && queued.size) { timer = true; schedule(flush, windowMs); }
      return () => { subs.delete(done); };
    },
  };
}
