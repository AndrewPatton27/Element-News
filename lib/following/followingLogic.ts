// Following rules. Pure: no React imports (lib/__tests__/followingLogic.test.ts).
//
// What a reader follows is three short lists: topics (category slugs), sources
// (source names as they appear on cards) and companies (tickers). api.followingFeed
// takes all three and returns the newest relevant cards, each with a follow_reason.
//
// Where the lists live:
// - Topics: signed in -> the account's followed topics (prefs, shared with For you);
//   signed out -> this device.
// - Sources and companies: this device. The account has no field for them yet.

import type { BlurbCard, Category } from '../../contract/types.ts';
import { categoryName } from '../shared/format.ts';
import { SOURCE_KEYS } from '../sources/sourceKeys.ts';

export interface Follows {
  topics: string[];
  sources: string[];
  tickers: string[];
}

export const EMPTY_FOLLOWS: Follows = { topics: [], sources: [], tickers: [] };
export const FOLLOWS_KEY = 'element.follows';
export const MAX_FOLLOWS_PER_KIND = 30;

function strings(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) if (typeof v === 'string' && v.trim() !== '' && !out.includes(v.trim())) out.push(v.trim());
  return out.slice(0, MAX_FOLLOWS_PER_KIND);
}

// Storage holds JSON text; anything unreadable counts as "following nothing".
export function parseFollows(raw: string | null): Follows {
  if (!raw) return EMPTY_FOLLOWS;
  try {
    const x = JSON.parse(raw) as Partial<Record<keyof Follows, unknown>> | null;
    if (!x || typeof x !== 'object') return EMPTY_FOLLOWS;
    return { topics: strings(x.topics), sources: strings(x.sources), tickers: strings(x.tickers).map((t) => t.toUpperCase()) };
  } catch {
    return EMPTY_FOLLOWS;
  }
}

export function serializeFollows(f: Follows): string {
  return JSON.stringify(f);
}

export function hasFollows(f: Follows): boolean {
  return f.topics.length + f.sources.length + f.tickers.length > 0;
}

// Adds the value, or removes it when already there. A full list refuses new values (returns it unchanged).
export function toggleValue(list: string[], value: string, max = MAX_FOLLOWS_PER_KIND): string[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  return list.length >= max ? list : [...list, value];
}

// Card-level topic follow helpers; keep card state derived from the same slug list
// used by Following and account/device preferences.
export function isTopicFollowed(topics: readonly string[], slug: string): boolean {
  return topics.includes(slug);
}

export function toggleTopicFollow(topics: readonly string[], slug: string): string[] {
  return topics.includes(slug) ? topics.filter((topic) => topic !== slug) : [...topics, slug];
}

// "aapl" / " BA " -> "AAPL"; null when the text can't be a ticker (1 to 5 letters, optional .X class).
export function normalizeTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(t) ? t : null;
}

// The lists api.followingFeed gets: signed in, topics come from the account.
export function effectiveFollows(local: Follows, accountTopics: string[] | null): Follows {
  return accountTopics ? { ...local, topics: accountTopics } : local;
}

// One key for the current set of follows: a change starts a new feed.
export function followsKey(f: Follows): string {
  return `following|${[...f.topics].sort().join(',')}|${[...f.sources].sort().join(',')}|${[...f.tickers].sort().join(',')}`;
}

// ---- Sources ----

// The sources a reader can follow: the ones with a card source name.
export const FOLLOWABLE_SOURCES: { name: string; label: string }[] = SOURCE_KEYS.filter((s) => s.matchNames.length > 0).map((s) => ({
  name: s.matchNames[0],
  label: s.name,
}));

export function sourceLabel(name: string): string {
  return FOLLOWABLE_SOURCES.find((s) => s.name === name)?.label ?? name;
}

// ---- Wording ----

export function topicLabel(slug: string, categories: Category[]): string {
  return categoryName(slug, categories);
}

// "2 topics · 1 company": a short summary under the title.
export function followCountText(f: Follows): string {
  const parts: string[] = [];
  if (f.topics.length) parts.push(`${f.topics.length} topic${f.topics.length === 1 ? '' : 's'}`);
  if (f.sources.length) parts.push(`${f.sources.length} source${f.sources.length === 1 ? '' : 's'}`);
  if (f.tickers.length) parts.push(`${f.tickers.length} ${f.tickers.length === 1 ? 'company' : 'companies'}`);
  return parts.join(' · ');
}

const REASON_PREFIXES = ['Because you follow ', 'Related to '];

// The server writes the topic as its slug ("Because you follow safety"); show its name
// ("Recalls & Safety"). Cards without a reason get none (nothing is made up).
export function followReasonText(card: Pick<BlurbCard, 'follow_reason'>, categories: Category[]): string | null {
  const reason = card.follow_reason;
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  for (const prefix of REASON_PREFIXES) {
    if (reason.startsWith(prefix)) {
      const rest = reason.slice(prefix.length).trim();
      // A lowercase slug ("policy") is a topic even when the category list has not loaded.
      const named =
        categories.find((c) => c.slug === rest)?.name ??
        (/^[a-z][a-z-]*$/.test(rest) ? categoryName(rest, categories) : sourceLabel(rest));
      return `${prefix}${named}`;
    }
  }
  return reason.trim();
}

// A reason starting "Related to" is a looser match than "Because you follow".
export function isDirectMatch(card: Pick<BlurbCard, 'follow_reason'>): boolean {
  return typeof card.follow_reason === 'string' && card.follow_reason.startsWith('Because you follow');
}
