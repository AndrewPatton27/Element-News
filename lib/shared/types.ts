// Runtime checks for data coming from the API. The shapes themselves live in
// contract/types.ts and are imported type-only; this file adds only guards.
// Bad rows are skipped, never allowed to crash the feed.

import type { AppConfig, BlurbCard, BriefMarkets, BriefSubscribeResult, BriefSubscriptionInput, BriefSummary, BriefTokenResult, Category, FeedPage, MacroFact, NumberTrend, RequiredNotice, Source } from '../../contract/types.ts';
import { isRenderableKind } from './labels.ts';

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// Only https:// is accepted — this matches the database CHECK
// (blurb_sources.url like 'https://%') and the "every card links to its source"
// rule, so a non-https (cleartext) link can never reach Linking.openURL.
export function isHttpUrl(x: unknown): x is string {
  return isStr(x) && /^https:\/\/[^\s]+$/i.test(x);
}

export function isSource(x: unknown): x is Source {
  return isObj(x) && isStr(x.name) && x.name !== '' && isHttpUrl(x.url) && isStr(x.published_at) && typeof x.is_primary === 'boolean';
}

export function isMacroFact(x: unknown): x is MacroFact {
  return (
    isObj(x) &&
    isStr(x.series_id) &&
    isStr(x.label) &&
    isStr(x.value) &&
    isStrOrNull(x.change) &&
    (x.direction === null || x.direction === 'up' || x.direction === 'down' || x.direction === 'flat') &&
    isStr(x.as_of) &&
    isStr(x.source_name) &&
    isStr(x.source_short) &&
    isHttpUrl(x.source_url)
  );
}

// A card is shown only if it is a known kind, has a headline and at least one
// source with a working link (project rule: every card links to its source).
export function isBlurbCard(x: unknown): x is BlurbCard {
  if (!isObj(x)) return false;
  if (!isStr(x.id) || x.id === '' || !isRenderableKind(x.kind)) return false;
  if (!isStr(x.headline) || x.headline.trim() === '' || !isStrOrNull(x.body)) return false;
  if (!isStr(x.category) || !isStr(x.as_of) || !isStr(x.sort_at)) return false;
  if (!Array.isArray(x.sources) || x.sources.length === 0 || !x.sources.every(isSource)) return false;
  if (!isNum(x.source_count)) return false;
  if (!Array.isArray(x.tickers) || !x.tickers.every((ticker) => isObj(ticker) && isStr(ticker.symbol) && ticker.symbol.trim() !== '') || !Array.isArray(x.macro)) return false;
  if (!isObj(x.ai) || typeof x.ai.generated !== 'boolean') return false;
  if (x.story_link !== undefined && !(isObj(x.story_link) && ['update','angle','related'].includes(String(x.story_link.kind)) && isStr(x.story_link.related_id) && isStr(x.story_link.related_headline))) return false;
  if (x.kind === 'data' && (x.macro.length === 0 || !x.macro.every(isMacroFact))) return false;
  return true;
}

// Keeps only valid, renderable cards. next_cursor must be a string or null.
// `page_id` (signed-in pages only, added by the ML shadow logging migration) is kept when it is a
// non-empty string and ignored otherwise; the key is absent when the server sends none.
export function parseFeedPage(x: unknown): FeedPage & { page_id?: string } {
  if (!isObj(x) || !Array.isArray(x.items)) throw new Error('Feed response has no items array.');
  const next = isStr(x.next_cursor) && x.next_cursor !== '' ? x.next_cursor : null;
  const page: FeedPage & { page_id?: string } = { items: x.items.filter(isBlurbCard), next_cursor: next };
  if (isStr(x.page_id) && x.page_id !== '') page.page_id = x.page_id;
  return page;
}

export function parseMacroFacts(x: unknown): MacroFact[] {
  if (!Array.isArray(x)) throw new Error('numbers_to_know response is not a list.');
  return x.filter(isMacroFact).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

export function parseCategories(x: unknown): Category[] {
  if (!Array.isArray(x)) throw new Error('categories response is not a list.');
  return x.filter((c): c is Category => isObj(c) && isStr(c.slug) && isStr(c.name)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

function isNotice(x: unknown): x is RequiredNotice {
  return isObj(x) && isStr(x.key) && isStr(x.text) && isStrOrNull(x.url) && Array.isArray(x.placements);
}

// Accepts the single row or the one-row array PostgREST returns for a view.
export function parseAppConfig(x: unknown): AppConfig {
  const row = Array.isArray(x) ? x[0] : x;
  if (!isObj(row) || !isStr(row.disclaimer) || !isStr(row.ai_notice)) {
    throw new Error('app_config response is missing disclaimer or ai_notice.');
  }
  return {
    disclaimer: row.disclaimer,
    ai_notice: row.ai_notice,
    required_notices: Array.isArray(row.required_notices) ? row.required_notices.filter(isNotice) : [],
    min_supported_app_version: isStr(row.min_supported_app_version) ? row.min_supported_app_version : '0.0.0',
    quotes_enabled: row.quotes_enabled === true,
    linkout_cards: row.linkout_cards === true,
  };
}

export function isNumberTrend(x: unknown): x is NumberTrend {
  return (
    isObj(x) &&
    isStr(x.key) &&
    isStr(x.name) &&
    isStr(x.value) &&
    isStr(x.change) &&
    (x.direction === 'up' || x.direction === 'down' || x.direction === 'flat') &&
    isStr(x.source) &&
    Array.isArray(x.points) &&
    x.points.every((p) => typeof p === 'number' && Number.isFinite(p))
  );
}

/** Bad rows are skipped; points are cut to the last 12. */
export function parseNumberTrends(x: unknown): NumberTrend[] {
  if (!Array.isArray(x)) throw new Error('number_trends response is not a list.');
  return x.filter(isNumberTrend).map((t) => ({ ...t, points: t.points.slice(-12) }));
}

/** Brief summary from the server; anything malformed or empty becomes null (the box is hidden). */
export function parseBriefSummary(x: unknown): BriefSummary | null {
  if (!isObj(x) || !isStr(x.text) || x.text.trim() === '') return null;
  return { text: x.text, generated_at: isStr(x.generated_at) ? x.generated_at : '', model: isStr(x.model) ? x.model : '' };
}

/** Markets section; bad cards/numbers are skipped. Missing = empty (the section is hidden). */
export function parseBriefMarkets(x: unknown): BriefMarkets {
  if (!isObj(x)) return { cards: [], numbers: [], total: 0 };
  const cards = Array.isArray(x.cards) ? x.cards.filter(isBlurbCard).slice(0, 6) : [];
  const numbers = Array.isArray(x.numbers) ? x.numbers.filter(isMacroFact) : [];
  return { cards, numbers, total: isNum(x.total) ? Math.max(x.total, cards.length) : cards.length };
}

// Same checks as api.subscribe_brief: <= 254 chars, simple a@b.c pattern, lowercased.
export function normalizeBriefEmail(email: unknown): string | null {
  if (!isStr(email)) return null;
  const e = email.trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function isValidBriefInput(i: unknown): i is BriefSubscriptionInput {
  return isObj(i) && (i.kind === 'daily' || i.kind === 'weekly' || i.kind === 'both') && Number.isInteger(i.hour) && (i.hour as number) >= 0 && (i.hour as number) <= 23 && isStr(i.tz) && i.tz.length > 0 && i.tz.length <= 64;
}

const SUBSCRIBE_STATUSES = new Set(['pending', 'invalid', 'limited', 'unavailable']);
export function parseSubscribeResult(x: unknown): BriefSubscribeResult {
  if (!isObj(x) || !isStr(x.status) || !SUBSCRIBE_STATUSES.has(x.status)) return { ok: false, status: 'unavailable' };
  return { ok: x.ok === true && x.status === 'pending', status: x.status as BriefSubscribeResult['status'] };
}

export function parseTokenResult(x: unknown): BriefTokenResult {
  return isObj(x) && x.ok === true ? { ok: true } : { ok: false };
}
