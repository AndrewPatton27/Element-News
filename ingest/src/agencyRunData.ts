// Agency data-card sources (D-113): EIA weekly reports, Census indicators (off by default), Treasury note and
// bond auctions, FOMC calendar. All are template cards: no AI call, no page download, no publisher images.
// Split out of pipeline.ts; pipeline.ts only calls runEia / runCensus / runAuctions / runFomc.
// Every source is bounded per run (config.agency.*.maxCardsPerRun, 1-3 HTTP requests) and idempotent: the
// dedupe_key (agency + series + period) makes a repeat publish come back as "duplicate".
// Inputs: Deps (fetcher, publisher, keys, clock, log) and RunStats. Outputs: data cards via deps.publisher.

import { config } from './config.ts';
import type { Deps, RunStats } from './pipeline.ts';
import type { PublishPayload } from './types.ts';
import { validatePublish } from './validate.ts';
import { censusCard, censusUrl, parseCensus, type CensusSeries } from './sources/census.ts';
import { dieselCard, eiaUrl, gasolineCard, gasStorageCard, parseEia, petroleumCard, supplyCard } from './sources/eia.ts';
import { blsCalendarCard, parseBlsCalendar, upcomingReleases } from './sources/blscal.ts';
import { mtsCard, mtsUrl, parseMts } from './sources/mts.ts';
import { fomcCard, upcomingMeetings } from './sources/fomc.ts';
import { beigeCard, beigeDue, beigeSummaryUrl, parseBeigeSummary } from './sources/beige.ts';
import { parseRss } from './sources/fed.ts';
import { regPressCard, selectRegPress } from './sources/regpress.ts';
import { parseTrade, selectTrade, tradeCard, tradeUrl } from './sources/trade.ts';
import { annualCard, annualDue } from './sources/annual.ts';
import { auctionCard, auctionsUrl, parseAuctions } from './sources/treasuryauctions.ts';

/** Publishes up to `max` cards; a card that fails validation is logged and skipped. Returns how many were new. */
async function publishCards(deps: Deps, stats: RunStats, tag: string, cards: (PublishPayload | null)[], max: number): Promise<number> {
  let fresh = 0;
  for (const c of cards) {
    if (!c) continue;
    if (fresh >= max) { deps.log(`${tag}: card cap reached (${max} new per run)`); break; }
    const v = validatePublish(c);
    if (!v.ok) { stats.skipped++; deps.log(`${tag}: skip invalid card ${c.dedupe_key}: ${v.errors.join('; ')}`); continue; }
    try {
      const res = await deps.publisher.publishBlurb(c);
      if (res.status === 'published') { stats.data_cards++; stats.template++; fresh++; }
      else if (res.status === 'duplicate') stats.duplicate++;
      deps.log(`${tag}: ${c.dedupe_key} -> ${res.status} [template] ${c.headline}`);
    } catch (e) {
      stats.failed++;
      deps.log(`${tag}: failed ${c.dedupe_key}: ${(e as Error).message}`);
    }
  }
  return fresh;
}

/** EIA weekly petroleum status, natural gas storage and (off by default) retail gasoline. Needs EIA_API_KEY. */
export async function runEia(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.eia;
  if (!c.enabled) { deps.log('eia: disabled in config'); return; }
  if (!deps.eiaApiKey) { deps.log('eia: EIA_API_KEY not set, skipping'); return; }
  const cards: (PublishPayload | null)[] = [];
  const fetchRows = async (route: string, ids: string[]) => parseEia(await deps.fetchText(eiaUrl(route, ids, deps.eiaApiKey!, ids.length * 2), 'api', 0));
  if (c.petroleum.enabled) {
    try { cards.push(petroleumCard(await fetchRows(c.petroleum.route, Object.values(c.petroleum.series)))); }
    catch (e) { deps.log(`eia: petroleum failed: ${(e as Error).message}`); }
  }
  if (c.gasStorage.enabled) {
    try { cards.push(gasStorageCard(await fetchRows(c.gasStorage.route, [c.gasStorage.series]))); }
    catch (e) { deps.log(`eia: gas storage failed: ${(e as Error).message}`); }
  }
  if (c.supply.enabled) {
    try {
      const rows = [...await fetchRows(c.supply.routeSupply, [c.supply.series.production, c.supply.series.imports, c.supply.series.productSupplied]),
        ...await fetchRows(c.supply.routeUtil, [c.supply.series.utilization])];
      cards.push(supplyCard(rows));
    } catch (e) { deps.log(`eia: supply failed: ${(e as Error).message}`); }
  }
  if (c.gasoline.enabled) {
    try { cards.push(gasolineCard(await fetchRows(c.gasoline.route, [c.gasoline.series]))); }
    catch (e) { deps.log(`eia: gasoline failed: ${(e as Error).message}`); }
  }
  if (c.diesel.enabled) {
    try { cards.push(dieselCard(await fetchRows(c.diesel.route, [c.diesel.series]))); }
    catch (e) { deps.log(`eia: diesel failed: ${(e as Error).message}`); }
  }
  await publishCards(deps, stats, 'eia', cards, c.maxCardsPerRun);
}

/** Census retail sales and housing starts. OFF by default (terms question); CENSUS_API_KEY optional. */
export async function runCensus(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.census;
  if (!c.enabled) { deps.log('census: disabled in config (terms need Drew\'s decision)'); return; }
  const cards: (PublishPayload | null)[] = [];
  for (const series of ['retail', 'housing'] as CensusSeries[]) {
    try { cards.push(censusCard(series, parseCensus(await deps.fetchText(censusUrl(series, deps.now, deps.censusApiKey ?? null), 'api', 0)))); }
    catch (e) { deps.log(`census: ${series} failed: ${(e as Error).message}`); }
  }
  await publishCards(deps, stats, 'census', cards, c.maxCardsPerRun);
}

/** Treasury note and bond auction results from FiscalData (no key). Newest first, at most 2 new cards per run. */
export async function runAuctions(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.auctions;
  if (!c.enabled) { deps.log('auctions: disabled in config'); return; }
  try {
    const results = parseAuctions(await deps.fetchText(auctionsUrl(deps.now), 'api', 0));
    deps.log(`auctions: ${results.length} note/bond results in the last ${c.lookbackDays} days`);
    await publishCards(deps, stats, 'auctions', results.map(auctionCard), c.maxCardsPerRun);
  } catch (e) {
    deps.log(`auctions: failed: ${(e as Error).message}`);
  }
}

/** FOMC meeting calendar card for a meeting starting within the lead window (no network). */
export async function runFomc(deps: Deps, stats: RunStats): Promise<void> {
  if (!config.agency.fomc.enabled) { deps.log('fomc: disabled in config'); return; }
  const meetings = upcomingMeetings(deps.now);
  await publishCards(deps, stats, 'fomc', meetings.map((m) => fomcCard(m, deps.now)), 1);
}

/** BLS release calendar (ICS from www.bls.gov): one card per major release due in the next few days. */
export async function runBlsCal(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.blscal;
  if (!c.enabled) { deps.log('blscal: disabled in config'); return; }
  try {
    const due = upcomingReleases(parseBlsCalendar(await deps.fetchText(c.url, 'page', config.feedCacheTtlMinutes)), deps.now);
    deps.log(`blscal: ${due.length} major releases in the next ${c.leadDays} days`);
    await publishCards(deps, stats, 'blscal', due.map((r) => blsCalendarCard(r, deps.now)), c.maxCardsPerRun);
  } catch (e) {
    deps.log(`blscal: failed: ${(e as Error).message}`);
  }
}

/** Treasury Monthly Treasury Statement: the newest month budget deficit or surplus (FiscalData, no key). */
export async function runMts(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.mts;
  if (!c.enabled) { deps.log('mts: disabled in config'); return; }
  try {
    const month = parseMts(await deps.fetchText(mtsUrl(deps.now), 'api', 0));
    if (!month) { deps.log('mts: no complete month in the table yet'); return; }
    await publishCards(deps, stats, 'mts', [mtsCard(month)], c.maxCardsPerRun);
  } catch (e) {
    deps.log(`mts: failed: ${(e as Error).message}`);
  }
}

/** Fed Beige Book: a preview card before each release and a release card with quotes from the national summary (federalreserve.gov, rule 2). */
export async function runBeige(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.beige;
  if (!c.enabled) { deps.log('beige: disabled in config'); return; }
  const due = beigeDue(deps.now);
  if (!due) { deps.log('beige: no release in the window'); return; }
  let summary = null;
  if (due.stage === 'release') {
    try { summary = parseBeigeSummary(await deps.fetchText(beigeSummaryUrl(due.date), 'page', 0)); }
    catch (e) { deps.log(`beige: summary page not readable yet (${(e as Error).message}); retrying next run`); return; }
  }
  await publishCards(deps, stats, 'beige', [beigeCard(due, summary, deps.now)], c.maxCardsPerRun);
}

/** Federal Register trade documents (USTR, BIS, ITA Section 232) as template cards. One API request. */
export async function runTrade(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.trade;
  if (!c.enabled) { deps.log('trade: disabled in config'); return; }
  try {
    const picked = selectTrade(parseTrade(await deps.fetchText(tradeUrl(deps.now), 'api', 0)), deps.now);
    deps.log(`trade: ${picked.length} material trade documents in the last ${c.lookbackDays} days`);
    await publishCards(deps, stats, 'trade', picked.map((p) => tradeCard(p.doc, p.verb, deps.now)), c.maxCardsPerRun);
  } catch (e) {
    deps.log(`trade: failed: ${(e as Error).message}`);
  }
}

/** CFTC, OCC and CFPB press releases that match the crypto pattern (opt-in Crypto/regulation lane). One RSS request per feed. */
export async function runRegPress(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.regpress;
  if (!c.enabled) { deps.log('regpress: disabled in config'); return; }
  const cards: (PublishPayload | null)[] = [];
  for (const feed of c.feeds) {
    if (feed.needsFlag && !deps.keys?.occEnabled) { deps.log(`regpress: ${feed.id}: disabled (REGPRESS_OCC_ENABLED not set), skipping`); continue; }
    try {
      const items = selectRegPress(parseRss(await deps.fetchText(feed.url, 'api', config.feedCacheTtlMinutes)), deps.now);
      deps.log(`regpress: ${feed.id}: ${items.length} crypto-related releases in the last ${c.maxAgeDays} days`);
      for (const i of items) cards.push(regPressCard(i, feed));
    } catch (e) {
      deps.log(`regpress: ${feed.id} failed: ${(e as Error).message}`);
    }
  }
  await publishCards(deps, stats, 'regpress', cards, c.maxCardsPerRun);
}

/** Annual figures (SSA COLA ...) from the hand-verified list. OFF unless ANNUAL_FIGURES_ENABLED=1 (deps.keys.annualEnabled). */
export async function runAnnual(deps: Deps, stats: RunStats): Promise<void> {
  const c = config.agency.annual;
  if (!c.enabled && !deps.keys?.annualEnabled) { deps.log('annual: disabled (ANNUAL_FIGURES_ENABLED not set), skipping'); return; }
  await publishCards(deps, stats, 'annual', annualDue(deps.now).map(annualCard), c.maxCardsPerRun);
}
