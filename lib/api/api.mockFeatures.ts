// Pure mock implementations for search, related cards, following and briefs.
// Kept separate from fixture-loading code so these rules can run under node:test.
import type { BlurbCard, Brief, BriefSubscribeResult, BriefSubscriptionInput, BriefTokenResult, FeedPage, MyBriefChangeResult, MyBriefSubscription, MacroFact, NumberTrend, StoryLink } from '../../contract/types.ts';
import { mockRankScore } from '../feed/feedLogic.ts';
import { dailyWindow } from '../brief/briefWindow.ts';
import { rankSearch } from '../search/searchLogic.ts';
import { isValidBriefInput, normalizeBriefEmail } from '../shared/types.ts';
import { tagSampleCards } from '../companies/companyApi.ts';
import type { CardCompany } from '../companies/companyLogic.ts';

/** api.following_feed counts at most this many followed tickers (20261119000000_following_companies.sql). */
export const FOLLOWED_TICKER_CAP = 100;

export const MARKET_CATEGORIES = new Set(['markets', 'earnings', 'deals']);
export const MARKET_SERIES = ['DGS10', 'DGS2', 'DFF', 'DCOILWTICO'];
/** Same caps as api.subscribe_brief (context/settings.md). */
export const BRIEF_CAPS = { perEmailPerDay: 5, globalPerHour: 200 };

export function createMockFeatureApi(cards: BlurbCard[], numbers: MacroFact[], trends: NumberTrend[], storyLinks: { card_id: string; related_id: string; kind: StoryLink["kind"] }[] = [], clock: () => number = Date.now) {
  // Give the regular sample feed a small, deterministic linked-story chain too.
  const sampleLinks = storyLinks.length ? storyLinks : (() => {
    const anchor = cards.find((c) => c.category === 'markets');
    const updates = cards.filter((c) => c.id !== anchor?.id && (c.category === 'markets' || c.category === 'earnings')).slice(0, 2);
    const angle = cards.find((c) => c.id !== anchor?.id && c.category !== 'markets' && c.category !== 'earnings');
    if (!anchor || updates.length < 2 || !angle) return storyLinks;
    return [{ card_id: updates[0].id, related_id: anchor.id, kind: 'update' as const }, { card_id: updates[1].id, related_id: anchor.id, kind: 'related' as const }, { card_id: angle.id, related_id: anchor.id, kind: 'angle' as const }];
  })();
  let tagCache: Map<string, CardCompany[]> | null = null;
  const companyTags = () => (tagCache ??= tagSampleCards(cards));
  const page = (items: BlurbCard[], cursor?: string | null, limit = 20): FeedPage => {
    const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
    const slice = items.slice(start, start + limit);
    return { items: slice, next_cursor: start + slice.length < items.length ? String(start + slice.length) : null };
  };
  // Same rules as api.daily_brief / api.weekly_brief (migration 20261018030000_brief_depth.sql):
  // a section for every topic (best 8, most important first), deeper for the top topics, one card per story.
  const BRIEF_MAX_SECTIONS = 8;
  const BRIEF_FALLBACK_MAX_HOURS = 720; // like core.brief_effective_window: reach back to the last good cards, at most 30 days
  const storyKey = (c: BlurbCard) => (c as { dedupe_key?: string }).dedupe_key ?? c.id; // server cards carry dedupe_key
  const briefLimit = (rank: number, top: number) => (rank <= 3 ? top : rank <= 5 ? 3 : 2);
  const brief = (requestedWindow: number): Brief => {
    const inWindow = (hours: number) => cards.filter((c) => Date.parse(c.sort_at) >= clock() - hours * 3_600_000);
    // 24 h (72 h on Monday, "since Friday"); weekly 168 h. Never empty: no card in the window = last good cards, flagged.
    const daily = requestedWindow !== 168;
    const win = daily ? dailyWindow(new Date(clock())) : { hours: 168, kind: 'week' as const };
    let window_hours = win.hours;
    let fallback = false;
    let as_of: string | null = null;
    if (inWindow(window_hours).length === 0) {
      const newest = cards.reduce((m, c) => Math.max(m, Date.parse(c.sort_at)), 0);
      if (newest > 0 && clock() - newest <= BRIEF_FALLBACK_MAX_HOURS * 3_600_000) {
        fallback = true;
        window_hours = Math.min(BRIEF_FALLBACK_MAX_HOURS, Math.max(window_hours, Math.ceil((clock() - newest) / 3_600_000) + 24));
      }
    }
    const inView = inWindow(window_hours);
    if (inView.length) as_of = new Date(inView.reduce((m, c) => Math.max(m, Date.parse(c.sort_at)), 0)).toISOString();
    const top = requestedWindow === 168 ? 8 : 6;
    const seen = new Set<string>();
    const rankedAll = inWindow(window_hours)
      .sort((a, b) => mockRankScore(b) - mockRankScore(a) || (a.id < b.id ? 1 : -1))
      .filter((c) => (seen.has(storyKey(c)) ? false : (seen.add(storyKey(c)), true)));
    // Markets section (migration 20261018040000_brief_email.sql): market cards leave the topic sections.
    // headline_cards still come from every topic (top card of the top 3 topics), as in the SQL.
    const marketCards = rankedAll.filter((c) => MARKET_CATEGORIES.has(c.category));
    const groupTopics = (list: BlurbCard[]) => {
      const groups = new Map<string, BlurbCard[]>();
      for (const c of list) groups.set(c.category, [...(groups.get(c.category) ?? []), c]); // each group is best-first
      return [...groups.entries()].sort((a, b) => mockRankScore(b[1][0]) - mockRankScore(a[1][0]) || b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    };
    const ranked = rankedAll.filter((c) => !MARKET_CATEGORIES.has(c.category));
    const topics = groupTopics(ranked).slice(0, BRIEF_MAX_SECTIONS);
    return {
      generated_at: new Date(clock()).toISOString(), window_hours, window_kind: win.kind, fallback, as_of,
      brief_date: new Date(clock()).toISOString().slice(0, 10),
      headline_cards: groupTopics(rankedAll).slice(0, 3).map(([, g]) => g[0]),
      sections: topics.map(([category, grouped], i) => ({
        category, slug: category, label: category, rank: i + 1, total: grouped.length, cards: grouped.slice(0, briefLimit(i + 1, top)),
      })),
      numbers: numbers.slice(0, 4),
      summary: ranked.length + marketCards.length > 0
        ? { text: `[SAMPLE] This is a sample ${requestedWindow === 168 ? 'weekly' : 'daily'} summary. The real one is written once a ${requestedWindow === 168 ? 'week' : 'day'} from the published cards.`, generated_at: new Date().toISOString(), model: 'sample' }
        : null,
      markets: { cards: marketCards.slice(0, 6), numbers: numbers.filter((n) => MARKET_SERIES.includes(n.series_id)).slice(0, 4), total: marketCards.length },
    };
  };
  const emptyMockBrief = (): Brief => ({ generated_at: new Date(0).toISOString(), window_hours: 24, headline_cards: [], sections: [], numbers: [] });
  // In-memory email subscriptions with the same answers as the RPCs (never reveals an existing address).
  type Sub = { email: string; token: string; status: 'pending' | 'active' | 'unsubscribed' } & BriefSubscriptionInput;
  const subs = new Map<string, Sub>();
  const attempts: { email: string; at: number }[] = [];
  const byToken = (t: string) => [...subs.values()].find((s) => s.token === t);
  // Signed-in "my subscriptions" in the sample app: one confirmed daily and one pending weekly to start.
  const mine: MyBriefSubscription[] = [
    { kind: 'daily', confirmed: true, hour: 7, tz: 'America/New_York' },
    { kind: 'weekly', confirmed: false, hour: 8, tz: 'America/New_York' },
  ];
  let tokenSeq = 0;
  const newToken = () => `00000000-0000-4000-8000-${(++tokenSeq).toString(16).padStart(12, '0')}`;
  return {
    subscriptions: () => [...subs.values()].map((s) => ({ ...s })), // for tests and the sample UI
    subscribeBrief(i: { email: string } & BriefSubscriptionInput): BriefSubscribeResult {
      const email = normalizeBriefEmail(i?.email);
      if (!email || !isValidBriefInput(i)) return { ok: false, status: 'invalid' };
      const now = Date.now();
      if (attempts.filter((a) => a.email === email && a.at > now - 86_400_000).length >= BRIEF_CAPS.perEmailPerDay
        || attempts.filter((a) => a.at > now - 3_600_000).length >= BRIEF_CAPS.globalPerHour) return { ok: false, status: 'limited' };
      attempts.push({ email, at: now });
      const old = subs.get(email);
      // Active stays active (settings unchanged until confirmed via its token); otherwise a fresh pending row.
      if (!old || old.status !== 'active') subs.set(email, { email, token: newToken(), status: 'pending', kind: i.kind, hour: i.hour, tz: i.tz });
      return { ok: true, status: 'pending' };
    },
    confirmBrief(token: string): BriefTokenResult {
      const s = byToken(token);
      if (!s || s.status === 'unsubscribed') return { ok: false };
      s.status = 'active';
      return { ok: true };
    },
    updateBriefSubscription(token: string, i: BriefSubscriptionInput): BriefTokenResult {
      const s = byToken(token);
      if (!s || s.status === 'unsubscribed' || !isValidBriefInput(i)) return { ok: false };
      Object.assign(s, { kind: i.kind, hour: i.hour, tz: i.tz });
      return { ok: true };
    },
    unsubscribeBrief(token: string): BriefTokenResult {
      const s = byToken(token);
      if (s) s.status = 'unsubscribed';
      return { ok: true }; // idempotent; unknown tokens look the same
    },
    mySubscriptions(): MyBriefSubscription[] {
      return mine.map((s) => ({ ...s }));
    },
    unsubscribeMine(kind: 'daily' | 'weekly'): MyBriefChangeResult {
      const i = mine.findIndex((s) => s.kind === kind);
      if (i >= 0) mine.splice(i, 1);
      return { ok: true, changed: i >= 0 };
    },
    updateMyTime(kind: 'daily' | 'weekly', hour: number, tz: string): MyBriefChangeResult {
      const s = mine.find((x) => x.kind === kind && x.confirmed);
      if (!s || !Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, changed: false };
      const changed = s.hour !== hour || s.tz !== tz;
      Object.assign(s, { hour, tz });
      return { ok: true, changed };
    },
    search(q: string, cursor?: string | null, limit = 20) {
      // Same quality-gated, placement-aware matching as api.search v4; the ranker owns matching and scoring.
      return page(rankSearch(cards, q, mockRankScore), cursor, limit);
    },
    relatedCards(cardId: string, limit = 5) {
      const source = cards.find((c) => c.id === cardId);
      if (!source) return [] as BlurbCard[];
      const tickers = new Set(source.tickers.map((t) => t.symbol.toLocaleLowerCase()));
      const series = new Set(source.macro.map((m) => m.series_id));
      const linked = sampleLinks.filter((l) => l.card_id === cardId || l.related_id === cardId).map((l) => ({ link: l, id: l.card_id === cardId ? l.related_id : l.card_id })).sort((a,b) => ["update","angle","related"].indexOf(a.link.kind) - ["update","angle","related"].indexOf(b.link.kind));
      const seen = new Set<string>();
      const linkedCards = linked.flatMap(({link,id}) => { const c=cards.find((x)=>x.id===id); if (!c || seen.has(id)) return []; seen.add(id); const related=cards.find((x)=>x.id===(link.card_id===cardId?link.card_id:link.related_id)); return [{...c,story_link:{kind:link.kind,related_id:related?.id ?? cardId,related_headline:related?.headline ?? source.headline}}]; });
      const overlaps = cards.filter((c) => c.id !== cardId && !seen.has(c.id) && (c.category === source.category || c.tickers.some((t) => tickers.has(t.symbol.toLocaleLowerCase())) || c.macro.some((m) => series.has(m.series_id))));
      return [...linkedCards,...overlaps].slice(0,limit);
    },
    followingFeed(f: { topics: string[]; sources: string[]; tickers: string[]; cursor?: string | null; limit?: number }) {
      const topics = new Set(f.topics.map((x) => x.toLocaleLowerCase()));
      const sources = new Set(f.sources.map((x) => x.toLocaleLowerCase()));
      // Same cap as api.following_feed (20261119000000_following_companies.sql): the first 100 distinct tickers.
      const tickers = new Set([...new Set(f.tickers.map((x) => x.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, FOLLOWED_TICKER_CAP));
      if (!topics.size && !sources.size && !tickers.size) return page([...cards].sort((a,b) => Date.parse(b.sort_at) + 8 * 3_600_000 * Math.log2(Math.max(b.importance ?? 1,0.1)) - Date.parse(a.sort_at) - 8 * 3_600_000 * Math.log2(Math.max(a.importance ?? 1,0.1))), f.cursor, f.limit);
      // A followed company also matches cards that mention it (company tags, same matcher as core.card_companies).
      const tags = companyTags();
      const mentioned = (c: BlurbCard) => (tags.get(c.id) ?? []).find((t) => tickers.has(t.ticker.toLocaleLowerCase()));
      const direct = cards.filter((c) => topics.has(c.category.toLocaleLowerCase()) || c.sources.some((s) => sources.has(s.name.toLocaleLowerCase())) || c.tickers.some((t) => tickers.has(t.symbol.toLocaleLowerCase())) || !!mentioned(c));
      const directIds = new Set(direct.map((c) => c.id));
      const linkedFollow = sampleLinks.flatMap((l) => { const follows=directIds.has(l.related_id)?l.related_id:directIds.has(l.card_id)?l.card_id:null; const id=follows===l.related_id?l.card_id:l.related_id; const c=cards.find((x)=>x.id===id); const target=cards.find((x)=>x.id===follows); return c&&target?[{...c,story_link:{kind:l.kind,related_id:target.id,related_headline:target.headline},follow_reason:l.kind==="update"?"Update to a story you follow":l.kind==="angle"?"Another angle on a story you follow":"Related to something you follow"}]:[]; });
      const linkedIds=new Set(linkedFollow.map(c=>c.id));
      const followedTickers = new Set(direct.flatMap((c) => c.tickers.map((t) => t.symbol.toLocaleLowerCase())));
      const related = cards.filter((c) => !directIds.has(c.id) && !linkedIds.has(c.id) && (c.tickers.some((t) => followedTickers.has(t.symbol.toLocaleLowerCase())) || direct.some((d) => d.category === c.category)));
      const freshness = (c: BlurbCard) => Math.pow(0.5, Math.max(0, Date.now() - Date.parse(c.sort_at)) / 43_200_000);
      const relevance = (c: BlurbCard, directMatch: boolean) => (directMatch ? 1 : 0.6) * freshness(c) * (c.importance ?? 1);
      const items = [
        ...direct.sort((a,b) => relevance(b,true)-relevance(a,true)).map((c): BlurbCard => {
          if (topics.has(c.category.toLocaleLowerCase())) return { ...c, follow_reason: `Because you follow ${c.category}`, follow_match: 'topic' };
          const own = c.tickers.find((t) => tickers.has(t.symbol.toLocaleLowerCase()));
          if (own) return { ...c, follow_reason: `Because you follow ${own.symbol}`, follow_match: 'ticker', follow_ticker: own.symbol };
          const src = c.sources.find((s) => sources.has(s.name.toLocaleLowerCase()));
          if (src) return { ...c, follow_reason: `Because you follow ${src.name}`, follow_match: 'source' };
          const m = mentioned(c);
          return m ? { ...c, follow_reason: `Because you follow ${m.ticker} (mentions ${m.short_name})`, follow_match: 'company', follow_ticker: m.ticker } : { ...c, follow_reason: 'Because you follow this story' };
        }),
        ...linkedFollow.sort((a,b) => ["update","angle","related"].indexOf(a.story_link!.kind) - ["update","angle","related"].indexOf(b.story_link!.kind)),
        ...related.sort((a,b) => relevance(b,false)-relevance(a,false)).map((c) => ({ ...c, follow_reason: `Related to ${c.tickers[0]?.symbol ?? c.category}` })),
      ];
      return page(items, f.cursor, f.limit);
    },
    dailyBrief: () => ((globalThis as { __ELEMENT_MOCK_EMPTY_BRIEF__?: boolean }).__ELEMENT_MOCK_EMPTY_BRIEF__ ? emptyMockBrief() : brief(24)), // the flag simulates a back end with no brief yet (e2e)
    weeklyBrief: () => ({ ...brief(168), movers: trends.slice(0, 4).map((t) => ({ ...t, points: [...t.points] })) }),
  };
}
