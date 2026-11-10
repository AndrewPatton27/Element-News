// The one timestamp rule (M9 trust): every surface that shows "when" for a card calls stampLabel,
// so the feed card, the detail/sources sheet and the brief rows never disagree. Pure.
//   'card'  (feed card, brief row): data cards "Data as of Oct 14"; cards whose primary source is a
//           filing "Filed 5 h ago"; every other card the plain relative time of as_of ("5 h ago").
//   'sheet' (detail sheet, Latest tab): "Added 5 h ago", from published_at (when we added it).
// `short` is the phone-width form ("As of Oct 14", "Filed 5 h", "5 h").

import type { BlurbCard } from '../../contract/types.ts';
import { relativeTime, shortDate } from './format.ts';

export type StampContext = 'card' | 'sheet';
export interface Stamp { label: string; short: string }

type StampCard = Pick<BlurbCard, 'kind' | 'published_at' | 'as_of' | 'sources'>;

const noAgo = (s: string) => s.replace(/\s+ago$/, '');

export function stampLabel(card: StampCard, ctx: StampContext, now: Date = new Date()): Stamp {
  if (ctx === 'sheet') {
    const t = relativeTime(card.published_at, now);
    return t ? { label: `Added ${t}`, short: `Added ${noAgo(t)}` } : { label: '', short: '' };
  }
  if (card.kind === 'data') {
    if (Number.isNaN(Date.parse(card.as_of))) {
      const t = relativeTime(card.published_at, now);
      return { label: t, short: noAgo(t) };
    }
    const d = shortDate(card.as_of);
    return { label: `Data as of ${d}`, short: `As of ${d}` };
  }
  const t = relativeTime(card.as_of, now);
  if (!t) return { label: '', short: '' };
  const primary = card.sources.find((s) => s.is_primary) ?? card.sources[0];
  if (primary?.kind === 'filing') return { label: `Filed ${t}`, short: `Filed ${noAgo(t)}` };
  return { label: t, short: noAgo(t) };
}
