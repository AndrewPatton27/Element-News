// Small keys the device ranker uses to say "this card is the same story / same kind of card as that one".
// Pure; no I/O. Used by localRank (dislike learning), forYouRank (series family cap, twin removal) and
// lib/storage/localPrefs.ts (what a reaction remembers about its card, on this device only).

import type { BlurbCard } from '../../contract/types.ts';

type KeyCard = Partial<Pick<BlurbCard, 'id' | 'headline' | 'macro' | 'tickers' | 'story_link'>> & { dedupe_key?: string | null };

/** Lower-case words only, 80 characters: two cards with the same wording compare equal. */
export function normHeadline(h: string | null | undefined): string {
  return (h ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Treasury yields, the fed funds rate and bill rates all count as one "rates" family. */
const RATES_SERIES = /^(DGS\d|DTB|DFF|DFEDTAR|SOFR|T\d+Y)/i;
const RATES_HEADLINE = /\b\d+-(year|month|week)\s+treasury\b|\btreasury\s+(yield|note|bill)/i;
const DATE_TAIL = /(?:[:/_-](?:\d{4}[-/]?\d{0,2}[-/]?\d{0,2}|\d+))$/;

/**
 * Series family of a card, '' when it has none. Data cards: the series ("g:rates" for every Treasury yield,
 * otherwise "s:<series id>"). Other cards: the dedupe key without its trailing date or number.
 * Older readings of one daily series share a family, so the family cap can thin them out.
 */
export function cardFamily(c: KeyCard): string {
  const id = c.macro?.[0]?.series_id;
  if (id) return RATES_SERIES.test(id) ? 'g:rates' : `s:${id}`;
  if (c.headline && RATES_HEADLINE.test(c.headline)) return 'g:rates';
  const key = c.dedupe_key;
  return key ? `k:${key.replace(DATE_TAIL, '')}` : '';
}

export const tickerList = (c: KeyCard): string[] => (c.tickers ?? []).map((t) => t.symbol.toUpperCase()).filter(Boolean);

/** What a stored reaction knows about its card (all optional: reactions made before this field existed have none). */
export interface ReactionKeys { head?: string; key?: string; tickers?: string[]; family?: string }

export function reactionKeys(c: KeyCard): ReactionKeys {
  const out: ReactionKeys = {};
  const head = normHeadline(c.headline);
  if (head) out.head = head;
  if (c.dedupe_key) out.key = c.dedupe_key;
  const tickers = tickerList(c).slice(0, 5);
  if (tickers.length) out.tickers = tickers;
  const family = cardFamily(c);
  if (family) out.family = family;
  return out;
}

interface DislikeRow extends ReactionKeys { r: string }

/** Ids, dedupe keys, headlines and linked ids of everything the reader disliked. Build once per ranking call. */
export function dislikeIndex(reactions: Record<string, DislikeRow>) {
  const ids = new Set<string>(), keys = new Set<string>(), heads = new Set<string>();
  for (const [id, r] of Object.entries(reactions)) {
    if (r.r !== 'dislike') continue;
    ids.add(id);
    if (r.key) keys.add(r.key);
    if (r.head && r.head.length >= 12) heads.add(r.head);
  }
  /** The disliked card itself, or a twin: same dedupe key, same headline, or an update linked to it. */
  return (c: KeyCard): boolean =>
    (!!c.id && ids.has(c.id)) || (!!c.dedupe_key && keys.has(c.dedupe_key)) || heads.has(normHeadline(c.headline)) || (!!c.story_link?.related_id && ids.has(c.story_link.related_id));
}
