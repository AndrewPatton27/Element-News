// For you candidate ranking (device side). Pure and deterministic. Every term is in HOURS of
// freshness (same unit as feedLogic.mockRankScore: hours + 8 per importance doubling).
//   score = pulledAt hours + 8*log2(importance)      base (freshness from published_at, like Latest)
//         + personal taste (localScore minus its base): follows +24, likes +8/+4, dislikes -8/-4
//         - FY.overlapTop3 / FY.overlapTop10 if the card is one of Trending's top stories (set order = Trending order)
//         - FY.seenPenalty if seen, - FY.reactedPenalty if the reader reacted
// Warm reader: score desc. Cold reader (no follows, < FY.coldReactions reactions): topic
// round-robin, best card of each topic first (importance + freshness inside a topic).
// Then spread from Trending's top stories, the first-card guard, and diversifyFeed LAST.
// All constants are in FY (context/settings.md, rows foryou.*).
// M9 additions: a disliked card and its twins are removed at once; off-topic science/world cards with no
// ticker or macro number need a follow; a topic the reader net-disliked (>= 2 more dislikes than likes) goes
// to the end; macro authority cards (BLS, BEA, Fed, Treasury) get +FY.authorityBoost; last, shapeTop keeps at
// most FY.familyCap cards of one series family (e.g. Treasury yields) per FY.familyWindow and at most
// FY.companyCap company card per FY.companyWindow in the first FY.companyTopSlots slots.

import type { BlurbCard } from '../../contract/types.ts';
import { diversifyFeed } from './diversify.ts';
import { localScore } from './localRank.ts';
import { mockRankScore } from './feedLogic.ts';
import { dedupeCards, pulledAt } from './feedOrder.ts';
import { cardFamily, dislikeIndex, tickerList } from './cardKeys.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { cardSourceKey } from '../sources/sourceKeys.ts';

type Prefs = Pick<LocalPrefs, 'reactions' | 'hiddenTopics' | 'hiddenSources'> & { follows: { topics: string[]; sources?: string[]; tickers?: string[] } };

/** Trending first, then Latest, then any extra candidate lists (followed topics/companies, Economy), each card once:
 *  by id, and by headline + source link (the same story under two ids). */
export function mergePool(trending: BlurbCard[], latest: BlurbCard[], ...extra: BlurbCard[][]): BlurbCard[] {
  return dedupeCards([...trending, ...latest, ...extra.flat()]);
}

// Latest helpers live in lib/feedOrder.ts; re-exported so older imports keep working.
export { shownTime, sortLatest } from './feedOrder.ts';

/** Keeps For you from opening as a copy of Trending: in the first `window` slots at most
 *  `maxShared` cards may come from Trending's top stories; the rest move down, in order. */
export function spreadFromTrending(cards: BlurbCard[], trendingTopIds: ReadonlySet<string>, window = 5, maxShared = 2): BlurbCard[] {
  if (trendingTopIds.size === 0) return cards;
  const head: BlurbCard[] = [];
  const held: BlurbCard[] = [];
  const rest: BlurbCard[] = [];
  let shared = 0;
  for (const c of cards) {
    if (head.length >= window) { rest.push(c); continue; }
    if (trendingTopIds.has(c.id)) {
      if (shared >= maxShared) { held.push(c); continue; }
      shared += 1;
    }
    head.push(c);
  }
  return [...head, ...held, ...rest];
}

/** Every tunable For you constant, in hours unless noted. */
export const FY = { seenPenalty: 24, reactedPenalty: 72, authorityBoost: 8, familyCap: 2, familyWindow: 10, companyCap: 1, companyWindow: 3, companyTopSlots: 9, sourNet: -2, offMarketLikes: 2, coldReactions: 3, overlapWindow: 5, overlapMax: 2, overlapTop3: 10, overlapTop10: 6, likeHalfLifeDays: 14, dislikeSpill: 4, spillLast: 3, exploreFirst: 4, exploreEvery: 6, exploreMinReactions: 3, topicCap: 3, topicCapWindow: 10, tasteWeight: 8 } as const;

/** Source names of the macro authorities whose cards lead a macro-first feed. */
const AUTHORITY = /bureau of labor statistics|bureau of economic analysis|federal reserve|board of governors|federal open market|department of the treasury|u\.s\. treasury|treasury department|\bBLS\b|\bBEA\b/i;
/** BLS / BEA / Fed / Treasury card. Daily Treasury-yield series cards are excluded (they already flood). */
export function isAuthorityCard(c: BlurbCard): boolean {
  if (cardFamily(c) === 'g:rates') return false;
  return (c.sources ?? []).some((s) => AUTHORITY.test(s.name)) || (c.macro ?? []).some((m) => AUTHORITY.test(m.source_name ?? ''));
}

/** A single-company card (earnings, filing, deal) that is not about a followed ticker. */
export function isCompanyCard(c: BlurbCard, followed: ReadonlySet<string>): boolean {
  if (c.kind === 'data' || c.macro?.length) return false;
  if (!tickerList(c).length && c.category !== 'earnings' && c.category !== 'deals') return false;
  return !tickerList(c).some((t) => followed.has(t));
}

/** Science / World cards with no ticker and no macro number are not market news: shown only to readers who follow the
 *  topic, or whose net likes in it reach FY.offMarketLikes. */
const OFF_MARKET_TOPICS = new Set(['science', 'world']);
export const isOffMarket = (c: BlurbCard): boolean => OFF_MARKET_TOPICS.has(c.category) && !c.tickers?.length && !c.macro?.length;

/**
 * Final shaping, greedy slot by slot (soft, like microCapOrder: when nothing fits, the first card is taken):
 *  - at most FY.familyCap cards of one series family in any FY.familyWindow in a row;
 *  - when `followedTickers` is given: at most FY.companyCap company card in any FY.companyWindow in a row, in the
 *    first FY.companyTopSlots slots (macro first; cards of followed companies are exempt);
 *  - prefer a different topic than the previous card.
 * `before` = cards already placed ahead of these (they count for the windows).
 */
export function shapeTop(cards: BlurbCard[], followedTickers?: ReadonlySet<string>, before: BlurbCard[] = []): BlurbCard[] {
  const fam = new Map<BlurbCard, string>();
  const famOf = (c: BlurbCard) => { let f = fam.get(c); if (f === undefined) { f = cardFamily(c); fam.set(c, f); } return f; };
  const left = [...cards], out: BlurbCard[] = [], hist = [...before];
  while (left.length) {
    const pos = hist.length;
    const w10 = hist.slice(-(FY.familyWindow - 1)), w3 = hist.slice(-(FY.companyWindow - 1));
    const okFam = (c: BlurbCard) => { const f = famOf(c); return !f || w10.filter((x) => famOf(x) === f).length < FY.familyCap; };
    const co = (c: BlurbCard) => !!followedTickers && pos < FY.companyTopSlots && isCompanyCard(c, followedTickers);
    const okCo = (c: BlurbCard) => !co(c) || w3.filter((x) => isCompanyCard(x, followedTickers!)).length < FY.companyCap;
    const last = hist[hist.length - 1];
    let i = left.findIndex((c) => okFam(c) && okCo(c) && (!last || last.category !== c.category));
    if (i < 0) i = left.findIndex((c) => okFam(c) && okCo(c));
    if (i < 0) i = left.findIndex(okFam);
    if (i < 0) i = 0;
    const [c] = left.splice(i, 1);
    out.push(c); hist.push(c);
  }
  return out;
}

const HOUR_MS = 3_600_000;
const base = (c: BlurbCard): number => pulledAt(c) / HOUR_MS + 8 * Math.log2(c.importance && c.importance > 0 ? c.importance : 1);
const idDesc = (a: BlurbCard, b: BlurbCard) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** At most `cap` cards of one topic among the first `window`; the extra ones move down, order kept. */
export function capTopics(cards: BlurbCard[], window = FY.topicCapWindow, cap = FY.topicCap): BlurbCard[] {
  const head: BlurbCard[] = [], held: BlurbCard[] = [], rest: BlurbCard[] = [];
  const n = new Map<string, number>();
  for (const c of cards) {
    if (head.length >= window) { rest.push(c); continue; }
    const k = n.get(c.category) ?? 0;
    if (k >= cap) { held.push(c); continue; }
    n.set(c.category, k + 1); head.push(c);
  }
  return [...head, ...held, ...rest];
}

/** Likes older than likeHalfLifeDays fade (only real timestamps; tiny `at` values are test counters). */
function tasteDelta(card: BlurbCard, prefs: Prefs, now: number): number {
  const rs = Object.values(prefs.reactions).filter((r) => r.topic === card.category).sort((a, b) => b.at - a.at).slice(0, 3);
  let d = 0;
  for (const r of rs) {
    if (r.at <= 1e12) continue;
    const decay = Math.pow(0.5, Math.max(0, now - r.at) / (FY.likeHalfLifeDays * 86_400_000));
    d += (r.r === 'like' ? FY.tasteWeight : -FY.tasteWeight) * (decay - 1);
  }
  return d;
}

/** A dislike among the reader's last few reactions costs that topic a little more (not the old likes' fade). */
function spillDelta(card: BlurbCard, prefs: Prefs): number {
  const last = Object.values(prefs.reactions).sort((a, b) => b.at - a.at).slice(0, FY.spillLast);
  return last.some((r) => r.r === 'dislike' && r.topic === card.category) ? -FY.dislikeSpill : 0;
}

/** Shared post-step (signed-out and signed-in pages): spread away from Trending's top stories, make the
 *  first card differ from Trending's first, then diversify LAST so no topic run is recreated.
 *  Cards before `reached` stay where they are; only the rest is touched. */
export function finishForYou(cards: BlurbCard[], trendingTopIds: ReadonlySet<string> = new Set(), trendingFirstId: string | null = null, reached = 0, followedTickers?: ReadonlySet<string>): BlurbCard[] {
  const keep = Math.max(0, Math.min(cards.length, reached));
  let rest = capTopics(cards.slice(keep), FY.topicCapWindow, FY.topicCap);
  rest = spreadFromTrending(rest, trendingTopIds, FY.overlapWindow, FY.overlapMax);
  if (keep === 0 && trendingFirstId && rest.length > 1 && rest[0].id === trendingFirstId) rest = [rest[1], rest[0], ...rest.slice(2)];
  const head = cards.slice(0, keep);
  return [...head, ...shapeTop(diversifyFeed(capTopics(diversifyFeed(rest))), followedTickers, head)];
}

export function rankForYou(pool: BlurbCard[], prefs: Prefs, seenIds: ReadonlySet<string>, trendingFirstId: string | null, trendingTopIds: ReadonlySet<string> = new Set(), now: number = Date.now()): BlurbCard[] {
  const disliked = dislikeIndex(prefs.reactions);
  // Net reactions per topic (likes minus dislikes): lifts the off-market gate when positive, sends a sour topic to the end.
  const net = new Map<string, number>();
  for (const r of Object.values(prefs.reactions)) net.set(r.topic, (net.get(r.topic) ?? 0) + (r.r === 'like' ? 1 : -1));
  const kept = pool.filter((c) => {
    if (disliked(c)) return false; // the card and its twins, at once
    if (prefs.hiddenTopics.includes(c.category)) return false;
    if (isOffMarket(c) && !prefs.follows.topics.includes(c.category) && (net.get(c.category) ?? 0) < FY.offMarketLikes) return false;
    const src = cardSourceKey(c);
    return !(src && prefs.hiddenSources.includes(src));
  });
  const trendRank = new Map([...trendingTopIds].map((id, i) => [id, i]));
  const scored = kept.map((c) => {
    const tr = trendRank.get(c.id);
    const overlap = tr === undefined ? 0 : tr < 3 ? FY.overlapTop3 : FY.overlapTop10;
    const reacted = !!prefs.reactions[c.id];
    const penalty = reacted ? FY.reactedPenalty : seenIds.has(c.id) ? FY.seenPenalty : 0;
    const authority = isAuthorityCard(c) ? FY.authorityBoost : 0;
    return { c, s: base(c) + (localScore(c, prefs) - mockRankScore(c)) - penalty - overlap + tasteDelta(c, prefs, now) + spillDelta(c, prefs) + authority };
  }).sort((a, b) => b.s - a.s || idDesc(a.c, b.c));
  const f = prefs.follows;
  const cold = !f.topics.length && !f.sources?.length && !f.tickers?.length && Object.keys(prefs.reactions).length < FY.coldReactions;
  let ordered = scored.map((x) => x.c);
  if (cold) {
    // Topic round-robin: all topics' best cards first, then every topic's second, and so on.
    const depth = new Map<string, number>();
    ordered = scored.map((x, i) => { const d = depth.get(x.c.category) ?? 0; depth.set(x.c.category, d + 1); return { c: x.c, d, i }; })
      .sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.c);
  }
  // A topic the reader net-disliked (and does not follow) goes to the end: the diversity steps cannot use it as filler.
  const sour = (c: BlurbCard) => (net.get(c.category) ?? 0) <= FY.sourNet && !f.topics.includes(c.category);
  if (!cold) ordered = [...ordered.filter((c) => !sour(c)), ...ordered.filter(sour)];
  // Explore: after enough reactions, slot 4 (then every 6th) is the best unseen card from a topic the reader never reacted to or followed.
  const nReact = Object.keys(prefs.reactions).length;
  if (!cold && nReact >= FY.exploreMinReactions) {
    const known = new Set([...f.topics, ...Object.values(prefs.reactions).map((r) => r.topic)]);
    for (let slot = FY.exploreFirst - 1; slot < ordered.length; slot += FY.exploreEvery) {
      const j = ordered.findIndex((c, i) => i > slot && !known.has(c.category) && !seenIds.has(c.id));
      if (j < 0 || ordered.slice(0, slot + 1).some((c) => !known.has(c.category) && !seenIds.has(c.id))) continue;
      ordered = [...ordered.slice(0, slot), ordered[j], ...ordered.slice(slot, j), ...ordered.slice(j + 1)];
    }
  }
  return finishForYou(ordered, trendingTopIds, trendingFirstId, 0, new Set((f.tickers ?? []).map((t) => t.toUpperCase())));
}
