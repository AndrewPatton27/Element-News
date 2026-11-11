// The in-depth summary shown when a card is opened (BlurbCard.detail). Pure: no React.
// Older servers omit the field and some cards have none; malformed data is
// cleaned up here rather than breaking the card.

import type { BlurbCard, CardDetail } from '../../contract/types.ts';

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

// Key points for the "More detail" sheet without the lines the sheet already shows elsewhere (D-212): a "Source: ..."
// bullet repeats the source line and the Sources list, and on a data card a bullet that restates a number from the
// numbers panel repeats the panel. Never returns an empty list when the card had points (the originals minus
// "Source:" lines are the fallback), so the sheet keeps its Key points box.
export function detailKeyPoints(card: Pick<BlurbCard, 'detail' | 'kind' | 'macro'>): string[] {
  const all = cardDetail(card)?.key_points ?? [];
  const noSource = all.filter((k) => !/^sources?\s*:/i.test(k));
  const values = card.kind === 'data' ? (card.macro ?? []).map((f) => f.value).filter((v) => v.length >= 3) : [];
  if (!values.length) return noSource;
  const fresh = noSource.filter((k) => !values.some((v) => k.includes(v)));
  return fresh.length ? fresh : noSource;
}
