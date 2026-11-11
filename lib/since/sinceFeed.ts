// Shared by the feed's "since" pill and the /since page so both show the same number (R-4xx): one loader that reads
// the latest feed page by page until the window is covered, and one filter on top. Pure: the feed call is injected.

import type { BlurbCard } from '../../contract/types.ts';
import { cardsSince, sinceLabel } from './sinceLogic.ts';

export const SINCE_MAX_PAGES = 4;

type FeedPage = { items: BlurbCard[]; next_cursor: string | null };
export type FeedFn = (p: { mode: 'latest'; category: null; cursor: string | null; limit: number }) => Promise<FeedPage>;

/** Reads the latest feed until the oldest card is older than `from` (or the cap is hit). */
export async function loadSinceRaw(feed: FeedFn, from: number): Promise<BlurbCard[]> {
  let cursor: string | null = null;
  const all: BlurbCard[] = [];
  for (let i = 0; i < SINCE_MAX_PAGES; i++) {
    const page = await feed({ mode: 'latest', category: null, cursor, limit: 30 });
    all.push(...page.items);
    cursor = page.next_cursor;
    const oldest = page.items[page.items.length - 1];
    if (!cursor || !oldest || (Date.parse(oldest.published_at) || 0) <= from) break;
  }
  return all;
}

/** The cards both surfaces show: the reader's own filters first, then only those after `from`, macro first. */
export function sinceCards(raw: BlurbCard[], from: number, visible: (cards: BlurbCard[]) => BlurbCard[]): BlurbCard[] {
  return cardsSince(visible(raw), from);
}

/**
 * Pill text. A first visit has no earlier visit to count from, so it says the window ("in the last 24 hours");
 * a returning reader sees "since your last visit". The count is the one the /since page shows.
 */
export function sincePillText(count: number, prev: number | null, from: number, now: number = Date.now()): string {
  const when = prev === null ? `in ${sinceLabel(from, now)}` : 'since your last visit';
  return `${count} new ${when} · See what changed →`;
}
