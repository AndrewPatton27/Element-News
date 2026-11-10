// What a card shows between its headline and its bottom bar, and what the bottom bar
// says about the source. Pure: no React imports, so node --test runs it
// (lib/__tests__/cardBody.test.ts). Used by the feed card, the search / Following
// tiles, the brief rows and the detail sheet header, so they all match.
//
// Body rule: the card's own persisted key points as 2-4 short bullets; with fewer than
// two key points, the card's 2-3 sentence summary instead. Nothing is ever written
// here: every string comes from the card row. Link-out cards get no body (rule 7).

import type { BlurbCard } from '../../contract/types.ts';
import { cardDetail } from './detail.ts';
import { stampLabel } from './timestamp.ts';
import { primarySource, sourcesText } from './labels.ts';

export const TAKEAWAYS_MIN = 2;
export const TAKEAWAYS_MAX = 4;

export type CardBodyContent =
  | { kind: 'points'; points: string[] }
  | { kind: 'summary'; text: string }
  | { kind: 'none' };

// max: how many bullets fit (clamped to 1..4). A card with one key point and no summary
// shows that one point rather than nothing.
export function cardTakeaways(card: Pick<BlurbCard, 'kind' | 'detail' | 'body'>, max: number = TAKEAWAYS_MAX): CardBodyContent {
  if (card.kind === 'link_out') return { kind: 'none' };
  const limit = Math.max(1, Math.min(TAKEAWAYS_MAX, Math.floor(Number.isFinite(max) ? max : TAKEAWAYS_MAX)));
  const points = cardDetail(card)?.key_points ?? [];
  const body = typeof card.body === 'string' ? card.body.trim() : '';
  if (points.length >= TAKEAWAYS_MIN) return { kind: 'points', points: points.slice(0, limit) };
  if (body) return { kind: 'summary', text: body };
  if (points.length === 1) return { kind: 'points', points };
  return { kind: 'none' };
}

// "5 h ago" -> "5 h", "just now" stays: the short form for phone-width bars.
export function shortTime(label: string): string {
  return label.replace(/\s+ago$/, '');
}

// Well-known agencies get their usual short name in the bar, so the one-line bar shows a
// readable name instead of "Federal Res…". Only exact matches; anything else keeps its
// full name (and truncates). The full name stays in the accessible name and the sources sheet.
const SHORT_NAMES: Record<string, string> = {
  'Federal Reserve Board': 'Fed',
  'Board of Governors of the Federal Reserve System': 'Fed',
  'U.S. Bureau of Labor Statistics': 'BLS',
  'Bureau of Labor Statistics': 'BLS',
  'U.S. Energy Information Administration': 'EIA',
  'U.S. Geological Survey': 'USGS',
  'U.S. Consumer Product Safety Commission': 'CPSC',
  'U.S. Census Bureau': 'Census Bureau',
  'U.S. Bureau of Economic Analysis': 'BEA',
  'U.S. Department of the Treasury': 'Treasury',
  'U.S. Food and Drug Administration': 'FDA',
  'National Highway Traffic Safety Administration': 'NHTSA',
};
export function shortSourceName(name: string): string {
  return SHORT_NAMES[name.trim()] ?? name;
}
// Wide bars add the document label only after a short name ("SEC · Form 8-K"), so the
// agency name itself never has to truncate.
export const WIDE_DOC_LABEL_MAX_NAME = 16;

export interface CardBarMeta {
  name: string; // primary outlet or agency, e.g. "NASA", "SEC"
  shortName: string; // the bar's label: "Fed", "BLS" (full name when there is no known short one)
  docLabel: string | null; // "News release", "Form 8-K" (wide bars only)
  time: string; // "1 d ago" (or "Added 1 d ago" on the Latest tab)
  timeShort: string; // "1 d" for phone-width bars
  count: number; // distinct sources, >= 1
  a11y: string; // starts with "Sources:" (the e2e test and screen readers rely on it)
  a11yLink: string; // for bars whose source opens the original page directly (Brief rows)
}

// The bottom bar's source block. null only for a card with no sources at all, which
// the parser already rejects (every card has >= 1 source, rule 5).
export function cardBarMeta(
  card: Pick<BlurbCard, 'kind' | 'sources' | 'source_count' | 'published_at' | 'as_of'>,
  opts: { timeLabel?: 'added'; now?: Date } = {},
): CardBarMeta | null {
  const src = primarySource(card);
  if (!src) return null;
  const stamp = stampLabel(card, opts.timeLabel === 'added' ? 'sheet' : 'card', opts.now);
  const used = stamp.label ? stamp : stampLabel(card, 'card', opts.now);
  const time = used.label;
  const count = Math.max(1, card.source_count || 0, card.sources.length);
  const when = !time ? '' : /^(Filed|Data as of) /.test(time) ? ` ${time}.` : ` Published ${time.replace(/^Added /, '')}.`;
  return {
    name: src.name,
    shortName: shortSourceName(src.name),
    docLabel: src.doc_label && src.doc_label.trim() !== '' ? src.doc_label : null,
    time,
    timeShort: used.short,
    count,
    a11y: `Sources: ${sourcesText(card)}.${when} Opens the list with links to the originals.`,
    a11yLink: `Source: ${src.name}${count > 1 ? `, ${count} sources` : ''}.${when} Opens the original.`,
  };
}
