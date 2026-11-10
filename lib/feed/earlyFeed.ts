// The first requests of a page load are started by a tiny inline script in index.html (added by
// scripts/fix-pages-assets.mjs) before the 1+ MB app bundle has even finished downloading, so the
// data is usually already there when the app first renders (no waterfall: bundle, then data).
// The script stores { [key]: { t, p, n } } on window.__elementEarly. `key` is the request path plus
// body (`/rest/v1/rpc/feed|{...}`); `p` resolves to the parsed JSON or null; `n` is how many
// callers may still take it (the Trending head is read twice at start). A request is taken only for
// the same key, without a reader token (the early requests are anonymous), and only while fresh.
// Anything else (or a failure) falls back to a normal request. No React imports, so node --test can run it.

export interface EarlyEntry {
  t: number;
  p: Promise<unknown>;
  n: number;
}
export type EarlyHolder = { __elementEarly?: Record<string, EarlyEntry> };

export const EARLY_FEED_MAX_AGE_MS = 60_000;

/** Returns the pending early request for `key` when usable, and uses up one of its `n` takes. */
export function takeEarly(holder: EarlyHolder | undefined, key: string, hasToken: boolean, now: number = Date.now()): Promise<unknown> | null {
  const all = holder?.__elementEarly;
  const early = all?.[key];
  if (!all || !early) return null;
  const stale = now - early.t > EARLY_FEED_MAX_AGE_MS;
  if (--early.n <= 0 || stale) delete all[key];
  if (hasToken || stale) return null;
  return early.p;
}
