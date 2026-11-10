// Numeric sources: FRED series (Numbers panel + data cards) and Treasury FiscalData. No AI, no page text.
// Split out of pipeline.ts; pipeline.ts calls runMacro / runTreasury.
// Inputs: Deps (fetcher, publisher, clock, log) and the run's RunStats. Outputs: Numbers rows and data cards via deps.publisher.

import { config } from './config.ts';
import type { Deps, RunStats } from './pipeline.ts';
import { buildDataCard, buildObservation, differenceSeries, fredUrl, parseFredObservations, type Point } from './sources/macro.ts';
import { avgRatesUrl, debtUrl, parseAvgRates, parseDebt } from './sources/fiscaldata.ts';

/** FRED series -> Numbers panel rows (api.upsert_macro) and, for big enough moves, data cards. Skipped without FRED_API_KEY. */
export async function runMacro(deps: Deps, stats: RunStats): Promise<void> {
  if (!deps.fredApiKey) { deps.log('macro: FRED_API_KEY not set, skipping'); return; }
  const start = new Date(deps.now.getTime() - config.fredLookbackDays * 86_400_000).toISOString().slice(0, 10);
  const fetched = new Map<string, Point[]>();
  for (const id of config.macroSeries) {
    if ((config.forbiddenSeries as readonly string[]).includes(id)) { deps.log(`macro: ${id}: forbidden series, skipped`); continue; }
    try {
      const url = new URL(fredUrl(id, start));
      url.searchParams.set('api_key', deps.fredApiKey);          // never logged: errors print the host only
      const points = parseFredObservations(await deps.fetchText(url.toString(), 'api', 60));
      fetched.set(id, points);
      await publishSeries(deps, stats, 'macro', id, points, true);
    } catch (e) {
      deps.log(`macro: ${id}: ${(e as Error).message}`);
    }
  }
  // Derived series (e.g. the 10Y-2Y spread) are computed here, never fetched from FRED.
  for (const [id, [a, b]] of Object.entries(config.derivedSeries)) {
    const pa = fetched.get(a), pb = fetched.get(b);
    if (!pa || !pb) { deps.log(`macro: ${id}: inputs ${a}/${b} not fetched, skipped`); continue; }
    try {
      await publishSeries(deps, stats, 'macro', id, differenceSeries(pa, pb), true);
    } catch (e) {
      deps.log(`macro: ${id}: ${(e as Error).message}`);
    }
  }
}

/** One series' points -> Numbers panel row and, if `cardAllowed` and the move is big enough, a data card. */
export async function publishSeries(deps: Deps, stats: RunStats, tag: string, id: string, points: Point[], cardAllowed: boolean): Promise<void> {
  const obs = buildObservation(id, points);
  if (!obs) { deps.log(`${tag}: ${id}: not enough data`); return; }
  await deps.publisher.upsertMacro(obs);
  stats.macro++;
  const card = cardAllowed ? buildDataCard(obs) : null;
  if (card) {
    const res = await deps.publisher.publishBlurb(card);
    if (res.status === 'published') stats.data_cards++;
    deps.log(`${tag}: ${id} ${obs.display_value} (${obs.change_text ?? 'no change'}) -> data card ${res.status}`);
  } else {
    deps.log(`${tag}: ${id} ${obs.display_value} (${obs.change_text ?? 'no change'}) -> numbers panel only`);
  }
}

/**
 * Treasury FiscalData: average interest rates (Bills, Notes, Bonds) and the national debt, from the JSON API
 * (API host list, no key). Same Numbers/data-card path as FRED series; only config.fiscalData.cardSeries may
 * become data cards. One failing dataset is logged and the other still runs.
 */
export async function runTreasury(deps: Deps, stats: RunStats): Promise<void> {
  try {
    const rates = parseAvgRates(await deps.fetchText(avgRatesUrl(), 'api', 0));
    for (const id of Object.keys(rates)) {
      await publishSeries(deps, stats, 'treasury', id, rates[id], config.fiscalData.cardSeries.includes(id));
    }
  } catch (e) {
    deps.log(`treasury: average rates failed: ${(e as Error).message}`);
  }
  try {
    await publishSeries(deps, stats, 'treasury', 'TREAS_DEBT', parseDebt(await deps.fetchText(debtUrl(), 'api', 0)), config.fiscalData.cardSeries.includes('TREAS_DEBT'));
  } catch (e) {
    deps.log(`treasury: debt failed: ${(e as Error).message}`);
  }
}
