// Pure helpers for the card's bottom bar (no React; tested in lib/__tests__/cardFooter.test.ts).
// The AI notice and the disclaimer are not on feed cards: feed-style screens show them once
// in a persistent strip under the card area (D-80, components/shell/FeedNotice.tsx).

// Link-out cards (reserved, not produced in v1): "Category · Delayed 12 h".
export function delayedText(hours: number | null | undefined): string | null {
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? `Delayed ${Math.round(hours)} h` : null;
}

// Rule 7: link-out cards always say "Delayed 12 h" and "via NewsData.io", even when
// the row leaves freshness or attribution empty.
export const LINK_OUT_DELAY_H = 12;
export function linkOutDelay(hours: number | null | undefined): string {
  return delayedText(hours) ?? `Delayed ${LINK_OUT_DELAY_H} h`;
}
export function linkOutCredit(attribution: string | null | undefined): string {
  const a = typeof attribution === 'string' ? attribution.trim() : '';
  return /newsdata\.io/i.test(a) ? a : 'via NewsData.io';
}

// The Share button's link: the card's "/b/<id>" page on this site. https only; on
// a non-https origin (local dev, native) the public site is used instead.
export const PUBLIC_SITE = 'https://element-news.pages.dev';
export function shareUrl(sharePath: string | null | undefined, origin: string | null | undefined, fallback: string = PUBLIC_SITE): string | null {
  if (typeof sharePath !== 'string' || !/^\/b\/[A-Za-z0-9_-]+$/.test(sharePath)) return null;
  const base = typeof origin === 'string' && /^https:\/\/[^\s/]+$/.test(origin) ? origin : fallback;
  if (!/^https:\/\/[^\s/]+$/.test(base)) return null;
  return base + sharePath;
}
