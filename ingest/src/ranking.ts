// TypeScript mirror of the ranking SQL (core.refresh_rank + api.feed ordering).
// Used only by tests, to check the formula and the fixtures; the database is
// the source of truth for real ranking.
// Inputs: card-like rows (kind, event_type, sort_at, sources). Outputs: scores, sorted lists, pages.

import { config } from './config.ts';
import { isAirworthinessDirective } from './sources/fedreg.ts';

export const RANK_DEFAULTS = {
  halfLifeHours: 8,
  coverageK: 0.25,
  coverageCap: 20,
  authority: { government: 1.25, filing: 1.0, news: 0.8 } as Record<string, number>,
  eventWeights: {
    fed: 8, macro_release: 8, earnings: 5, deal: 4, exec_change: 3, insider: 2, default: 2,
    world_event: 6, recall: 5, science: 3,          // broad topics (20261017020000_broad_topics.sql)
  } as Record<string, number>,
};

export interface RankInput {
  id: string;
  kind: string;
  event_type: string | null;
  sort_at: string;               // ISO
  sources: { name: string; kind: string }[];
  title?: string | null;         // title of the source document (optional); "Airworthiness Directives; ..." lowers importance
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Importance = event weight x source authority x (1 + k * ln(distinct sources, capped)). Data cards weigh as
 * macro_release. An FAA airworthiness directive (source title says so) is capped at
 * config.ranking.airworthinessImportance (1.5) so a run of near-identical aircraft fix orders stops leading Trending.
 */
export function importance(c: RankInput, p = RANK_DEFAULTS): number {
  const et = c.kind === 'data' ? 'macro_release' : c.event_type;
  const w = (et && p.eventWeights[et]) || p.eventWeights.default;
  const n = Math.max(new Set(c.sources.map((s) => s.name)).size, 1);
  const auth = c.sources.length
    ? Math.max(...c.sources.map((s) => p.authority[s.kind] ?? p.authority.news))
    : p.authority.filing;
  const base = w * auth * (1 + p.coverageK * Math.log(Math.min(n, p.coverageCap)));
  return isAirworthinessDirective(c.title) ? Math.min(base, config.ranking.airworthinessImportance) : base;
}

/** Rank score = hours since epoch + halfLife * log2(importance), rounded to 6 decimals (importance halves every halfLife hours). */
export function rankScore(c: RankInput, p = RANK_DEFAULTS): number {
  const hours = Date.parse(c.sort_at) / 3_600_000;
  return round(hours + p.halfLifeHours * Math.log2(importance(c, p)), 6);
}

/** 'top' order: rank_score desc, then id desc (same as the SQL). */
export function sortTop<T extends RankInput>(cards: T[], p = RANK_DEFAULTS): T[] {
  return [...cards].sort((a, b) => rankScore(b, p) - rankScore(a, p) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 'latest' order: sort_at desc, then id desc. */
export function sortLatest<T extends RankInput>(cards: T[]): T[] {
  return [...cards].sort((a, b) => Date.parse(b.sort_at) - Date.parse(a.sort_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Keyset paging for 'top', like api.feed: cursor '<rank_score with 6 decimals>|<id>',
 * rows strictly below the cursor, limit clamped to 10..30.
 */
export function pageTop<T extends RankInput>(cards: T[], cursor: string | null, limit = 20, p = RANK_DEFAULTS): { items: T[]; next_cursor: string | null } {
  const lim = Math.min(Math.max(limit, 10), 30);
  let below = sortTop(cards, p);
  if (cursor) {
    const [k, id] = cursor.split('|');
    const key = Number(k);
    below = below.filter((c) => {
      const s = rankScore(c, p);
      return s < key || (s === key && c.id < id);
    });
  }
  const items = below.slice(0, lim);
  const last = items[items.length - 1];
  const next_cursor = below.length > lim ? `${rankScore(last, p).toFixed(6)}|${last.id}` : null;
  return { items, next_cursor };
}
