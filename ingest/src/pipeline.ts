// One ingest run over every source: macro numbers (FRED), Fed and BEA releases, Federal Register
// rules, SEC 8-Ks, Wikipedia "In the news", CPSC recalls, USGS earthquakes and NASA releases.
// All I/O is injected (fetchText, publisher, summarizers), so the same code runs
// live, in --dry-run from fixtures, and in tests.
// Inputs: Deps (fetcher, publisher, providers, usage counter, clock, log) and RunOptions (--only, --limit).
// Outputs: RunStats counts; cards and items are written through deps.publisher.

import { config, fedRegisterUrls } from './config.ts';
import { createGuard, normalizeUrl } from './dedupe.ts';
import { buildPublishPayload, type Publisher } from './publish.ts';
import { beaItemToItem } from './sources/bea.ts';
import { cpscToItem, cpscUrl, parseCpscJson, selectRecalls } from './sources/cpsc.ts';
import { nasaFeedUrl, nasaToItem, parseNasaRss, selectNasaReleases } from './sources/nasa.ts';
import { parseUsgsGeoJson, usgsDraft, usgsToItem } from './sources/usgs.ts';
import { parseWikiFeed, wikiFeedUrl, wikiItemToItem } from './sources/wiki.ts';
import { fedRegDocToItem, isAirworthinessDirective, mergeFedRegDocs, parseFedRegJson, type FrDoc } from './sources/fedreg.ts';
import { fedItemToItem, fedPageText, mergeFedItems, parseRss } from './sources/fed.ts';
import { buildDataCard, buildObservation, fredUrl, parseFredObservations } from './sources/macro.ts';
import {
  classifySecEntry, displayCompanyName, isRoutine502, mergeSecEntries, parseSec8kAtom,
  parseSubmissionsJson, primaryItem, resolveWatchList, type Sec8kEntry, type SecSkipReason, type WatchMap,
} from './sources/sec.ts';
import { secFilingPageText } from './sec-text.ts';
import { createChainState, summarizeWithChain, type ChainState, type UsageCounter } from './summarizer/chain.ts';
import type { RawItem, Summarizer } from './types.ts';
import { hasFigures, requiresFigures, validatePublish } from './validate.ts';
import { createTopicFilterState, filterTopic, recordTopic, type TopicFilterState } from './topicFilter.ts';
import { baseScore, pickNext, softCap } from './selection.ts';
import { reviewCard, type CardScore, type ScoreClient } from './reportCard.ts';

export type SourceName = 'macro' | 'fed' | 'bea' | 'fedreg' | 'sec' | 'wiki' | 'cpsc' | 'usgs' | 'nasa';
export const SOURCE_NAMES: readonly SourceName[] = ['macro', 'fed', 'bea', 'fedreg', 'sec', 'wiki', 'cpsc', 'usgs', 'nasa'];

export interface Deps {
  /** GET a URL through the allowlist. `kind` picks the host list; ttl in minutes (0 = no cache). */
  fetchText(url: string, kind: 'page' | 'api', ttlMinutes: number): Promise<string>;
  publisher: Publisher;
  providers: Summarizer[];
  counter: UsageCounter;
  fredApiKey: string | null;
  now: Date;
  log(line: string): void;
  /** Report-card protocol overrides (tests, env flag): enabled replaces config.reportCard.protocolEnabled; scorer replaces the Groq provider. */
  reportCard?: { enabled?: boolean; scorer?: ScoreClient };
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
  report_provider_groq: number;
}

/** Per-run state passed to each source's runner (shared budget, dedupe guard and provider cooldowns). */
interface RunCtx {
  stats: RunStats;
  budget: { left: number };
  guard: ReturnType<typeof createGuard>;
  chain: ChainState;
}
let topicFilterState: TopicFilterState = createTopicFilterState();
/** Recent live cards for the protocol's duplicate/relation check: loaded once per run, grown with this run's cards. */
let runRecent: Array<{ id: string; headline: string; body: string | null }> | null = null;
async function recentCards(deps: Deps) {
  if (!runRecent) {
    const all = await Promise.resolve(deps.publisher.auditCards?.()).catch(() => undefined) ?? [];
    const cutoff = deps.now.getTime() - config.reportCard.recentCardDays * 86_400_000;
    runRecent = all.filter((c) => Date.parse(c.as_of) >= cutoff).slice(0, config.reportCard.scoreMaxRecentCards).map((c) => ({ id: c.id, headline: c.headline, body: c.body }));
  }
  return runRecent;
}

/**
 * One ingest run. Sources run in a fixed order (macro, fed, bea, fedreg, sec, wiki, cpsc, usgs,
 * nasa); `opts.only` picks a subset and `opts.limit` (default 20) caps the news items summarized
 * across all sources. A failing source is logged and the run continues with the next one.
 */
export async function runOnce(deps: Deps, opts: RunOptions = {}): Promise<RunStats> {
  const only = new Set<SourceName>(opts.only?.length ? opts.only : SOURCE_NAMES);
  const stats: RunStats = { published: 0, duplicate: 0, ticker_cap: 0, skipped: 0, failed: 0, ai: 0, template: 0, macro: 0, data_cards: 0, report_pass: 0, report_revise: 0, report_abandon: 0, report_duplicate: 0, report_provider_gemini: 0, report_provider_groq: 0 };
  const ctx: RunCtx = {
    stats,
    budget: { left: opts.limit ?? 20 },
    guard: createGuard(),
    chain: createChainState(),                       // provider cooldowns after a 429 last for this run
  };
  topicFilterState = createTopicFilterState();
  runRecent = null;

  const select = deps.selection?.enabled ?? config.selection.enabled;
  collector = select ? [] : null;                    // selection on: sources only collect; the budget is spent below
  try {
  if (only.has('macro')) await runMacro(deps, stats);
  if (only.has('fed')) await runFed(deps, ctx);
  if (only.has('bea')) await runBea(deps, ctx);
  if (only.has('fedreg')) await runFedReg(deps, ctx);
  if (only.has('sec')) await runSec(deps, stats, ctx.budget, ctx.guard, ctx.chain);
  if (only.has('wiki')) await runWiki(deps, ctx);
  if (only.has('cpsc')) await runCpsc(deps, ctx);
  if (only.has('usgs')) await runUsgs(deps, stats, ctx.guard);
  if (only.has('nasa')) await runNasa(deps, ctx);
  if (collector) await runSelected(collector, deps, ctx, opts.limit ?? 20);
  } finally { collector = null; }
  deps.log(`report card: PASS ${stats.report_pass}, REVISE/rejected ${stats.report_revise}, ABANDON ${stats.report_abandon}, DUPLICATE ${stats.report_duplicate}; scorers Gemini ${stats.report_provider_gemini}, Groq ${stats.report_provider_groq}`);
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
      onDone: (p) => deps.log(`cpsc: ${all.length} recalls in the last ${config.cpsc.lookbackDays} days, ${items.length} candidates, `
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
      const row = await deps.publisher.upsertItem(it);
      if (!row.is_new && row.status !== 'new') { stats.skipped++; continue; }
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
    // Watch list: household-name companies only. CIKs come from SEC's ticker list; without it
    // there is no way to tell which filings are watched, so the SEC source is skipped this run.
    let watch: WatchMap;
    try {
      const w = resolveWatchList(await deps.fetchText(config.secTickersUrl, 'page', config.cacheTtlMinutes));
      watch = w.map;
      deps.log(`sec: watch list ${w.map.size} of ${config.watchCompanies.length} companies resolved`
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
    // Per-company filing lists (data.sec.gov, API host list); the shared limiter keeps us under 5 req/s.
    let failedLists = 0;
    for (const cik of watch.keys()) {
      try {
        lists.push(parseSubmissionsJson(await deps.fetchText(config.secSubmissionsUrl.replace('{cik}', cik), 'api', 0), deps.now));
      } catch {
        failedLists++;
      }
    }
    if (failedLists) deps.log(`sec: per-company filing list unavailable for ${failedLists} of ${watch.size} companies`);
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
      (it, text) => (isRoutine502(it.items ?? [], text) ? 'routine_5.02' : null));
  } catch (e) {
    deps.log(`sec: feed failed: ${(e as Error).message}`);
  }
}

interface ItemRow { id: string; is_new: boolean; status: string }

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

/** Set during a run with candidate selection on: processItems queues its job here instead of spending budget. */
let collector: Job[] | null = null;

/**
 * Candidate selection. Step 1 (per job, no AI): dedupe/ticker guard, topic filter and the already-handled check
 * (upsert) drop what cannot become a card. Step 2: score what is left without AI (importance, freshness) and spend
 * the budget in score order with a per-source soft cap (config.selection). Every per-item guard in handleItem
 * (ticker cap, group caps, narrow-source cap, new-item totals, copy limits, report card) still runs at spend time.
 */
async function runSelected(jobs: Job[], deps: Deps, ctx: RunCtx, budgetTotal: number): Promise<void> {
  const cands: Array<{ source: string; score: number; job: Job; it: RawItem; row: ItemRow }> = [];
  for (const job of jobs) {
    let newHere = 0;
    const groupNew = new Map<string, number>();
    for (const it of job.items) {
      if (job.limits.total !== undefined && newHere >= job.limits.total) { deps.log(`new-item limit reached (${job.limits.total} new per run)`); break; }
      const cand = { url: it.url, tickers: it.tickers.map((t) => t.symbol), sortAt: new Date(it.published_at) };
      const d = ctx.guard.check(cand);
      if (!d.ok) { deps.log(`skip ${d.reason}: ${it.title}`); ctx.stats.skipped++; continue; }
      const topicReject = filterTopic(it, topicFilterState);
      if (topicReject) { ctx.stats.skipped++; deps.log(`skip ${topicReject}: ${it.title.slice(0, 100)}`); continue; }
      const lg = job.limits.group;
      const group = lg?.of(it) ?? null;
      if (lg && group !== null && (groupNew.get(group) ?? 0) >= lg.max) {           // group cap counts NEW items only, so capped ones are not even recorded
        ctx.stats.skipped++;
        deps.log(`skip ${lg.skip} (max ${lg.max} ${lg.label} per run): ${it.title.slice(0, 80)}`);
        continue;
      }
      const row = await deps.publisher.upsertItem(it);
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
  if (collector) { collector.push(job); return { fresh: 0, alreadyHandled: 0 }; }   // candidate selection: spent later by runSelected
  for (const it of items) {
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

/** One candidate item through steps 2-7 of processItems. `known` = the item row when the selection step already recorded it. */
async function handleItem(job: Job, it: RawItem, known: ItemRow | null): Promise<void> {
  const { deps, stats, budget, guard, chain, pageText, preCheck, limits, perGroup } = job;
  const cand = { url: it.url, tickers: it.tickers.map((t) => t.symbol), sortAt: new Date(it.published_at) };
  const d = guard.check(cand);
  if (!d.ok) { deps.log(`skip ${d.reason}: ${it.title}`); stats.skipped++; return; }
  const topicReject = filterTopic(it, topicFilterState);
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

  const row = known ?? await deps.publisher.upsertItem(it);
  if (!known && !row.is_new && row.status !== 'new') { stats.skipped++; job.alreadyHandled++; return; }   // handled in an earlier run
  job.fresh++;
  recordTopic(it, topicFilterState);
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
      deps.log(`skip no_figures (earnings card without figures, ${r.ai_generated ? 'AI' : r.provider}): ${it.title}`);
      if (r.log.some((l) => /no_figures/.test(l))) await deps.publisher.setItemStatus(row.id, 'skipped', 'no_figures').catch(() => {});
      return;
    }
    if (!r.ai_generated && !templateAllowed(it)) {
      stats.skipped++;
      // Item status stays 'new' on purpose: a later run with a working AI provider retries it.
      deps.log(`skip template_not_allowed (no AI relevance score): ${it.title}`);
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
      return g ? { generate: (prompt: string) => g.generate!(prompt) } : null;
    })();
    if (protocolOn && r.ai_generated && scorer) {
      const recent = await recentCards(deps);
      const candidate = { id: row.id, ai_generated: payload.ai_generated, as_of: payload.as_of, sources: [{ name: it.source_name, url: it.url }] } as any;
      const writer = deps.providers.find((p) => p.name === r.provider && p.usesAi) ?? deps.providers.find((p) => p.usesAi);
      const rv = await reviewCard({
        client: scorer, card: candidate, payload, recent,
        rewrite: async (recs) => {
          if (!writer) throw new Error('writer unavailable');
          const d2 = await writer.summarize({ item: it, text, retryErrors: recs.length ? recs : ['report card: fix the lowest-scored parts using only the source text'] });
          const p2 = buildPublishPayload(it, d2, { itemId: row.id, aiGenerated: true, model: writer.model ?? null });
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
        stats.skipped++;                                   // item stays 'new': a later run tries it again
        deps.log(`skip report_card_unscored (${rv.error ?? 'no score'}): ${it.title}`);
        return;
      }
      if (rv.verdict !== 'publish') {
        if (rv.verdict === 'duplicate') stats.report_duplicate++;
        stats.report_abandon++;
        const code = rv.verdict === 'duplicate' ? 'duplicate_story' : rv.verdict === 'abandon' ? 'report_card_abandon' : 'report_card_revise_failed';
        stats.skipped++; deps.log(`skip ${code}: ${it.title}`);
        await deps.publisher.setItemStatus(row.id, 'skipped', code).catch(() => {});
        return;
      }
      payload = rv.payload;
      stats.report_pass++;
    }
    const res = await deps.publisher.publishBlurb(payload);
    stats[res.status === 'published' ? 'published' : res.status]++;
    if (res.status === 'published') {
      stats[r.ai_generated ? 'ai' : 'template']++;
      guard.record(cand);
      if (cardScore?.related_id && ['UPDATE','ANGLE','RELATED'].includes(cardScore.relation) && res.id)
        await Promise.resolve(deps.publisher.setStoryLink?.(res.id, cardScore.related_id, cardScore.relation.toLowerCase())).catch(() => {});   // tolerate failure
      if (res.id) runRecent?.push({ id: res.id, headline: payload.headline, body: payload.body });
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

/**
 * Template cards carry no AI relevance score, so they are published only where the source itself
 * is reliably relevant: Fed and BEA releases, and watch-list 8-Ks whose main item is in
 * config.templateSecItems. Federal Register template cards are never published.
 */
export function templateAllowed(it: RawItem): boolean {
  if (it.source === 'fed_rss' || it.source === 'bea_rss') return true;
  if (it.source === 'sec_8k') {
    const main = primaryItem((it.items ?? []).filter((i) => (config.watchItems as readonly string[]).includes(i.number)));
    return !!main && (config.templateSecItems as readonly string[]).includes(main);
  }
  return false;
}

/** FRED series -> Numbers panel rows (api.upsert_macro) and, for big enough moves, data cards. Skipped without FRED_API_KEY. */
async function runMacro(deps: Deps, stats: RunStats): Promise<void> {
  if (!deps.fredApiKey) { deps.log('macro: FRED_API_KEY not set, skipping'); return; }
  const start = new Date(deps.now.getTime() - config.fredLookbackDays * 86_400_000).toISOString().slice(0, 10);
  for (const id of config.macroSeries) {
    if ((config.forbiddenSeries as readonly string[]).includes(id)) { deps.log(`macro: ${id}: forbidden series, skipped`); continue; }
    try {
      const url = new URL(fredUrl(id, start));
      url.searchParams.set('api_key', deps.fredApiKey);          // never logged: errors print the host only
      const points = parseFredObservations(await deps.fetchText(url.toString(), 'api', 60));
      const obs = buildObservation(id, points);
      if (!obs) { deps.log(`macro: ${id}: not enough data`); continue; }
      await deps.publisher.upsertMacro(obs);
      stats.macro++;
      const card = buildDataCard(obs);
      if (card) {
        const res = await deps.publisher.publishBlurb(card);
        if (res.status === 'published') stats.data_cards++;
        deps.log(`macro: ${id} ${obs.display_value} (${obs.change_text ?? 'no change'}) -> data card ${res.status}`);
      } else {
        deps.log(`macro: ${id} ${obs.display_value} (${obs.change_text ?? 'no change'}) -> numbers panel only`);
      }
    } catch (e) {
      deps.log(`macro: ${id}: ${(e as Error).message}`);
    }
  }
}
