// The first feed page is requested by a tiny inline script in index.html (added by
// scripts/fix-pages-assets.mjs) before the 1+ MB app bundle has even finished downloading.
// The script stores { body, t, p } on window.__elementEarly; p resolves to the parsed JSON or null.
// api.feed takes it once, only for the same request body, only for signed-out readers,
// and only while it is fresh. Anything else (or a failure) falls back to a normal request.
// No React imports, so node --test can run it.

export interface EarlyFeed {
  body: string;
  t: number;
  p: Promise<unknown>;
}

export const EARLY_FEED_MAX_AGE_MS = 60_000;

/** Returns the pending early request when it matches, and removes it so it is used once. */
export function takeEarlyFeed(holder: { __elementEarly?: EarlyFeed } | undefined, body: string | undefined, hasToken: boolean, now: number = Date.now()): Promise<unknown> | null {
  const early = holder?.__elementEarly;
  if (!holder || !early) return null;
  delete holder.__elementEarly;
  if (hasToken || early.body !== body || now - early.t > EARLY_FEED_MAX_AGE_MS) return null;
  return early.p;
}
