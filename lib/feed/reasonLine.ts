// "Why is this card in my For you?" One short plain line per card (A-16, F10).
// Signed in: the server sends reason = { code, arg } on each For you card (core.fy_post, migration 20261126000000).
// Signed out: localReason() picks the same codes from the reader's own choices on this device.
// Built only from the reader's OWN follows and reactions; never from other readers. Pure; no I/O.

import type { BlurbCard } from '../../contract/types.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { categoryName } from '../shared/format.ts';
import { isKeySeries, tickerList } from './cardKeys.ts';
import { isAuthorityCard } from './forYouRank.ts';

export type ReasonCode =
  | 'follow_company' | 'follow_topic' | 'liked_company' | 'liked_topic'
  | 'key_release' | 'authority' | 'new_topic' | 'top_story';

export interface ForYouReason { code: ReasonCode; arg: string | null }

const CODES = new Set<ReasonCode>(['follow_company', 'follow_topic', 'liked_company', 'liked_topic', 'key_release', 'authority', 'new_topic', 'top_story']);

/** The reason a server card carries, or null (older server, Trending, Latest, unknown code). */
export function cardReason(card: { reason?: unknown }): ForYouReason | null {
  const r = card.reason as { code?: unknown; arg?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || typeof r.code !== 'string' || !CODES.has(r.code as ReasonCode)) return null;
  return { code: r.code as ReasonCode, arg: typeof r.arg === 'string' && r.arg.trim() ? r.arg.trim().slice(0, 40) : null };
}

/** The line under the card meta. Null = show nothing ('top_story' says nothing new, so it is hidden). */
export function reasonText(reason: ForYouReason | null, categories?: Parameters<typeof categoryName>[1]): string | null {
  if (!reason) return null;
  const topic = reason.arg ? categoryName(reason.arg, categories) : null;
  switch (reason.code) {
    case 'follow_company': return reason.arg ? `Because you follow ${reason.arg.toUpperCase()}` : null;
    case 'follow_topic': return topic ? `Because you follow ${topic}` : null;
    case 'liked_company': return reason.arg ? `Because you liked news about ${reason.arg.toUpperCase()}` : null;
    case 'liked_topic': return topic ? `Because you liked ${topic} stories` : null;
    case 'key_release': return 'Key economic report';
    case 'authority': return 'From an official source';
    case 'new_topic': return topic ? `Something new: ${topic}` : null;
    default: return null;
  }
}

type Prefs = Pick<LocalPrefs, 'reactions'> & { follows: { topics: string[]; tickers?: string[] } };

/** Same order of precedence as the server (core.fy_post). */
export function localReason(card: BlurbCard, prefs: Prefs): ForYouReason {
  const tickers = tickerList(card);
  const followed = new Set((prefs.follows.tickers ?? []).map((t) => t.toUpperCase()));
  const fco = tickers.find((t) => followed.has(t));
  if (fco) return { code: 'follow_company', arg: fco };
  if (prefs.follows.topics.includes(card.category)) return { code: 'follow_topic', arg: card.category };
  const rs = Object.entries(prefs.reactions).filter(([id]) => id !== card.id).map(([, r]) => r);
  const net = new Map<string, number>();
  for (const r of rs) for (const t of r.tickers ?? []) net.set(t, (net.get(t) ?? 0) + (r.r === 'like' ? 1 : -1));
  const lco = tickers.filter((t) => (net.get(t) ?? 0) > 0).sort((a, b) => (net.get(b)! - net.get(a)!) || a.localeCompare(b))[0];
  if (lco) return { code: 'liked_company', arg: lco };
  const topicNet = rs.reduce((n, r) => n + (r.topic === card.category ? (r.r === 'like' ? 1 : -1) : 0), 0);
  if (topicNet > 0) return { code: 'liked_topic', arg: card.category };
  if (isKeySeries(card)) return { code: 'key_release', arg: null };
  if (isAuthorityCard(card)) return { code: 'authority', arg: null };
  if (rs.length >= 3 && !rs.some((r) => r.topic === card.category)) return { code: 'new_topic', arg: card.category };
  return { code: 'top_story', arg: null };
}

/** The reason to render for a For you card: the server's when it sent one (signed in), else the device's own. */
export function reasonFor(card: BlurbCard & { reason?: unknown }, prefs: Prefs | null): ForYouReason | null {
  return cardReason(card) ?? (prefs ? localReason(card, prefs) : null);
}
