// Duplicate and burst guards, run before any AI call.
// The database enforces the same rules again in api.publish_blurb.
// Inputs: candidate items (URL, tickers, time). Outputs: ok / duplicate_url / ticker_cap decisions.

import { config } from './config.ts';

/** Canonical form for URL comparison: lower-case host, no fragment, no trailing slash. */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

export interface PublishedRef {
  tickers: string[];
  sortAt: Date;
}

export interface Candidate {
  url: string;
  tickers: string[];
  sortAt: Date;
}

export type Decision =
  | { ok: true }
  | { ok: false; reason: 'duplicate_url' }
  | { ok: false; reason: 'ticker_cap'; symbol: string };

/**
 * Decide whether a candidate item may become a card.
 * - same URL seen before -> duplicate
 * - any ticker already has `cap` cards within +-`windowHours` of this item's time -> ticker_cap
 */
function checkCandidate(
  c: Candidate,
  seenUrls: Set<string>,
  published: PublishedRef[],
  cap: number = config.tickerCapPer24h,
  windowHours: number = config.tickerCapWindowHours,
): Decision {
  if (seenUrls.has(normalizeUrl(c.url))) return { ok: false, reason: 'duplicate_url' };
  const windowMs = windowHours * 3600_000;
  for (const sym of c.tickers.map((t) => t.toUpperCase())) {
    const n = published.filter(
      (p) => p.tickers.some((t) => t.toUpperCase() === sym) && Math.abs(p.sortAt.getTime() - c.sortAt.getTime()) < windowMs,
    ).length;
    if (n >= cap) return { ok: false, reason: 'ticker_cap', symbol: sym };
  }
  return { ok: true };
}

/** Small stateful helper for one ingest run: `check` a candidate, then `record` it once published. */
export function createGuard(cap: number = config.tickerCapPer24h, windowHours: number = config.tickerCapWindowHours) {
  const seen = new Set<string>();
  const published: PublishedRef[] = [];
  return {
    check(c: Candidate): Decision {
      return checkCandidate(c, seen, published, cap, windowHours);
    },
    record(c: Candidate): void {
      seen.add(normalizeUrl(c.url));
      published.push({ tickers: c.tickers, sortAt: c.sortAt });
    },
  };
}
