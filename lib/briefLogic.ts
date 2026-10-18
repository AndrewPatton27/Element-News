// Pure rules for the Brief screen (daily and weekly). No React imports, so node --test
// runs it. The screen loads api.dailyBrief() / api.weeklyBrief(); this file decides what
// to show from the result: hidden topics and sources, no card twice, the "Generated"
// line, the date labels, the one-line teaser and the footer wording.

import type { AppConfig, BlurbCard, Brief, BriefKind, BriefMarkets, BriefSubscribeStatus, BriefSummary, Category, MacroFact, NumberTrend } from '../contract/types.ts';
import { categoryName, clampText, relativeTime } from './format.ts';
import { cardLabels, cardNotices, disclaimerText, primarySource, shareAlikeCredit, type ShareAlikeCredit } from './labels.ts';
import type { KeyValueStore } from './storage.ts';
import { isHttpUrl } from './types.ts';

export type BriefMode = 'daily' | 'weekly';

/** A brief as the screen holds it. movers is only filled for the weekly brief. */
export interface BriefData extends Omit<Brief, 'summary' | 'markets'> {
  movers: NumberTrend[];
  summary: BriefSummary | null;
  markets: BriefMarkets | null;
}

export const BRIEF_MODES: { mode: BriefMode; label: string }[] = [
  { mode: 'daily', label: 'Daily brief' },
  { mode: 'weekly', label: 'Weekly brief' },
];

export interface BriefSectionView {
  category: string;
  title: string;
  cards: BlurbCard[];
  slug: string; // category slug the feed filter understands
  total: number; // eligible stories in the window (>= cards.length)
}

export interface BriefView {
  headlines: BlurbCard[];
  sections: BriefSectionView[];
  numbers: MacroFact[];
  movers: NumberTrend[];
  summary: BriefSummary | null;
  marketCards: BlurbCard[];
  marketNumbers: MacroFact[];
  marketsTotal: number;
}

// ---- Normalising what the API returned ----

/** Fills the optional parts so the screen can read every field without checks. */
export function toBriefData(raw: Brief & { movers?: NumberTrend[] }): BriefData {
  const m = raw.markets;
  const markets: BriefMarkets | null =
    m && typeof m === 'object'
      ? { cards: Array.isArray(m.cards) ? m.cards : [], numbers: Array.isArray(m.numbers) ? m.numbers : [], total: typeof m.total === 'number' ? m.total : 0 }
      : null;
  const s = raw.summary;
  const summary = s && typeof s.text === 'string' && s.text.trim() !== '' ? s : null;
  return {
    summary,
    markets,
    generated_at: raw.generated_at,
    window_hours: raw.window_hours,
    headline_cards: raw.headline_cards ?? [],
    sections: raw.sections ?? [],
    numbers: raw.numbers ?? [],
    movers: Array.isArray(raw.movers) ? raw.movers : [],
  };
}

// The client returns an empty brief stamped with the epoch when the RPC is not live.
function hasRealTimestamp(iso: string): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t > Date.UTC(2000, 0, 1);
}

// ---- What is shown ----

/** Section heading: the server's label when it is a real name, else the category name. */
export function sectionTitle(section: { category: string; label: string }, categories: Category[] | null | undefined): string {
  const label = (section.label ?? '').trim();
  if (label !== '' && label.toLowerCase() !== section.category.toLowerCase()) return label;
  return categoryName(section.category, categories);
}

/**
 * Applies the reader's hidden topics / sources (`visible`, the same filter the feed uses),
 * keeps a card out of the sections when it is already a headline, drops empty sections
 * and ignores a card whose kind the app cannot draw (`canShow`).
 */
export function briefView(
  data: BriefData,
  categories: Category[] | null | undefined,
  visible: (cards: BlurbCard[]) => BlurbCard[] = (c) => c,
  canShow: (card: BlurbCard) => boolean = () => true,
): BriefView {
  const seen = new Set<string>();
  const take = (cards: BlurbCard[]): BlurbCard[] =>
    visible(cards.filter(canShow)).filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  const headlines = take(data.headline_cards);
  const marketCards = take(data.markets?.cards ?? []);
  const sections = data.sections
    .map((s) => {
      const cards = take(s.cards);
      return { category: s.category, title: sectionTitle(s, categories), cards, slug: s.slug ?? s.category, total: Math.max(s.total ?? 0, cards.length) };
    })
    .filter((s) => s.cards.length > 0);
  const marketNumbers = data.markets?.numbers ?? [];
  return {
    headlines,
    sections,
    numbers: data.numbers,
    movers: data.movers,
    summary: data.summary,
    marketCards,
    marketNumbers,
    marketsTotal: Math.max(data.markets?.total ?? 0, marketCards.length),
  };
}

export function briefIsEmpty(view: BriefView): boolean {
  return (
    view.headlines.length === 0 &&
    view.sections.length === 0 &&
    view.numbers.length === 0 &&
    view.movers.length === 0 &&
    view.marketCards.length === 0 &&
    view.marketNumbers.length === 0 &&
    view.summary === null
  );
}

/** Every card the brief shows, headlines first. Used for the AI label. */
export function briefCards(view: BriefView): BlurbCard[] {
  return [...view.headlines, ...view.marketCards, ...view.sections.flatMap((s) => s.cards)];
}

// ---- Depth: first 3 per topic, "Show more", "See all N" ----

/** Cards shown before the "Show more" toggle. */
export const SECTION_PREVIEW = 3;

export interface SectionSplit {
  shown: BlurbCard[];
  hidden: number; // how many sit behind "Show more"
}

/** The first `preview` cards, and how many wait behind the toggle (all shown when expanded). */
export function splitSection(cards: BlurbCard[], expanded: boolean, preview = SECTION_PREVIEW): SectionSplit {
  if (expanded || cards.length <= preview) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(0, preview), hidden: cards.length - preview };
}

/** "See all 14" text, or null when the topic has nothing more than what is listed. */
export function seeAllLabel(total: number, shown: number): string | null {
  return Number.isFinite(total) && total > Math.max(shown, 1) ? `See all ${total}` : null;
}

/** Feed address filtered to one topic (app/index.tsx reads ?category=). */
export function feedTopicHref(slug: string, stamp?: number): string {
  return `/?tab=top&category=${encodeURIComponent(slug)}${stamp === undefined ? '' : `&t=${stamp}`}`;
}

/** The ?category= value as a safe slug, or null. */
export function topicParam(value: string | string[] | undefined | null): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v) ? v : null;
}

// ---- AI summary box ----

export const SUMMARY_LABEL = 'AI-generated summary · may contain errors';

export function summaryTitle(mode: BriefMode): string {
  return mode === 'weekly' ? 'Weekly summary' : 'Daily summary';
}

/** The muted line under the summary: the AI label (always) then the disclaimer. */
export function summaryFooter(config: AppConfig | null | undefined): string {
  return [SUMMARY_LABEL, disclaimerText(config)].filter(Boolean).join(' · ');
}

// ---- Text ----

/** "last 24 h" / "last 168 h" (the window the server used, which can be wider than asked). */
export function windowText(hours: number): string {
  const h = Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 24;
  return `last ${h} h`;
}

/** Heading of the ranked list. A daily brief that had to look back further says so. */
export function headlineLabel(mode: BriefMode, windowHours: number): string {
  if (mode === 'weekly') return 'Top stories · last week';
  if (!Number.isFinite(windowHours) || windowHours <= 24) return 'Today in a minute';
  const days = Math.round(windowHours / 24);
  return `Top stories · last ${days} days`;
}

/** "Generated 5 h ago · last 24 h", or just the window when the time is unknown. */
export function generatedLine(data: Pick<BriefData, 'generated_at' | 'window_hours'>, now: Date = new Date()): string {
  const window = windowText(data.window_hours);
  if (!hasRealTimestamp(data.generated_at)) return window.charAt(0).toUpperCase() + window.slice(1);
  const ago = relativeTime(data.generated_at, now);
  return ago ? `Generated ${ago} · ${window}` : window.charAt(0).toUpperCase() + window.slice(1);
}

const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Parts {
  weekday: number;
  month: number;
  day: number;
}

// Local calendar date by default (the reader's day); `utc` makes tests independent of the machine.
function parts(d: Date, utc: boolean): Parts {
  return utc
    ? { weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate() }
    : { weekday: d.getDay(), month: d.getMonth(), day: d.getDate() };
}

/** "Saturday, October 18" (wide title meta). */
export function dayLabelLong(d: Date, utc = false): string {
  const x = parts(d, utc);
  return `${DAYS_LONG[x.weekday]}, ${MONTHS_LONG[x.month]} ${x.day}`;
}

/** "Sat, Oct 18" (phone list header). */
export function dayLabelShort(d: Date, utc = false): string {
  const x = parts(d, utc);
  return `${DAYS_LONG[x.weekday].slice(0, 3)}, ${MONTHS_LONG[x.month].slice(0, 3)} ${x.day}`;
}

/** "October 12 – 18", or "September 28 – October 4" across a month change. */
export function weekRangeLabel(end: Date, windowHours: number, utc = false): string {
  const days = Math.max(1, Math.round((Number.isFinite(windowHours) ? windowHours : 168) / 24));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const a = parts(start, utc);
  const b = parts(end, utc);
  if (a.month === b.month) return `${MONTHS_LONG[a.month]} ${a.day} – ${b.day}`;
  return `${MONTHS_LONG[a.month]} ${a.day} – ${MONTHS_LONG[b.month]} ${b.day}`;
}

/** The day the brief is about: its own time when it has one, else now. */
export function briefDate(data: Pick<BriefData, 'generated_at'> | null, now: Date = new Date()): Date {
  return data && hasRealTimestamp(data.generated_at) ? new Date(data.generated_at) : now;
}

/** The date text beside the page title. Falls back to today when the brief has no time. */
export function briefDateLabel(mode: BriefMode, data: Pick<BriefData, 'generated_at' | 'window_hours'> | null, now: Date = new Date(), utc = false): string {
  const at = briefDate(data, now);
  return mode === 'weekly' ? weekRangeLabel(at, data?.window_hours ?? 168, utc) : dayLabelLong(at, utc);
}

/** One short teaser line for a row: the first sentence of the body, capped. '' when none. */
export function teaser(body: string | null | undefined, max = 110): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  return clampText(m ? m[0] : text, max);
}

/**
 * The page footer. Every story row carries its own labels (see briefRowLabels), so the
 * footer only shows the disclaimer when no row does (a brief of numbers alone), and never
 * a second time right under a row. null = no footer.
 */
export function briefFooter(cards: BlurbCard[], config: AppConfig | null | undefined): string | null {
  return cards.length === 0 ? disclaimerText(config) : null;
}

export interface BriefRowSource {
  label: string; // "SEC · 8-K"
  url: string; // https only
  count: number; // sources on the card
}

export interface BriefRowLabels {
  source: BriefRowSource | null;
  line: string; // "AI label · disclaimer" (AI label only for AI-written cards), then required notices
  credit: ShareAlikeCredit | null; // Wikipedia CC BY-SA credit, when the card needs it
}

/**
 * What one Brief row must show next to its headline (rule 5): a link to the primary
 * source (https only) and one muted labels line. The disclaimer appears once per row.
 */
export function briefRowLabels(card: BlurbCard, config: AppConfig | null | undefined): BriefRowLabels {
  const labels = cardLabels(card, config);
  const primary = primarySource(card);
  const source =
    primary && isHttpUrl(primary.url)
      ? {
          label: primary.doc_label ? `${primary.name} · ${primary.doc_label}` : primary.name,
          url: primary.url,
          count: Math.max(card.source_count, card.sources.length),
        }
      : null;
  const line = [labels.aiLabel, labels.disclaimer, ...cardNotices(card, config).map((n) => n.text)].filter(Boolean).join(' · ');
  return { source, line, credit: shareAlikeCredit(card, config) };
}

/** Screen-reader sentence for a number trend: "10-year Treasury yield 5.10%, ▼ 0.09 this week. Source: U.S. Treasury". */
export function trendA11yLabel(t: Pick<NumberTrend, 'name' | 'value' | 'change' | 'direction' | 'source'>): string {
  const word = t.direction === 'up' ? 'up' : t.direction === 'down' ? 'down' : 'unchanged';
  const change = t.change.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return `${t.name} ${t.value}, ${word}${change ? `, ${change}` : ''}. Source: ${t.source}`;
}

// ---- Email sign-up (double opt-in; docs/work/spec-brief-email.md) ----

export const BRIEF_KIND_OPTIONS: { kind: BriefKind; label: string; hint: string }[] = [
  { kind: 'daily', label: 'Daily', hint: 'Every morning' },
  { kind: 'weekly', label: 'Weekly', hint: 'Mondays' },
  { kind: 'both', label: 'Both', hint: 'Daily and weekly' },
];

export const DEFAULT_SEND_HOUR = 7;
/** Hours offered in the time list: 5 AM to 10 PM, in the reader's own time. */
export const SEND_HOURS: number[] = Array.from({ length: 18 }, (_, i) => i + 5);

/** 7 -> "7 AM", 12 -> "12 PM", 22 -> "10 PM". */
export function hourLabel(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

/** The reader's IANA time zone from the device; "UTC" when the device will not say. */
export function detectTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export const BRIEF_CONSENT = 'We email your brief. One click to unsubscribe in every email.';
export const BRIEF_PROMPT_TITLE = 'Stay up to date';
export const BRIEF_PROMPT_TEXT = 'The brief in your inbox, free. Pick daily, weekly or both, and the time that suits you.';

/** About > Your data: what is stored when someone subscribes (app/about.tsx imports this). */
export const BRIEF_DATA_TEXT =
  'If you subscribe to the email brief we store your email address, the kind of brief you chose, your send time and your time zone. You can unsubscribe any time with one click in any email, and nothing is sold or shared.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Same shape check as the server (api.subscribe_brief): trimmed, lowercased, <= 254 chars. */
export function cleanEmail(raw: string): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export interface SignupInput {
  email: string;
  kind: BriefKind;
  hour: number;
  tz: string;
}

export type SignupCheck = { ok: true; value: SignupInput } | { ok: false; error: string };

export function validateSignup(input: SignupInput): SignupCheck {
  const email = cleanEmail(input.email);
  if (email === null) return { ok: false, error: 'Enter a valid email address, like name@example.com.' };
  if (!BRIEF_KIND_OPTIONS.some((o) => o.kind === input.kind)) return { ok: false, error: 'Choose daily, weekly or both.' };
  if (!SEND_HOURS.includes(input.hour)) return { ok: false, error: 'Choose a time between 5 AM and 10 PM.' };
  return { ok: true, value: { email, kind: input.kind, hour: input.hour, tz: input.tz || 'UTC' } };
}

export interface SignupMessage {
  tone: 'ok' | 'error';
  title: string;
  text: string;
}

/**
 * What to tell the reader for each server answer. 'pending' is the answer for every valid
 * address (new, already waiting or already subscribed), so the text never reveals whether
 * someone is already on the list.
 */
export function signupMessage(status: BriefSubscribeStatus): SignupMessage {
  switch (status) {
    case 'pending':
      return { tone: 'ok', title: 'Check your email to confirm', text: 'If that address can receive the brief, a message with a confirmation link is on its way. It can take a minute. Nothing is sent until you confirm.' };
    case 'invalid':
      return { tone: 'error', title: 'That email does not look right', text: 'Check the address and try again.' };
    case 'limited':
      return { tone: 'error', title: 'Too many tries', text: 'Please wait a little while and try again.' };
    default:
      return { tone: 'error', title: 'Email briefs are not available right now', text: 'We could not reach the sign-up service. Nothing was saved. Please try again later.' };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A ?token= / ?manage= value as a UUID, or null (never sent to the server otherwise). */
export function tokenParam(value: string | string[] | undefined | null): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null;
}

export const BRIEF_EMAIL_KEY = 'element.brief-email';

/** The email the reader chose to keep on this device ('' when none). */
export function readRememberedEmail(store: KeyValueStore): string {
  return cleanEmail(store.get(BRIEF_EMAIL_KEY) ?? '') ?? '';
}

/** Keeps the address on this device only when `remember`; otherwise forgets any saved one. */
export function saveRememberedEmail(store: KeyValueStore, email: string, remember: boolean): void {
  const e = cleanEmail(email);
  if (remember && e) store.set(BRIEF_EMAIL_KEY, e);
  else store.remove(BRIEF_EMAIL_KEY);
}

// ---- Running an email call ----

export type MailOutcome = 'done' | 'failed' | 'unavailable';

/** Runs an api email call; a thrown error becomes 'unavailable', never a crash. */
export async function runMail(call: (() => Promise<{ ok: boolean; status?: string }>) | null): Promise<MailOutcome> {
  if (!call) return 'unavailable';
  try {
    const r = await call();
    if (r.ok) return 'done';
    return r.status === 'unavailable' ? 'unavailable' : 'failed';
  } catch {
    return 'unavailable';
  }
}
