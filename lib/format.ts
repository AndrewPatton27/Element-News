// Text formatting for cards and the numbers panel. Pure: no React imports.

import type { BlurbCard, Category, MacroFact } from '../contract/types.ts';

export const HEADLINE_MAX_CHARS = 90;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "just now", "37 min ago", "5 h ago", "3 d ago", then "Oct 3" (or "Oct 3, 2025" in another year).
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  const d = new Date(t);
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}

// The one time label for a card, used by the feed card and its detail sheet so they never
// disagree. Data cards: as_of is the observation date (the numbers panel shows the period),
// so show when the card was published. Every other card shows as_of.
export function cardTime(card: Pick<BlurbCard, 'kind' | 'published_at' | 'as_of'>, now: Date = new Date()): string {
  return relativeTime(card.kind === 'data' ? card.published_at : card.as_of, now);
}

export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

export function clampHeadline(text: string): string {
  return clampText(text, HEADLINE_MAX_CHARS);
}

// Direction is always shown as a glyph AND a word, never by colour alone.
export function directionGlyph(direction: MacroFact['direction']): string {
  if (direction === 'up') return '▲';
  if (direction === 'down') return '▼';
  if (direction === 'flat') return '■';
  return '';
}

export function directionWord(direction: MacroFact['direction']): string {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  if (direction === 'flat') return 'unchanged';
  return '';
}

// "▲ up +0.05 pts", "■ unchanged", or "" when there is no change to show.
export function changeText(fact: Pick<MacroFact, 'change' | 'direction'>): string {
  if (fact.direction === 'flat') return `${directionGlyph('flat')} unchanged`;
  if (!fact.change) return '';
  const glyph = directionGlyph(fact.direction);
  const word = directionWord(fact.direction);
  return [glyph, word, fact.change].filter((p) => p !== '').join(' ');
}

// Screen-reader sentence for one number: "10-yr Treasury 4.12%, up +0.05 pts, as of Oct 16. Source: ..."
export function factA11yLabel(fact: MacroFact): string {
  const parts = [`${fact.label} ${fact.value}`];
  const change = fact.direction === 'flat' ? 'unchanged' : fact.change ? `${directionWord(fact.direction)} ${fact.change}`.trim() : '';
  if (change) parts.push(change);
  parts.push(fact.period ? `for ${fact.period}` : `as of ${shortDate(fact.as_of)}`);
  return `${parts.join(', ')}. Source: ${fact.source_name}`;
}

export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Display names used only when api.categories has not loaded or lacks the slug.
// The API's names always win (they carry the renames: Business, Government, Money).
const CATEGORY_FALLBACK_NAMES: Record<string, string> = {
  markets: 'Business',
  earnings: 'Earnings',
  economy: 'Economy',
  policy: 'Government',
  tech: 'Tech',
  deals: 'Deals',
  energy: 'Energy',
  insider: 'Insider trades',
  'personal-finance': 'Money',
  world: 'World',
  health: 'Health',
  science: 'Science & Space',
  safety: 'Recalls & Safety',
};

export function categoryName(slug: string, categories: Category[] | null | undefined): string {
  const hit = categories?.find((c) => c.slug === slug);
  if (hit) return hit.name;
  if (CATEGORY_FALLBACK_NAMES[slug]) return CATEGORY_FALLBACK_NAMES[slug];
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

const EVENT_LABELS: Record<string, string> = {
  earnings: 'Earnings',
  exec_change: 'Leadership change',
  deal: 'Deal',
  insider: 'Insider filing',
  macro_release: 'Data release',
  fed: 'Federal Reserve',
  world_event: 'World',
  recall: 'Recall',
  health: 'Health',
  science: 'Science',
};

// Unknown event types are allowed by the contract; show nothing rather than a raw code.
export function eventLabel(eventType: string | null): string | null {
  if (!eventType) return null;
  return EVENT_LABELS[eventType] ?? null;
}

// "https://www.federalreserve.gov/x" -> "federalreserve.gov"
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
}
