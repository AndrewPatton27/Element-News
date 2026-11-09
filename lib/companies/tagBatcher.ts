// Collects the card ids that need company tags during one short window and asks for them in one
// request (api.card_companies, at most 50 ids). Answers are cached for the session; a failed request
// caches "no tags" for those ids so a broken network never loops. Pure: no React (tested in node).

import type { CardCompany } from './companyLogic.ts';

export interface TagBatcher {
  /** Cached tags, or undefined while unknown (then call request). */
  get(id: string): CardCompany[] | undefined;
  /** Queue an id; the callback runs once its tags (maybe []) are known. Returns an unsubscribe. */
  request(id: string, done: (tags: CardCompany[]) => void): () => void;
}

export function createTagBatcher(
  fetchTags: (ids: string[]) => Promise<Record<string, CardCompany[]>>,
  opts: { windowMs?: number; maxIds?: number; schedule?: (fn: () => void, ms: number) => unknown } = {},
): TagBatcher {
  const windowMs = opts.windowMs ?? 25;
  const maxIds = opts.maxIds ?? 50;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cache = new Map<string, CardCompany[]>();
  const waiting = new Map<string, Set<(tags: CardCompany[]) => void>>();
  const queued = new Set<string>();
  const inFlight = new Set<string>();
  let timer = false;

  const settle = (id: string, tags: CardCompany[]) => {
    cache.set(id, tags);
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
      () => ids.forEach((id) => settle(id, [])),
    );
  };

  return {
    get: (id) => cache.get(id),
    request(id, done) {
      const hit = cache.get(id);
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
