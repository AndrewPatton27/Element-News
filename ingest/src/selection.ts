// Picks WHICH candidates get the run's limited budget (no AI, no network). Pure functions, tested offline.
// Score = importance (the ranking policy, log2) + freshness (half-life) - diversity penalty per pick already
// taken from the same source. A per-source soft cap keeps one source from using the whole budget while
// others still have candidates; when the capped sources run out of candidates, the cap is lifted.

import { config } from './config.ts';
import { importance } from './ranking.ts';
import type { RawItem } from './types.ts';

export interface SelectionConfig {
  weights: { importance: number; freshness: number; diversity: number };
  freshnessHalfLifeHours: number;
  softCapShare: number;
}

/** Score of one item without the diversity term (that one depends on what was already picked). */
export function baseScore(it: RawItem, now: Date, cfg: SelectionConfig = config.selection): number {
  const imp = importance({
    id: it.external_id, kind: 'news', event_type: it.event_type, sort_at: it.published_at,
    sources: [{ name: it.source_name, kind: it.source_kind }], title: it.title,
  });
  const ageH = Math.max(0, (now.getTime() - Date.parse(it.published_at)) / 3_600_000);
  const fresh = Number.isFinite(ageH) ? 0.5 ** (ageH / cfg.freshnessHalfLifeHours) : 0;
  return cfg.weights.importance * Math.log2(Math.max(imp, 1e-9)) + cfg.weights.freshness * fresh;
}

export interface Pickable { source: string; score: number }

/** Per-source soft cap in items: share of the budget, at least 1. */
export function softCap(budget: number, cfg: SelectionConfig = config.selection): number {
  return Math.max(1, Math.ceil(budget * cfg.softCapShare));
}

/**
 * Index of the next candidate to try, or -1 when none are left. Sources under their cap compete first
 * (score minus the diversity penalty); if every remaining candidate belongs to a source at its cap, the cap is lifted.
 */
export function pickNext(cands: readonly Pickable[], spent: ReadonlyMap<string, number>, cap: number, cfg: SelectionConfig = config.selection): number {
  if (!cands.length) return -1;
  const under = cands.map((c, i) => i).filter((i) => (spent.get(cands[i].source) ?? 0) < cap);
  const pool = under.length ? under : cands.map((_, i) => i);
  let best = -1;
  let bestV = -Infinity;
  for (const i of pool) {
    const v = cands[i].score - cfg.weights.diversity * (spent.get(cands[i].source) ?? 0);
    if (v > bestV) { bestV = v; best = i; }       // strict >: ties keep the earlier (fixed-order) candidate
  }
  return best;
}
