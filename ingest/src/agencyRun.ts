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
import { eiaUrl, gasolineCard, gasStorageCard, parseEia, petroleumCard } from './sources/eia.ts';
import { fomcCard, upcomingMeetings } from './sources/fomc.ts';
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
  if (c.gasoline.enabled) {
    try { cards.push(gasolineCard(await fetchRows(c.gasoline.route, [c.gasoline.series]))); }
    catch (e) { deps.log(`eia: gasoline failed: ${(e as Error).message}`); }
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
