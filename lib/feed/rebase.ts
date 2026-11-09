// Sample fixtures carry fixed dates, so a time-windowed view (the brief's 24 h window, "2 h ago"
// labels) would go empty or stale as the calendar moves on. rebaseCards shifts every timestamp by
// one offset so the newest card is `freshestAgoMs` old. Relative order and gaps are unchanged.

import type { BlurbCard } from '../../contract/types.ts';

const HOUR = 3_600_000;

function shift(iso: string | null | undefined, by: number): string | null | undefined {
  if (typeof iso !== 'string') return iso;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + by).toISOString();
}

export function rebaseCards(cards: BlurbCard[], now: number = Date.now(), freshestAgoMs: number = HOUR): BlurbCard[] {
  const times = cards.map((c) => Date.parse(c.sort_at)).filter((t) => !Number.isNaN(t));
  if (!times.length) return cards;
  const by = now - freshestAgoMs - Math.max(...times);
  return cards.map((c) => ({
    ...c,
    as_of: shift(c.as_of, by) as string,
    published_at: shift(c.published_at, by) as string,
    sort_at: shift(c.sort_at, by) as string,
    updated_at: shift(c.updated_at, by) as string | null,
    sources: c.sources.map((s) => ({ ...s, published_at: shift(s.published_at, by) as string })),
  }));
}
