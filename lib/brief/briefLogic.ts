// Pure rules for the Brief screen (daily and weekly). No React imports, so node --test
// runs it. The screen loads api.dailyBrief() / api.weeklyBrief(); this file decides what
// to show from the result: hidden topics and sources, no card twice, the "Generated"
// line, the date labels, the one-line teaser and the footer wording.

import type { AppConfig, BlurbCard, Brief, BriefKind, BriefMarkets, BriefWindowKind, BriefSubscribeStatus, BriefSummary, Category, MacroFact, NumberTrend } from '../../contract/types.ts';
import { categoryName, clampText, relativeTime } from '../shared/format.ts';
import { cardNotices, primarySource, shareAlikeCredit, type ShareAlikeCredit } from '../shared/labels.ts';
import type { KeyValueStore } from '../storage/storage.ts';
import { isHttpUrl } from '../shared/types.ts';
import { spanLabel } from './briefWindow.ts';
import { briefLeadCards, categoryTier, orderBriefCards } from '../../contract/briefOrder.ts';

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
  /** The 3-bullet lead: the first three stories in the macro-first order (no AI). */
  lead: BlurbCard[];
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
    window_kind: raw.window_kind,
    brief_date: raw.brief_date,
    fallback: raw.fallback === true,
    as_of: typeof raw.as_of === 'string' ? raw.as_of : null,
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
  // The lead is picked from every visible story before the lists below take them (a lead story also stays in its list).
  const visibleAll = visible([...data.headline_cards, ...(data.markets?.cards ?? []), ...data.sections.flatMap((s) => s.cards)].filter(canShow));
  const lead = briefLeadCards(visibleAll);
  // Macro first (D-119, F-01): Fed and government before single companies, recalls and space last. Stable inside a tier.
  const headlines = orderBriefCards(take(data.headline_cards));
  const marketCards = take(data.markets?.cards ?? []);
  const sections = data.sections
    .map((s, i) => {
      const cards = orderBriefCards(take(s.cards));
      return { i, tier: categoryTier(s.category), category: s.category, title: sectionTitle(s, categories), cards, slug: s.slug ?? s.category, total: Math.max(s.total ?? 0, cards.length) };
    })
    .filter((s) => s.cards.length > 0)
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map(({ i: _i, tier: _t, ...s }) => s);
  // One numbers block (F-04): the brief's numbers plus the market numbers, one entry per series.
  const seenSeries = new Set<string>();
  const numbers = [...data.numbers, ...(data.markets?.numbers ?? [])].filter((n) => (seenSeries.has(n.series_id) ? false : (seenSeries.add(n.series_id), true)));
  return {
    headlines,
    sections,
    numbers,
    movers: data.movers,
    summary: data.summary,
    lead,
    marketCards,
    marketNumbers: [],
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

/** "Summary from Nov 6" when the stored summary is older than the brief it sits in (the day's own is not written yet); else null. */
export function summaryAgeNote(summary: BriefSummary | null, mode: BriefMode, briefDate: string | undefined): string | null {
  const f = summary?.for_date;
  if (!f || !briefDate || !/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(briefDate)) return null;
  const current = mode === 'weekly' ? mondayOf(briefDate) : briefDate;
  if (f >= current) return null;
  return `Summary from ${dayLabelShort(new Date(`${f}T12:00:00Z`), true)}`;
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The muted line under the summary: the AI label, right by the AI-written text. The
 *  disclaimer is the Brief screen's persistent strip (D-80), so it is not repeated here. */
export function summaryFooter(): string {
  return SUMMARY_LABEL;
}

// ---- Text ----

/** "last 24 h" / "last 168 h" (the window the server used, which can be wider than asked). */
export function windowText(hours: number): string {
  const h = Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 24;
  return `last ${h} h`;
}

/** Heading of the ranked list. A Monday brief says "since Friday"; an older fallback names its span. */
export function headlineLabel(mode: BriefMode, windowHours: number, kind?: BriefWindowKind): string {
  if (mode === 'weekly') return 'Top stories · last week';
  if (kind === 'since_friday') return 'Top stories · since Friday';
  if (kind === '24h' || !Number.isFinite(windowHours) || windowHours <= 24) return 'Today in a minute';
  return `Top stories · ${spanLabel(kind, windowHours).toLowerCase()}`;
}

/** "Generated 5 h ago · Last 24 hours" / "... · Since Friday", or just the span when the time is unknown. */
export function generatedLine(data: Pick<BriefData, 'generated_at' | 'window_hours' | 'window_kind'>, now: Date = new Date()): string {
  const span = spanLabel(data.window_kind, data.window_hours);
  if (!hasRealTimestamp(data.generated_at)) return span;
  const ago = relativeTime(data.generated_at, now);
  return ago ? `Generated ${ago} · ${span}` : span;
}

export type BriefSource = 'live' | 'cached';

/**
 * The line under the title. A normal brief says when it was made and its real span. A brief built from
 * the last good cards (nothing new in the window) or a saved copy says "Updated <date>" instead.
 */
export function briefStatusLine(data: BriefData, source: BriefSource, now: Date = new Date(), utc = false): string {
  if (source === 'cached') return `Updated ${dayLabelShort(lastGoodDate(data), utc)} · saved copy, the latest could not be loaded`;
  if (data.fallback) return `Updated ${dayLabelShort(lastGoodDate(data), utc)} · the latest stories we have`;
  return generatedLine(data, now);
}

/** The day a fallback or saved brief really is from: its newest card, else its own time. */
export function lastGoodDate(data: Pick<BriefData, 'as_of' | 'generated_at'>): Date {
  const t = data.as_of ? Date.parse(data.as_of) : NaN;
  if (!Number.isNaN(t) && t > Date.UTC(2000, 0, 1)) return new Date(t);
  return hasRealTimestamp(data.generated_at) ? new Date(data.generated_at) : new Date();
}

/** true when the brief has at least one story card (numbers alone do not count). */
export function briefHasStories(data: Pick<BriefData, 'headline_cards' | 'sections' | 'markets'>): boolean {
  return data.headline_cards.length > 0 || data.sections.some((s) => s.cards.length > 0) || (data.markets?.cards.length ?? 0) > 0;
}

const CACHE_KEY = (mode: BriefMode) => `element.brief-last-good.${mode}`;
const CACHE_MAX_CHARS = 400_000; // a brief is far smaller; this only guards a storage quota

/** Keeps a brief that has stories as the last good one for this mode (a live fallback brief is saved too). */
export function saveLastGoodBrief(store: KeyValueStore, mode: BriefMode, data: BriefData): void {
  if (!briefHasStories(data)) return;
  try {
    const text = JSON.stringify(data);
    if (text.length <= CACHE_MAX_CHARS) store.set(CACHE_KEY(mode), text);
  } catch {
    // storage full or blocked: the brief just has no saved copy
  }
}

/** The last good brief for this mode, or null (unreadable or without stories counts as none). */
export function loadLastGoodBrief(store: KeyValueStore, mode: BriefMode): BriefData | null {
  try {
    const raw = store.get(CACHE_KEY(mode));
    if (!raw) return null;
    const data = toBriefData(JSON.parse(raw) as Brief);
    return briefHasStories(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Never empty: the live brief when it has stories, else the saved last good brief (labelled with its
 * date), else the live brief as it is (the screen then shows its honest empty state).
 */
export function resolveBrief(live: BriefData | null, saved: BriefData | null): { data: BriefData | null; source: BriefSource } {
  if (live && briefHasStories(live)) return { data: live, source: 'live' };
  if (saved) return { data: saved, source: 'cached' };
  return { data: live, source: 'live' };
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

export interface BriefRowSource {
  label: string; // "SEC · 8-K"
  url: string; // https only
  count: number; // sources on the card
}

export interface BriefRowLabels {
  source: BriefRowSource | null;
  line: string; // required notices only (FRED); "" when none. The AI notice and disclaimer are the screen's strip (D-80)
  credit: ShareAlikeCredit | null; // Wikipedia CC BY-SA credit, when the card needs it
}

/**
 * What one Brief row must show next to its headline (rule 5): a link to the primary
 * source (https only) and, when the card needs one, its required notice (FRED, rule 8).
 * The AI notice and the disclaimer sit once in the Brief screen's persistent strip (D-80).
 */
export function briefRowLabels(card: BlurbCard, config: AppConfig | null | undefined): BriefRowLabels {
  const primary = primarySource(card);
  const source =
    primary && isHttpUrl(primary.url)
      ? {
          label: primary.doc_label ? `${primary.name} · ${primary.doc_label}` : primary.name,
          url: primary.url,
          count: Math.max(card.source_count, card.sources.length),
        }
      : null;
  const line = cardNotices(card, config).map((n) => n.text).filter(Boolean).join(' · ');
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
