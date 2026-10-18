// The in-depth summary shown when a card is opened (BlurbCard.detail). Pure: no React.
// Older servers omit the field and some cards have none; malformed data is
// cleaned up here rather than breaking the card.

import type { BlurbCard, CardDetail } from '../contract/types.ts';

export const NO_DETAIL_MESSAGE = 'More detail isn’t available for this card yet.';
export const OPEN_DETAIL_HINT = 'Opens more detail';

const cleanList = (x: unknown): string[] =>
  Array.isArray(x)
    ? x
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v !== '')
    : [];

// The card's detail with empty or non-string entries dropped; null when nothing is left.
export function cardDetail(card: Pick<BlurbCard, 'detail'>): CardDetail | null {
  const d = card.detail as unknown;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  const paragraphs = cleanList(o.paragraphs);
  const key_points = cleanList(o.key_points);
  return paragraphs.length || key_points.length ? { paragraphs, key_points } : null;
}

// Paragraphs to show: the detail's, or the card's own summary as a fallback.
export function detailParagraphs(card: Pick<BlurbCard, 'detail' | 'body'>): { paragraphs: string[]; fallback: boolean } {
  const d = cardDetail(card);
  if (d && d.paragraphs.length) return { paragraphs: d.paragraphs, fallback: false };
  return { paragraphs: card.body ? [card.body] : [], fallback: !d };
}
