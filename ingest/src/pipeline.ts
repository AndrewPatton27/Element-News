// One ingest run over every source: macro numbers (FRED), Fed and BEA releases, Federal Register
// rules, SEC 8-Ks, Wikipedia "In the news", CPSC recalls, USGS earthquakes and NASA releases.
// All I/O is injected (fetchText, publisher, summarizers), so the same code runs
// live, in --dry-run from fixtures, and in tests.
// Inputs: Deps (fetcher, publisher, providers, usage counter, clock, log) and RunOptions (--only, --limit).
// Outputs: RunStats counts; cards and items are written through deps.publisher.

import { AsyncLocalStorage } from 'node:async_hooks';
import { config, fedRegisterUrls, groqDailyCap } from './config.ts';
import { createGuard, normalizeUrl } from './dedupe.ts';
import { buildPublishPayload, type Publisher } from './publish.ts';
import { beaItemToItem } from './sources/bea.ts';
import { cpscToItem, cpscUrl, parseCpscJson, selectRecalls } from './sources/cpsc.ts';
import { nasaFeedUrl, nasaToItem, parseNasaRss, selectNasaReleases } from './sources/nasa.ts';
import { parseUsgsGeoJson, usgsDraft, usgsToItem } from './sources/usgs.ts';
import { fetchPublisherText } from './publisherPage.ts';
import { isNearDuplicate, newsdataPayload, newsdataSummaryPayload, newsdataToItem, newsdataUrl, parseNewsdata, redactKey, relevanceScore, withPageText, type NewsdataEndpoint } from './sources/newsdata.ts';
import { parseWikiFeed, wikiFeedUrl, wikiItemToItem } from './sources/wiki.ts';
import { fedRegDocToItem, isAirworthinessDirective, mergeFedRegDocs, parseFedRegJson, type FrDoc } from './sources/fedreg.ts';
import { fedItemToItem, fedPageText, mergeFedItems, parseRss } from './sources/fed.ts';
import { fedSpeechToItem, selectFedSpeeches } from './sources/fedspeech.ts';
import { secPressToItem, selectSecPress } from './sources/secpress.ts';
import { runMacro, runTreasury } from './macroRun.ts';
import { runBeaData, runBls } from './agencyRun.ts';
import { runAuctions, runBlsCal, runCensus, runEia, runFomc, runMts, runAnnual, runBeige, runRegPress, runTrade } from './agencyRunData.ts';
import {
  classifySecEntry, displayCompanyName, isRoutine502, mergeSecEntries, parseSec8kAtom,
  dailyIndexUrls, isBoilerplateRegFd, isRegFdOnly, parseDailyIndex, parseSubmissionsJson, primaryItem, resolveWatchList, rotationSlice, type DailyIndexFiling, type Sec8kEntry, type SecSkipReason, type WatchMap,
} from './sources/sec.ts';
import { secFilingPageText } from './sec-text.ts';
import { createChainState, summarizeWithChain, type ChainState, type UsageCounter } from './summarizer/chain.ts';
import type { RawItem, Summarizer } from './types.ts';
import { hasFigures, requiresFigures, validatePublish } from './validate.ts';
import { createTopicFilterState, filterTopic, narrowCapReached, recordTopic, type TopicFilterState } from './topicFilter.ts';
import { baseScore, pickNext, softCap } from './selection.ts';
import { reviewCard, type CardScore, type ScoreClient } from './reportCard.ts';
import { aiDraftsRejected, decideReportCardRetry, decideSoftRetry } from './retry.ts';

export type SourceName = 'macro' | 'treasury' | 'fed' | 'fedspeech' | 'secpress' | 'bea' | 'fedreg' | 'sec' | 'wiki' | 'cpsc' | 'usgs' | 'nasa' | 'bls' | 'beadata'
  | 'eia' | 'census' | 'auctions' | 'fomc' | 'blscal' | 'mts' | 'beige' | 'trade' | 'regpress' | 'annual' | 'newsdata_market' | 'newsdata_latest';
export const SOURCE_NAMES: readonly SourceName[] = ['macro', 'treasury', 'fed', 'fedspeech', 'secpress', 'bea', 'fedreg', 'sec', 'wiki', 'cpsc', 'usgs', 'nasa', 'bls', 'beadata',
  'eia', 'census', 'auctions', 'fomc', 'blscal', 'mts', 'beige', 'trade', 'regpress', 'annual', 'newsdata_market', 'newsdata_latest'];

export interface Deps {
  /** GET a URL through the allowlist. `kind` picks the host list; ttl in minutes (0 = no cache). */
  fetchText(url: string, kind: 'page' | 'api' | 'publisher', ttlMinutes: number): Promise<string>;
  publisher: Publisher;
  providers: Summarizer[];
  counter: UsageCounter;
  fredApiKey: string | null;
  /** BLS / BEA data API keys and the BEA data switch (agencyRun.ts); all optional */
  keys?: { bls?: string | null; bea?: string | null; beaDataEnabled?: boolean; annualEnabled?: boolean; occEnabled?: boolean };
  /** EIA open data key (EIA_API_KEY) and optional Census key (CENSUS_API_KEY); null/undefined = that source skips */
  eiaApiKey?: string | null;
  censusApiKey?: string | null;
  /** NewsData.io link-out source (all optional): the key (NEWSDATA_API_KEY), the env switch (NEWSDATA_ENABLED=1) and the credit counter. No key or switch off = the source skips. */
  newsdata?: { apiKey?: string | null; enabled?: boolean | null; /** D-296: false = this source publishes nothing (default config.newsdata.summarize) */ summarize?: boolean; /** counts one credit; false = the daily cap is reached (default: deps.counter, cap config.newsdata.dailyCreditCap) */ takeCredit?: () => Promise<boolean> };
  now: Date;
  log(line: string): void;
  /** Report-card protocol overrides (tests, env flag): enabled replaces config.reportCard.protocolEnabled; scorer replaces the Groq provider. */
  reportCard?: { enabled?: boolean; scorer?: ScoreClient; /** the Groq scorer is skipped once counter.used('groq') reaches this (cards then publish unscored) */ scorerMaxGroqUsed?: number; /** at most this many cards are scored per run (cloud); the rest publish unscored. Unset = no limit (laptop) */ scorerMaxPerRun?: number };
  /** Candidate selection overrides (tests, flags): enabled replaces config.selection.enabled. */
  selection?: { enabled?: boolean };
}

export interface RunOptions {
  only?: SourceName[];
  limit?: number;                    // max news items summarized per run (all sources together)
}

export interface RunStats {
  published: number;
  duplicate: number;
  ticker_cap: number;
  skipped: number;
  failed: number;
  ai: number;
  template: number;
  macro: number;
  data_cards: number;
  report_pass: number;
  report_revise: number;
  report_abandon: number;
  report_duplicate: number;
  report_provider_gemini: number;
  report_unscored: number;
  report_scored: number;
  report_provider_groq: number;
  recall_material: number;        // CPSC cards published as material (shown in the feeds)
  recall_not_material: number;    // CPSC cards published as not material (Recalls & Safety topic only)
}

/** Per-run state passed to each source's runner (shared budget, dedupe guard and provider cooldowns). */
interface RunCtx {
  stats: RunStats;
  budget: { left: number };
  guard: ReturnType<typeof createGuard>;
  chain: ChainState;
}
/**
 * Mutable state of ONE runOnce call. It lives in an AsyncLocalStorage so two runs in the same process
 * (a warm Edge Function isolate can serve two requests at once) never share it.
 */
interface RunState {
  topic: TopicFilterState;
  /** Recent live cards for the protocol's duplicate/relation check: loaded once per run, grown with this run's cards. */
  recent: Array<{ id: string; headline: string; body: string | null }> | null;
  /** Set during a run with candidate selection on: processItems queues its job here instead of spending budget. */
  collector: Job[] | null;
}
const runStore = new AsyncLocalStorage<RunState>();
function runState(): RunState {
  const s = runStore.getStore();
  if (!s) throw new Error('pipeline state used outside runOnce');
  return s;
}
async function recentCards(deps: Deps) {
  const st = runState();
  if (!st.recent) {
    const all = await Promise.resolve(deps.publisher.auditCards?.()).catch(() => undefined) ?? [];
    const cutoff = deps.now.getTime() - config.reportCard.recentCardDays * 86_400_000;
    st.recent = all.filter((c) => Date.parse(c.as_of) >= cutoff).slice(0, config.reportCard.scoreMaxRecentCards).map((c) => ({ id: c.id, headline: c.headline, body: c.body }));
  }
  return st.recent;
}

/**
 * One ingest run. Sources run in a fixed order (macro, fed, bea, fedreg, sec, wiki, cpsc, usgs,
 * nasa); `opts.only` picks a subset and `opts.limit` (default 20) caps the news items summarized
 * across all sources. A failing source is logged and the run continues with the next one.
 */
export async function runOnce(deps: Deps, opts: RunOptions = {}): Promise<RunStats> {
  const select = deps.selection?.enabled ?? config.selection.enabled;
  // selection on: sources only collect; the budget is spent after all sources ran
  const state: RunState = { topic: createTopicFilterState(), recent: null, collector: select ? [] : null };
  return runStore.run(state, () => runOnceInState(deps, opts, state));
}

async function runOnceInState(deps: Deps, opts: RunOptions, state: RunState): Promise<RunStats> {
  const only = new Set<SourceName>(opts.only?.length ? opts.only : SOURCE_NAMES);
  const stats: RunStats = { published: 0, duplicate: 0, ticker_cap: 0, skipped: 0, failed: 0, ai: 0, template: 0, macro: 0, data_cards: 0, report_pass: 0, report_revise: 0, report_abandon: 0, report_duplicate: 0, report_provider_gemini: 0, report_unscored: 0, report_scored: 0, report_provider_groq: 0, recall_material: 0, recall_not_material: 0 };
  const ctx: RunCtx = {
    stats,
    budget: { left: opts.limit ?? 20 },
    guard: createGuard(),
    chain: createChainState(),                       // provider cooldowns after a 429 last for this run
  };

  if (only.has('macro')) await runMacro(deps, stats);
  if (only.has('treasury')) await runTreasury(deps, stats);
  if (only.has('bls')) await runBls(deps, stats);
  if (only.has('beadata')) await runBeaData(deps, stats);
  if (only.has('fed')) await runFed(deps, ctx);
  if (only.has('fedspeech')) await runFedSpeech(deps, ctx);
  if (only.has('secpress')) await runSecPress(deps, ctx);
  if (only.has('bea')) await runBea(deps, ctx);
  if (only.has('fedreg')) await runFedReg(deps, ctx);
  if (only.has('sec')) await runSec(deps, stats, ctx.budget, ctx.guard, ctx.chain);
  if (only.has('wiki')) await runWiki(deps, ctx);
  if (only.has('cpsc')) await runCpsc(deps, ctx);
  if (only.has('usgs')) await runUsgs(deps, stats, ctx.guard);
  if (only.has('nasa')) await runNasa(deps, ctx);
  if (only.has('eia')) await runEia(deps, stats);
  if (only.has('census')) await runCensus(deps, stats);
  if (only.has('auctions')) await runAuctions(deps, stats);
  if (only.has('fomc')) await runFomc(deps, stats);
  if (only.has('blscal')) await runBlsCal(deps, stats);
  if (only.has('mts')) await runMts(deps, stats);
  if (only.has('beige')) await runBeige(deps, stats);
  if (only.has('trade')) await runTrade(deps, stats);
  if (only.has('regpress')) await runRegPress(deps, stats);
  if (only.has('annual')) await runAnnual(deps, stats);
  if (only.has('newsdata_market')) await runNewsdata(deps, ctx, 'market');
  if (only.has('newsdata_latest')) await runNewsdata(deps, ctx, 'latest');
  if (state.collector) await runSelected(state.collector, deps, ctx, opts.limit ?? 20);
  deps.log(`report card: PASS ${stats.report_pass}, REVISE/rejected ${stats.report_revise}, ABANDON ${stats.report_abandon}, unscored ${stats.report_unscored}, DUPLICATE ${stats.report_duplicate}; scorers Gemini ${stats.report_provider_gemini}, Groq ${stats.report_provider_groq}`);
  return stats;
}

/** Federal Reserve press releases: RSS feeds + press-release page text (page host list). */
async function runFed(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    const lists: ReturnType<typeof parseRss>[] = [];
    for (const u of config.feeds.fedRss) lists.push(parseRss(await deps.fetchText(u, 'page', config.feedCacheTtlMinutes)));
    const items = mergeFedItems(lists, deps.now, config.fedMaxAgeDays).map(fedItemToItem);
    await processItems(items, deps, stats, budget, guard, chain, async (it) => fedPageText(await deps.fetchText(it.url, 'page', config.cacheTtlMinutes)));
  } catch (e) {
    deps.log(`fed: feed failed: ${(e as Error).message}`);
  }
}

/** Fed Board speeches and testimony: RSS (page host list, www.federalreserve.gov); the AI sees only the feed's title and description. */
async function runFedSpeech(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    const list = parseRss(await deps.fetchText(config.feeds.fedSpeechRss, 'page', config.feedCacheTtlMinutes));
    const items = selectFedSpeeches([list], deps.now).map(fedSpeechToItem);
    await processItems(items, deps, stats, budget, guard, chain, async () => '');
  } catch (e) {
    deps.log(`fedspeech: feed failed: ${(e as Error).message}`);
  }
}

/** SEC press releases: RSS (page host list, www.sec.gov); feed text only, 10-word copy limit. */
async function runSecPress(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    const list = parseRss(await deps.fetchText(config.feeds.secPressRss, 'page', config.feedCacheTtlMinutes));
    const items = selectSecPress(list, deps.now).map(secPressToItem);
    await processItems(items, deps, stats, budget, guard, chain, async () => '');
  } catch (e) {
    deps.log(`secpress: feed failed: ${(e as Error).message}`);
  }
}

/** BEA news releases. */
async function runBea(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    // RSS from apps.bea.gov (API host list); the summary uses only the feed text, no page fetch.
    const list = parseRss(await deps.fetchText(config.feeds.beaRss, 'api', config.feedCacheTtlMinutes));
    const items = mergeFedItems([list], deps.now, config.beaMaxAgeDays).map(beaItemToItem);
    await processItems(items, deps, stats, budget, guard, chain, async () => '');
  } catch (e) {
    deps.log(`bea: feed failed: ${(e as Error).message}`);
  }
}

/** Federal Register final rules: JSON API only (API host list), abstract-only AI text, no page fetch. */
async function runFedReg(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  const lists: FrDoc[][] = [];
  for (const u of fedRegisterUrls()) {
    try {
      lists.push(parseFedRegJson(await deps.fetchText(u, 'api', 0)));
    } catch (e) {
      deps.log(`fedreg: query failed (continuing): ${(e as Error).message}`);
    }
  }
  const docs = mergeFedRegDocs(lists, deps.now);
  const items: RawItem[] = [];
  for (const d of docs) {
    const r = fedRegDocToItem(d, deps.now);
    if ('item' in r) { items.push(r.item); continue; }
    stats.skipped++;
    deps.log(`skip ${r.skip}: Federal Register ${d.document_number}: ${d.title.slice(0, 80)}`);
  }
  deps.log(`fedreg: ${docs.length} documents in the last ${config.fedRegister.maxAgeDays} days, ${items.length} with an abstract`);
  // FAA airworthiness directives are near-identical aircraft fix orders: at most N NEW ones per run
  // (newest first). Directives an earlier run already handled do not use up the cap.
  await processItems(items, deps, stats, budget, guard, chain, async () => '', undefined, {
    group: {
      of: (it) => (isAirworthinessDirective(it.title) ? 'faa' : null),
      max: config.fedRegister.maxAirworthinessPerRun, skip: 'faa_directive_cap', label: 'airworthiness directive',
    },
  });
}

/**
 * Wikipedia "In the news": the feeds of the last config.wiki.lookbackDays UTC days (today first),
 * JSON API (API host list), story + extract only. A story that appears on several days is kept once
 * (same external_id or same article URL). A day whose feed fails or has no `news` list is logged and skipped.
 */
async function runWiki(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  const items: RawItem[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const perDay: string[] = [];
  for (let back = 0; back < config.wiki.lookbackDays; back++) {
    const day = new Date(deps.now.getTime() - back * 86_400_000);
    const label = day.toISOString().slice(0, 10);
    try {
      const news = parseWikiFeed(await deps.fetchText(wikiFeedUrl(deps.now, back), 'api', 0));
      let added = 0;
      for (const n of news) {
        const r = wikiItemToItem(n, day);          // a story without a date comment gets that feed day's date
        if (!('item' in r)) { stats.skipped++; deps.log(`skip ${r.skip}: Wikipedia story`); continue; }
        const url = normalizeUrl(r.item.url);
        if (seenIds.has(r.item.external_id) || seenUrls.has(url)) continue;     // same story on an earlier (newer) day
        seenIds.add(r.item.external_id);
        seenUrls.add(url);
        items.push(r.item);
        added++;
      }
      perDay.push(`${label}: ${news.length} stories, ${added} new to this run`);
    } catch (e) {
      perDay.push(`${label}: feed failed`);
      deps.log(`wiki: feed for ${label} failed: ${(e as Error).message}`);
    }
  }
  await processItems(items, deps, stats, budget, guard, chain, async () => '', undefined, {
    onDone: (p) => deps.log(`wiki: ${config.wiki.lookbackDays} days read (${perDay.join('; ')}); ${items.length} candidates, ${p.fresh} new, ${p.alreadyHandled} already handled`),
  });
}

/**
 * CPSC recalls: JSON API (API host list), the AI sees only the recall text in the JSON. All recalls in the
 * lookback window are candidates (newest first); the cap of config.cpsc.maxPerRun counts only NEW recalls,
 * so recalls an earlier run handled are skipped without using it and older unprocessed ones get their turn.
 */
async function runCpsc(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    const all = parseCpscJson(await deps.fetchText(cpscUrl(deps.now), 'api', 0));
    const picked = selectRecalls(all, deps.now);
    const items: RawItem[] = [];
    for (const r of picked) {
      const x = cpscToItem(r, deps.now);
      if ('item' in x) items.push(x.item);
      else { stats.skipped++; deps.log(`skip ${x.skip}: CPSC recall ${r.RecallNumber ?? ''}`); }
    }
    await processItems(items, deps, stats, budget, guard, chain, async () => '', undefined, {
      total: config.cpsc.maxPerRun,
      onDone: (p) => deps.log(`cpsc: ${all.length} recalls in the last ${config.cpsc.lookbackDays} days, ${items.length} candidates `
        + `(${items.filter((i) => i.material?.material).length} material), `
        + `${p.alreadyHandled} already handled, ${p.fresh} new processed (max ${config.cpsc.maxPerRun} new per run)`),
    });
  } catch (e) {
    deps.log(`cpsc: feed failed: ${(e as Error).message}`);
  }
}

/**
 * NASA news releases: RSS (API host list), release text from the feed only, no page fetch. Reads
 * config.nasa.feedPages pages of the feed (the feed holds only its 10 newest posts per page); an older page
 * that fails is logged and skipped. Only real news releases (link prefix) within config.nasa.maxAgeDays count.
 */
async function runNasa(deps: Deps, { stats, budget, guard, chain }: RunCtx): Promise<void> {
  try {
    const all = parseNasaRss(await deps.fetchText(nasaFeedUrl(1), 'api', 0));
    for (let page = 2; page <= config.nasa.feedPages; page++) {
      try {
        all.push(...parseNasaRss(await deps.fetchText(nasaFeedUrl(page), 'api', 0)));
      } catch (e) {
        deps.log(`nasa: feed page ${page} failed (continuing): ${(e as Error).message}`);
      }
    }
    const items = selectNasaReleases(all, deps.now).map((i) => nasaToItem(i, deps.now));
    await processItems(items, deps, stats, budget, guard, chain, async () => '', undefined, {
      onDone: (p) => deps.log(`nasa: ${all.length} feed items over ${config.nasa.feedPages} page(s), ${items.length} news releases in the last ${config.nasa.maxAgeDays} days, `
        + `${p.alreadyHandled} already handled, ${p.fresh} new`),
    });
  } catch (e) {
    deps.log(`nasa: feed failed: ${(e as Error).message}`);
  }
}

/**
 * NewsData.io link-out cards (rule 7). Three locks: the switch (config.newsdata.enabled or NEWSDATA_ENABLED=1), the key
 * (NEWSDATA_API_KEY) and, in the database, app_config.linkout_cards. Each run costs ONE credit, counted before the request
 * against config.newsdata.dailyCreditCap. No AI, no page fetch; only the headline, publisher and link are kept.
 */
async function runNewsdata(deps: Deps, { stats, guard, chain }: RunCtx, endpoint: NewsdataEndpoint): Promise<void> {
  const nd = deps.newsdata;
  const c = config.newsdata;
  const tag = `newsdata ${endpoint}`;
  if (!(nd?.enabled ?? c.enabled)) { deps.log(`${tag}: switched off, skipping`); return; }
  const key = nd?.apiKey?.trim();
  if (!key) { deps.log(`${tag}: NEWSDATA_API_KEY not set, skipping`); return; }
  // Degrade gracefully: near the daily cap the /latest calls stop first so the /market backbone keeps its credits.
  if (endpoint === 'latest' && deps.counter.used('newsdata') >= Math.floor(c.dailyCreditCap * c.latestStopFraction)) {
    deps.log(`${tag}: ${Math.round(c.latestStopFraction * 100)}% of the daily credits used, /latest paused`); return;
  }
  const take = nd?.takeCredit ?? (async () => {
    if (deps.counter.used('newsdata') >= c.dailyCreditCap) return false;
    deps.counter.add('newsdata');
    return true;
  });
  if (!(await take())) { deps.log(`${tag}: daily credit cap ${c.dailyCreditCap} reached, skipping`); return; }
  try {
    const articles = parseNewsdata(await deps.fetchText(newsdataUrl(endpoint, key), 'api', 0));
    const seen: string[] = [];                       // headlines of this run's new cards (the same story from two publishers)
    let recent: string[] | null = null;              // headlines of live cards, loaded once and only if a candidate gets that far
    let fresh = 0;
    let skipped = 0;
    // D-296: no AI provider (or summaries switched off) = nothing can be published from this source
    if (!(nd?.summarize ?? c.summarize) || !deps.providers.some((p) => p.usesAi)) { deps.log(`${tag}: no AI summarizer available, nothing published`); return; }
    let aiLeft = c.aiPerRun;                          // summaries (page fetch + AI call) this run; the rest wait for the next run
    // best relevance first, then newest: with a per-run cap and the release queue, the important headlines go first
    const scored = articles.map((a) => ({ a, s: relevanceScore(a) })).sort((x, y) => y.s - x.s || y.a.pubDate.localeCompare(x.a.pubDate));
    for (const { a } of scored) {
      if (fresh >= c.maxPerRun || aiLeft <= 0) break;
      const r = newsdataToItem(a, deps.now);
      if (!('item' in r)) { skipped++; continue; }
      const it = r.item;
      const cand = { url: it.url, tickers: it.tickers.map((t) => t.symbol), sortAt: new Date(it.published_at) };
      const d = guard.check(cand);
      if (!d.ok) { stats.skipped++; continue; }
      if (!recent) {
        try { recent = (await Promise.resolve(deps.publisher.recentHeadlines?.())) ?? []; } catch { recent = []; }
      }
      if (isNearDuplicate(it.title, [...seen, ...recent])) { stats.skipped++; deps.log(`skip duplicate_story: ${it.title}`); continue; }
      let row: ItemRow;
      try {
        row = await deps.publisher.upsertItem(it);
      } catch (e) {
        stats.failed++;
        deps.log(`failed: record item: ${redactKey((e as Error).message, key)}`);
        continue;
      }
      if (!row.is_new && row.status !== 'new') { stats.skipped++; continue; }
      fresh++;
      try {
        // D-296: a link-out card is published only with a full summary (body + key points) written from the publisher page.
        // No usable page, a rejected or low-relevance draft, or a draft without key points = nothing is published and the item
        // is closed as skipped (it would only repeat the same result next run).
        aiLeft--;
        const text = await fetchPublisherText(it.url, { fetchText: (u) => deps.fetchText(u, 'publisher', 0), log: deps.log });
        if (!text) { await skipNoSummary(deps, stats, row.id, it.title, 'no_page_text'); continue; }
        const r = await summarizeWithChain({ item: withPageText(it), text }, deps.providers, deps.counter, {
          state: chain, minRelevance: config.minEverydayRelevance, requireRelevance: true,
        });
        if (!r.ai_generated || r.low_relevance) {
          await skipNoSummary(deps, stats, row.id, it.title, r.low_relevance ? 'low_relevance' : 'summary_rejected', chainNote(r.log));
          continue;
        }
        const payload = newsdataSummaryPayload(it, r.draft, { itemId: row.id, model: r.model });
        if (!payload.body || (payload.detail?.key_points.length ?? 0) < config.detail.minKeyPoints) {
          await skipNoSummary(deps, stats, row.id, it.title, 'no_key_points', chainNote(r.log));   // the key points failed their checks and were dropped
          continue;
        }
        const v = validatePublish(payload, { linkOutEnabled: true });
        if (!v.ok) throw new Error(v.errors.join('; '));
        const res = await deps.publisher.publishBlurb(payload);
        stats[res.status === 'published' ? 'published' : res.status]++;
        if (res.status === 'published') { guard.record(cand); seen.push(it.title); }
        deps.log(`${res.status} [link_out+summary] ${payload.headline}`);
      } catch (e) {
        stats.failed++;
        const msg = redactKey((e as Error).message, key);
        deps.log(`failed: ${it.url}: ${msg}`);
        // Database flag off (linkout_cards false): leave the item 'new' so it publishes once Drew flips the flag.
        if (!/link_out cards are disabled/.test(msg)) await deps.publisher.setItemStatus(row.id, 'failed', msg).catch(() => {});
      }
    }
    deps.log(`${tag}: ${articles.length} articles, ${skipped} filtered out (not finance, recall/micro, advice, old), ${fresh} new`);
  } catch (e) {
    deps.log(`${tag}: request failed: ${redactKey((e as Error).message, key)}`);
  }
}

/** A link-out item that cannot get a full summary: logged and closed (status skipped), nothing published. */
async function skipNoSummary(deps: Deps, stats: RunStats, itemId: string, title: string, reason: string, note = ''): Promise<void> {
  stats.skipped++;
  deps.log(`skip ${reason} (link-out needs a full summary): ${title}${note ? `  [${note}]` : ''}`);
  await deps.publisher.setItemStatus(itemId, 'skipped', reason).catch(() => {});
}

/** USGS significant earthquakes: template cards only (no AI call, no page fetch). */
async function runUsgs(deps: Deps, stats: RunStats, guard: ReturnType<typeof createGuard>): Promise<void> {
  try {
    const features = parseUsgsGeoJson(await deps.fetchText(config.usgs.url, 'api', 0));
    let n = 0;
    for (const f of features) {
      const r = usgsToItem(f, deps.now);
      if (!('item' in r)) {
        if (r.skip !== 'too_old') { stats.skipped++; deps.log(`skip ${r.skip}${'note' in r && r.note ? ` (${r.note})` : ''}: USGS ${f.id}`); }
        continue;
      }
      const it = r.item;
      n++;
      const cand = { url: it.url, tickers: [], sortAt: new Date(it.published_at) };
      const d = guard.check(cand);
      if (!d.ok) { stats.skipped++; deps.log(`skip ${d.reason}: ${it.title}`); continue; }
      // narrow-source cap (config.reportCard.narrowSourceCaps.usgs_quake = 1 new card per run); the rest wait for the next run
      if (narrowCapReached(it, runState().topic)) { stats.skipped++; deps.log(`skip report_card_variety_cap: ${it.title}`); continue; }
      let row: ItemRow;
      try {
        row = await deps.publisher.upsertItem(it);
      } catch (e) {                                  // one bad row must not end the USGS run
        stats.failed++;
        deps.log(`failed: record item ${it.url}: ${(e as Error).message}`);
        continue;
      }
      if (!row.is_new && row.status !== 'new') { stats.skipped++; continue; }
      recordTopic(it, runState().topic);
      try {
        const payload = buildPublishPayload(it, usgsDraft(it), { itemId: row.id, aiGenerated: false, model: null });
        const v = validatePublish(payload);
        if (!v.ok) throw new Error(v.errors.join('; '));
        const res = await deps.publisher.publishBlurb(payload);
        stats[res.status === 'published' ? 'published' : res.status]++;
        if (res.status === 'published') { stats.template++; guard.record(cand); }
        deps.log(`${res.status} [template] ${payload.headline}`);
      } catch (e) {
        stats.failed++;
        deps.log(`failed: ${it.url}: ${(e as Error).message}`);
        await deps.publisher.setItemStatus(row.id, 'failed', (e as Error).message).catch(() => {});
      }
    }
    deps.log(`usgs: ${features.length} significant earthquakes this week, ${n} within ${config.usgs.maxAgeDays} days`);
  } catch (e) {
    deps.log(`usgs: feed failed: ${(e as Error).message}`);
  }
}

/**
 * SEC 8-Ks for watch-list companies: resolve the watch list, merge the current 8-K feed with
 * per-company filing lists, classify each filing (no page fetch yet), then summarize the
 * candidates from the primary filing document. Director-only 5.02s are skipped before any AI call.
 */
async function runSec(
  deps: Deps, stats: RunStats, budget: { left: number }, guard: ReturnType<typeof createGuard>, chain: ChainState,
): Promise<void> {
  try {
    // Watch list: the household-name directory plus the extended large-cap list (config.secExtraWatch). CIKs come from
    // SEC's ticker list; without it there is no way to tell which filings are watched, so the SEC source is skipped this run.
    const base: readonly string[] = config.watchCompanies;
    const allWatch = [...base, ...config.secExtraWatch.filter((t) => !base.includes(t))];
    let watch: WatchMap;
    try {
      const w = resolveWatchList(await deps.fetchText(config.secTickersUrl, 'page', config.cacheTtlMinutes), allWatch);
      watch = w.map;
      deps.log(`sec: watch list ${w.map.size} of ${allWatch.length} companies resolved`
        + (w.missing.length ? `; not in the SEC ticker list (skipped): ${w.missing.join(', ')}` : ''));
    } catch (e) {
      deps.log(`sec: ticker list unavailable, skipping SEC this run (watch list needs CIKs): ${(e as Error).message}`);
      return;
    }
    const lists: Sec8kEntry[][] = [];
    try {
      lists.push(parseSec8kAtom(await deps.fetchText(config.feeds.sec8k, 'page', config.feedCacheTtlMinutes)));
    } catch (e) {
      deps.log(`sec: current 8-K feed failed (continuing with per-company lists): ${(e as Error).message}`);
    }
    // Which companies' own filing lists to read (data.sec.gov, API host list; the shared limiter keeps us under 5 req/s):
    // the CIKs with a new filing in the EDGAR daily index, plus a rotating safety slice (config.secIndex).
    const listCiks = new Set<string>();
    try {
      for (const cik of await newFilingCiks(deps, watch)) listCiks.add(cik);
    } catch (e) {
      deps.log(`sec: daily index step failed (rotation only): ${(e as Error).message}`);
    }
    const fromIndex = listCiks.size;
    for (const cik of rotationSlice([...watch.keys()], deps.now)) listCiks.add(cik);
    deps.log(`sec: reading ${listCiks.size} company filing lists (${fromIndex} with a new filing in the daily index, rest rotation)`);
    let failedLists = 0;
    for (const cik of listCiks) {
      try {
        lists.push(parseSubmissionsJson(await deps.fetchText(config.secSubmissionsUrl.replace('{cik}', cik), 'api', 0), deps.now));
      } catch {
        failedLists++;
      }
    }
    if (failedLists) deps.log(`sec: per-company filing list unavailable for ${failedLists} of ${listCiks.size} companies`);
    const entries = mergeSecEntries(lists);
    const items: RawItem[] = [];
    const notCandidates: Partial<Record<SecSkipReason, number>> = {};
    for (const e of entries) {
      const r = classifySecEntry(e, null, { watch });
      if ('item' in r) { items.push(r.item); continue; }
      notCandidates[r.skip] = (notCandidates[r.skip] ?? 0) + 1;
      if (r.skip === 'low_value') {                  // counted as skipped: no page fetch, no AI call
        stats.skipped++;
        deps.log(`skip low_value (items ${e.items.map((i) => i.number).join(', ')}): ${displayCompanyName(e.company_raw)} 8-K`);
      }
    }
    const why = Object.entries(notCandidates).map(([k, n]) => `${k} ${n}`).join(', ');
    deps.log(`sec: ${entries.length} filings (feed + watch list), ${items.length} card candidates${why ? ` (not candidates: ${why})` : ''}`);
    await processItems(items, deps, stats, budget, guard, chain, (it) => secFilingPageText(deps.fetchText, it, deps.log),
      (it, text) => (isRoutine502(it.items ?? [], text) ? 'routine_5.02' : isBoilerplateRegFd(it.items ?? [], text) ? 'boilerplate_regfd' : null),
      // Reg FD / other-events filings cost AI calls with a low hit rate: at most config.secRegFd.maxPerRun new ones per run.
      { group: { of: (it) => (isRegFdOnly(it.items ?? []) ? 'regfd' : null), max: config.secRegFd.maxPerRun, skip: 'regfd_cap', label: 'Reg FD filings' } });
  } catch (e) {
    deps.log(`sec: feed failed: ${(e as Error).message}`);
  }
}

/**
 * CIKs of watched companies that filed an 8-K in the EDGAR daily index (last config.secIndex.days days) which the database
 * has not handled yet (api.items_handled), newest day first, at most config.secIndex.maxNewCiksPerRun. A missing day (weekend,
 * holiday, file not published yet) is a 404 and is skipped. No handledUrls on the publisher = every watched filing counts.
 */
async function newFilingCiks(deps: Deps, watch: WatchMap): Promise<string[]> {
  const filings: DailyIndexFiling[] = [];
  let read = 0;
  for (const url of dailyIndexUrls(deps.now)) {
    try {
      const text = await deps.fetchText(url, 'page', config.secIndex.cacheTtlMinutes);
      filings.push(...parseDailyIndex(text).filter((f) => watch.has(f.cik)));
      read++;
    } catch (e) {
      deps.log(`sec: daily index not available (${url.slice(-18)}): ${(e as Error).message.slice(0, 80)}`);
    }
  }
  let fresh = filings;
  const fn = deps.publisher.handledUrls;
  if (fn && filings.length) {
    try {
      const handled = await fn.call(deps.publisher, filings.map((f) => f.url));
      fresh = filings.filter((f) => !handled.has(f.url));
    } catch (e) {
      deps.log(`sec: handled-items check failed for the daily index (reading all): ${(e as Error).message}`);
    }
  }
  const ciks = [...new Set(fresh.map((f) => f.cik))].slice(0, config.secIndex.maxNewCiksPerRun);
  deps.log(`sec: daily index ${read} days read, ${filings.length} watched 8-Ks, ${fresh.length} not handled yet, ${ciks.length} companies to read`);
  return ciks;
}

interface ItemRow { id: string; is_new: boolean; status: string; status_note?: string | null }

/** One source's candidates plus everything handleItem needs; counters are per job (per source run). */
interface Job {
  items: RawItem[];
  deps: Deps;
  stats: RunStats;
  budget: { left: number };
  guard: ReturnType<typeof createGuard>;
  chain: ChainState;
  pageText: (it: RawItem) => Promise<string>;
  preCheck: (it: RawItem, text: string) => string | null;
  limits: NewLimits;
  fresh: number;
  alreadyHandled: number;
  perGroup: Map<string, number>;
}

/**
 * Candidate selection. Step 1 (per job, no AI): dedupe/ticker guard, topic filter and the already-handled check
 * (upsert) drop what cannot become a card. Step 2: score what is left without AI (importance, freshness) and spend
 * the budget in score order with a per-source soft cap (config.selection). Every per-item guard in handleItem
 * (ticker cap, group caps, narrow-source cap, new-item totals, copy limits, report card) still runs at spend time.
 */
async function runSelected(jobs: Job[], deps: Deps, ctx: RunCtx, budgetTotal: number): Promise<void> {
  const cands: Array<{ source: string; score: number; job: Job; it: RawItem; row: ItemRow }> = [];
  for (const job of jobs) {
    await dropHandled(job);
    let newHere = 0;
    const groupNew = new Map<string, number>();
    for (const it of job.items) {
      if (job.limits.total !== undefined && newHere >= job.limits.total) { deps.log(`new-item limit reached (${job.limits.total} new per run)`); break; }
      const cand = { url: it.url, tickers: it.tickers.map((t) => t.symbol), sortAt: new Date(it.published_at) };
      const d = ctx.guard.check(cand);
      if (!d.ok) { deps.log(`skip ${d.reason}: ${it.title}`); ctx.stats.skipped++; continue; }
      const topicReject = filterTopic(it, runState().topic);
      if (topicReject) { ctx.stats.skipped++; deps.log(`skip ${topicReject}: ${it.title.slice(0, 100)}`); continue; }
      const lg = job.limits.group;
      const group = lg?.of(it) ?? null;
      if (lg && group !== null && (groupNew.get(group) ?? 0) >= lg.max) {           // group cap counts NEW items only, so capped ones are not even recorded
        ctx.stats.skipped++;
        deps.log(`skip ${lg.skip} (max ${lg.max} ${lg.label} per run): ${it.title.slice(0, 80)}`);
        continue;
      }
      let row: ItemRow;
      try {
        row = await deps.publisher.upsertItem(it);
      } catch (e) {                                  // one bad row must not end this source's run
        ctx.stats.failed++;
        deps.log(`failed: record item ${it.url}: ${(e as Error).message}`);
        continue;
      }
      if (!row.is_new && row.status !== 'new') { ctx.stats.skipped++; job.alreadyHandled++; continue; }   // handled in an earlier run
      if (group !== null) groupNew.set(group, (groupNew.get(group) ?? 0) + 1);
      newHere++;
      cands.push({ source: it.source, score: baseScore(it, deps.now), job, it, row });
    }
  }
  const cap = softCap(budgetTotal);
  const spent = new Map<string, number>();
  const bySource = new Map<string, number>();
  for (const c of cands) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  deps.log(`selection: ${cands.length} candidates (${[...bySource].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), budget ${budgetTotal}, per-source soft cap ${cap}`);
  while (cands.length) {
    if (ctx.budget.left <= 0) { deps.log('limit reached'); break; }
    const i = pickNext(cands, spent, cap);
    const [c] = cands.splice(i, 1);
    if (c.job.limits.total !== undefined && c.job.fresh >= c.job.limits.total) continue;   // that source's own new-item cap is full
    const before = ctx.budget.left;
    await handleItem(c.job, c.it, c.row);
    const used = before - ctx.budget.left;
    if (used > 0) spent.set(c.source, (spent.get(c.source) ?? 0) + used);
  }
  for (const job of jobs) job.limits.onDone?.({ fresh: job.fresh, alreadyHandled: job.alreadyHandled });
  deps.log(`selection: picked ${[...spent].map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}`);
}

/**
 * Limits on how many NEW items one processItems call works on. "New" = not handled by an earlier run
 * (the same check as the `is_new`/status test after `upsertItem`), so items already published or
 * closed never use up a cap and each run moves on to the next unprocessed item.
 */
export interface NewLimits {
  /** At most this many new items in this call; later items are not even recorded. */
  total?: number;
  /** At most `max` new items per group (`of` returns the group key, null = no group). The rest are skipped with `skip <skip>`. */
  group?: { of(it: RawItem): string | null; max: number; skip: string; label: string };
  /** Called once the job's items are worked through (at once, or after candidate selection) with its final counts. */
  onDone?: (p: { fresh: number; alreadyHandled: number }) => void;
}

/**
 * Turns candidate items into published cards, one at a time. Outline per item:
 *   1. stop when the run's budget or the new-item total (limits.total) is used up
 *   2. dedupe / ticker-cap guard (before any network or AI call); group cap (limits.group) on new items
 *   3. record the item; skip it if an earlier run already handled it (does not count towards any cap)
 *   4. fetch page text (failure = feed text only)
 *   5. source-specific preCheck (e.g. routine 5.02) -> skipped
 *   6. summarizer chain -> low relevance (skipped) / earnings card without figures (skipped, no_figures) /
 *      template not allowed (skipped)
 *   7. build payload, validate, publish, count and log
 * Any error in 6-7 marks the item failed and the loop continues.
 * Returns how many items were new (worked on) and how many an earlier run had already handled.
 */
async function processItems(
  items: RawItem[],
  deps: Deps,
  stats: RunStats,
  budget: { left: number },
  guard: ReturnType<typeof createGuard>,
  chain: ChainState,
  pageText: (it: RawItem) => Promise<string>,
  // Checked after the page text is fetched and before any AI call: a reason string skips the item.
  preCheck: (it: RawItem, text: string) => string | null = () => null,
  limits: NewLimits = {},
): Promise<{ fresh: number; alreadyHandled: number }> {
  const job: Job = { items, deps, stats, budget, guard, chain, pageText, preCheck, limits, fresh: 0, alreadyHandled: 0, perGroup: new Map() };
  const collector = runState().collector;
  if (collector) { collector.push(job); return { fresh: 0, alreadyHandled: 0 }; }   // candidate selection: spent later by runSelected
  await dropHandled(job);
  for (const it of job.items) {
    if (budget.left <= 0) { deps.log('limit reached'); break; }
    if (limits.total !== undefined && job.fresh >= limits.total) {
      deps.log(`new-item limit reached (${limits.total} new per run)`);
      break;
    }
    await handleItem(job, it, null);
  }
  limits.onDone?.({ fresh: job.fresh, alreadyHandled: job.alreadyHandled });
  return { fresh: job.fresh, alreadyHandled: job.alreadyHandled };
}

/**
 * One database call for the whole candidate list (publisher.handledUrls): items an earlier run already finished are
 * counted as skipped + alreadyHandled and removed from job.items, so they cost no per-item upsert round trip. Before
 * this an SEC run spent its 100 s time budget on about 340 such upserts and stopped with 180 filings unvisited (R-300).
 * Same outcome as the per-item check in handleItem, which still runs for everything left. No handledUrls, or a failure
 * of the call = nothing is dropped (the per-item check decides).
 */
async function dropHandled(job: Job): Promise<void> {
  const fn = job.deps.publisher.handledUrls;
  if (!fn || job.items.length < 2) return;
  let handled: Set<string>;
  try {
    handled = await fn.call(job.deps.publisher, job.items.map((i) => i.url));
  } catch (e) {
    job.deps.log(`handled-items check failed (checking item by item): ${(e as Error).message}`);
    return;
  }
  if (!handled.size) return;
  const keep = job.items.filter((i) => !handled.has(i.url));
  const dropped = job.items.length - keep.length;
  job.stats.skipped += dropped;
  job.alreadyHandled += dropped;
  job.items = keep;
}

/** One candidate item through steps 2-7 of processItems. `known` = the item row when the selection step already recorded it. */
async function handleItem(job: Job, it: RawItem, known: ItemRow | null): Promise<void> {
  const { deps, stats, budget, guard, chain, pageText, preCheck, limits, perGroup } = job;
  const cand = { url: it.url, tickers: it.tickers.map((t) => t.symbol), sortAt: new Date(it.published_at) };
  const d = guard.check(cand);
  if (!d.ok) { deps.log(`skip ${d.reason}: ${it.title}`); stats.skipped++; return; }
  const topicReject = filterTopic(it, runState().topic);
  if (topicReject) {
    stats.skipped++;
    deps.log(`skip ${topicReject}: ${it.title.slice(0, 100)}`);
    return;
  }
  const group = limits.group?.of(it) ?? null;
  if (group !== null && limits.group && (perGroup.get(group) ?? 0) >= limits.group.max) {
    stats.skipped++;
    deps.log(`skip ${limits.group.skip} (max ${limits.group.max} ${limits.group.label} per run): ${it.title.slice(0, 80)}`);
    return;
  }

  let row: ItemRow;
  try {
    row = known ?? await deps.publisher.upsertItem(it);
  } catch (e) {                                      // one bad row must not end this source's run
    stats.failed++;
    deps.log(`failed: record item ${it.url}: ${(e as Error).message}`);
    return;
  }
  if (!known && !row.is_new && row.status !== 'new') { stats.skipped++; job.alreadyHandled++; return; }   // handled in an earlier run
  job.fresh++;
  recordTopic(it, runState().topic);
  if (group !== null) perGroup.set(group, (perGroup.get(group) ?? 0) + 1);

  let text = it.summary_text;
  try {
    const page = await pageText(it);
    if (page) text = `${it.summary_text}\n\n${page}`.slice(0, config.sourceTextMaxChars);
  } catch (e) {
    deps.log(`page text unavailable (feed text only): ${it.url}: ${(e as Error).message}`);
  }

  const pre = preCheck(it, text);
  if (pre) {
    stats.skipped++;
    deps.log(`skip ${pre}: ${it.title}`);
    await deps.publisher.setItemStatus(row.id, 'skipped', pre).catch(() => {});
    return;
  }

  budget.left--;
  try {
    const r = await summarizeWithChain({ item: it, text }, deps.providers, deps.counter, {
      state: chain, minRelevance: config.minEverydayRelevance, requireRelevance: true,   // caps and pacing per provider
    });
    if (r.low_relevance) {
      // Scored too low by the AI (one call spent, nothing published). The score is kept in ingest.items.status_note.
      stats.skipped++;
      deps.log(`skip low_relevance (${r.relevance}): ${it.title}`);
      await deps.publisher.setItemStatus(row.id, 'skipped', `low_relevance (${r.relevance})`).catch(() => {});
      return;
    }
    if (requiresFigures(it) && !hasFigures(r.draft.body)) {
      // An earnings card without a single figure (the AI could not find any, or only the template was left)
      // is never published. If an AI draft was tried and rejected for it, retrying later would repeat the
      // same result, so the item is closed; if no AI was available, it stays 'new' for a later run.
      stats.skipped++;
      deps.log(`skip no_figures (earnings card without figures, ${r.ai_generated ? 'AI' : r.provider}): ${it.title}  [${chainNote(r.log)}]`);
      if (r.log.some((l) => /no_figures/.test(l))) await deps.publisher.setItemStatus(row.id, 'skipped', 'no_figures').catch(() => {});
      else await softRetry(deps, row, 'no_figures', r.log, it.title);
      return;
    }
    if (!r.ai_generated && !templateAllowed(it)) {
      stats.skipped++;
      // Item status stays 'new' (a later run with a working AI provider retries it), but only max softRetry.maxFailures times
      // when AI drafts were tried and rejected: before, one such item re-spent 4 AI calls every hour for ever (R-300).
      deps.log(`skip template_not_allowed (no AI relevance score): ${it.title}  [${chainNote(r.log)}]`);
      await softRetry(deps, row, 'template_not_allowed', r.log, it.title);
      return;
    }
    let payload = buildPublishPayload(it, r.draft, { itemId: row.id, aiGenerated: r.ai_generated, model: r.model });
    const v = validatePublish(payload);
    if (!v.ok) throw new Error(v.errors.join('; '));
    let cardScore: CardScore | null = null;
    // Report-card protocol (config.reportCard.protocolEnabled, OFF by default; REPORT_CARD_PROTOCOL=1 or
    // deps.reportCard turns it on): the writer (Gemini, else Groq via the chain) wrote the card, Groq scores it,
    // one revision on REVISE, ABANDON/DUPLICATE are not published. Template cards are not scored.
    const protocolOn = deps.reportCard?.enabled ?? config.reportCard.protocolEnabled;
    const scorer = deps.reportCard?.scorer ?? ((): ScoreClient | null => {
      const g = deps.providers.find((p) => p.name === 'groq' && typeof p.generate === 'function');
      const stop = deps.reportCard?.scorerMaxGroqUsed;
      if (g && stop !== undefined && deps.counter.used('groq') >= stop) return null;   // Groq calls are reserved for writing and the Brief
      const perRun = deps.reportCard?.scorerMaxPerRun;
      if (g && perRun !== undefined && stats.report_scored >= perRun) return null;           // per-run cap: the rest publish unscored
      if (!g) return null;
      const cap = g.dailyCap ?? groqDailyCap();
      if (deps.counter.used('groq') >= cap) return null;                                     // Groq's daily cap: publish unscored
      // Every scorer request counts against Groq's daily cap like a writing call (laptop: state/ai-usage.json).
      return {
        generate: (prompt: string) => {
          if (deps.counter.used('groq') >= cap) return Promise.reject(new Error(`groq: daily cap ${cap} reached`));
          deps.counter.add('groq');
          return g.generate!(prompt, { onExtraCall: () => deps.counter.add('groq') });
        },
      };
    })();
    if (protocolOn && r.ai_generated && scorer) {
      stats.report_scored++;
      const recent = await recentCards(deps);
      const candidate = { id: row.id, ai_generated: payload.ai_generated, as_of: payload.as_of, sources: [{ name: it.source_name, url: it.url }] } as any;
      const writer = deps.providers.find((p) => p.name === r.provider && p.usesAi) ?? deps.providers.find((p) => p.usesAi);
      const rv = await reviewCard({
        client: scorer, card: candidate, payload, recent,
        // The rewrite goes through the chain with only the writer and one attempt, so it is counted against the
        // writer's daily cap and runs every draft check of the first draft (shape, relevance score, advice words,
        // numbers and tickers in the source, product codes, copy limits, repetition, length trim, detail checks).
        // A rewrite that fails them (or no AI draft at all) throws: reviewCard gives 'revise_failed', not published.
        rewrite: async (recs) => {
          if (!writer) throw new Error('writer unavailable');
          const retryErrors = recs.length ? recs : ['report card: fix the lowest-scored parts using only the source text'];
          const r2 = await summarizeWithChain({ item: it, text, retryErrors }, [writer], deps.counter, {
            state: chain, requireRelevance: true, maxAttempts: 1,
          });
          if (!r2.ai_generated) throw new Error(`rewrite rejected: ${r2.log.join(' | ')}`);
          const d2 = r2.draft;
          const p2 = buildPublishPayload(it, d2, { itemId: row.id, aiGenerated: true, model: r2.model ?? writer.model ?? null });
          const v2 = validatePublish(p2);
          if (!v2.ok) throw new Error(v2.errors.join('; '));
          if (requiresFigures(it) && !hasFigures(p2.body)) throw new Error('no_figures');
          return p2;
        },
      });
      stats.report_provider_groq += rv.scoreCalls;
      if (rv.revised) stats.report_revise++;
      cardScore = rv.score;
      if (rv.verdict === 'unscored') {
        // Fail open: the scorer failed (rate limit, bad JSON), not the card. rv.payload already passed
        // validatePublish (the revised one if the failure came on the re-score), so it publishes like a
        // cutoff card, with the AI-generated label. Leaving it 'new' only re-spent Groq calls every hour.
        payload = rv.payload;
        stats.report_unscored++;
        deps.log(`report_card_unscored, publishing unscored (${rv.error ?? 'no score'}): ${it.title}`);
      } else if (rv.verdict !== 'publish') {
        if (rv.verdict === 'duplicate') stats.report_duplicate++;
        stats.report_abandon++;
        const code = rv.verdict === 'duplicate' ? 'duplicate_story' : rv.verdict === 'abandon' ? 'report_card_abandon' : 'report_card_revise_failed';
        stats.skipped++;
        if (rv.verdict === 'duplicate') {
          deps.log(`skip ${code}: ${it.title}`);
          await deps.publisher.setItemStatus(row.id, 'skipped', code).catch(() => {});
        } else {
          // ABANDON or a rewrite that failed its checks may be transient: keep the item retryable (status 'new', counter in
          // status_note), skip it for good only after config.reportCard.maxRetries failures (src/retry.ts).
          const d = decideReportCardRetry(row.status_note, code);
          deps.log(`skip ${code} (failure ${d.failures} of ${config.reportCard.maxRetries}, ${d.status === 'new' ? 'will retry' : 'final'}): ${it.title}`);
          await deps.publisher.setItemStatus(row.id, d.status, d.note).catch(() => {});
        }
        return;
      } else {
        payload = rv.payload;
        stats.report_pass++;
      }
    }
    const res = await deps.publisher.publishBlurb(payload);
    stats[res.status === 'published' ? 'published' : res.status]++;
    if (res.status === 'published') {
      stats[r.ai_generated ? 'ai' : 'template']++;
      guard.record(cand);
      if (cardScore?.related_id && ['UPDATE','ANGLE','RELATED'].includes(cardScore.relation) && res.id)
        await Promise.resolve(deps.publisher.setStoryLink?.(res.id, cardScore.related_id, cardScore.relation.toLowerCase())).catch(() => {});   // tolerate failure
      if (res.id) runState().recent?.push({ id: res.id, headline: payload.headline, body: payload.body });
      if (it.material && res.id) {
        // Recall gate (20261116000000_macro_focus.sql): no row = not material, so a failure here fails closed.
        stats[it.material.material ? 'recall_material' : 'recall_not_material']++;
        deps.log(`recall ${it.material.material ? 'material' : 'not material (Safety topic only)'}: ${it.material.reasons.join(', ')}: ${it.title.slice(0, 80)}`);
        await Promise.resolve(deps.publisher.setCardMaterial?.(res.id, it.material))
          .catch((e) => deps.log(`set_card_material failed (card stays out of the feeds): ${(e as Error).message}`));
      }
    }
    const notes = r.log.length > 1 ? [...r.log] : [];
    if (r.relevance !== null) notes.push(`relevance ${r.relevance}`);
    if (it.source === 'sec_8k' && r.ai_generated && r.draft.category !== payload.category) {
      notes.push(`category ${r.draft.category} -> ${payload.category} (8-K items)`);
    }
    deps.log(`${res.status} [${r.provider}] ${payload.headline}${notes.length ? `  (${notes.join(' | ')})` : ''}`);
  } catch (e) {
    stats.failed++;
    deps.log(`failed: ${it.url}: ${(e as Error).message}`);
    await deps.publisher.setItemStatus(row.id, 'failed', (e as Error).message).catch(() => {});
  }
}

/** Chain log for a skip line: provider outcomes and validator error names, no source text and no keys; cut to 300 characters. */
function chainNote(log: readonly string[]): string {
  return log.join(' | ').slice(0, 300);
}

/**
 * An item the AI could not turn into a card and that cannot be a template card. Counts a failure only when an AI draft was
 * actually rejected (aiDraftsRejected); the third failure skips the item for good (src/retry.ts decideSoftRetry).
 */
async function softRetry(deps: Deps, row: ItemRow, code: string, chainLog: readonly string[], title: string): Promise<void> {
  if (!aiDraftsRejected(chainLog)) return;                    // no AI was reachable: stays 'new', costs nothing, not counted
  const d = decideSoftRetry(row.status_note, code);
  deps.log(`${code}: failure ${d.failures} of ${config.softRetry.maxFailures}, ${d.status === 'new' ? 'will retry' : 'final'}: ${title.slice(0, 80)}`);
  await deps.publisher.setItemStatus(row.id, d.status, d.note).catch(() => {});
}

/**
 * Template cards carry no AI relevance score, so they are published only where the source itself
 * is reliably relevant: Fed and BEA releases, and watch-list 8-Ks whose main item is in
 * config.templateSecItems. Federal Register template cards are never published.
 */
export function templateAllowed(it: RawItem): boolean {
  if (it.source === 'fed_rss' || it.source === 'bea_rss') return true;   // fed_speech and sec_press: AI only (a template cannot judge relevance)
  if (it.source === 'sec_8k') {
    const main = primaryItem((it.items ?? []).filter((i) => (config.watchItems as readonly string[]).includes(i.number)));
    return !!main && (config.templateSecItems as readonly string[]).includes(main);
  }
  return false;
}
