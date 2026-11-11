// Numeric sources: FRED series (Numbers panel + data cards) and Treasury FiscalData. No AI, no page text.
// Split out of pipeline.ts; pipeline.ts calls runMacro / runTreasury.
// Inputs: Deps (fetcher, publisher, clock, log) and the run's RunStats. Outputs: Numbers rows and data cards via deps.publisher.

import { config } from './config.ts';
import type { Deps, RunStats } from './pipeline.ts';
import { buildDataCard, buildObservation, buildYieldCurveCard, differenceSeries, fredUrl, parseFredObservations, SERIES, type Frequency, type Point } from './sources/macro.ts';
import type { MacroObservation } from './types.ts';
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
      await publishSeries(deps, stats, 'macro', id, points, true, id === 'DFF' ? { targetRange: targetRange(fetched) } : {});
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
  // One daily Treasury yield-curve card from the points already fetched (no extra FRED calls).
  try {
    const card = buildYieldCurveCard(Object.fromEntries(fetched));
    if (!card) deps.log('macro: yield curve: no card (a maturity is missing or lags the 10-year, or the move is below the threshold)');
    else {
      const res = await deps.publisher.publishBlurb(card);
      if (res.status === 'published') stats.data_cards++;
      deps.log(`macro: yield curve ${card.dedupe_key} -> data card ${res.status}`);
    }
  } catch (e) {
    deps.log(`macro: yield curve: ${(e as Error).message}`);
  }
}

/** "3.75% to 4.00%" from the fetched DFEDTARL / DFEDTARU points, when both have a reading on the same date. */
function targetRange(fetched: Map<string, Point[]>): string | undefined {
  const lo = fetched.get('DFEDTARL')?.at(-1), hi = fetched.get('DFEDTARU')?.at(-1);
  if (!lo || !hi || lo.date !== hi.date) return undefined;
  return `${lo.value.toFixed(2)}% to ${hi.value.toFixed(2)}%`;
}

/** How many of the newest readings feed the data-card chart, per frequency (matches the windows in api.macro_history). */
export const HISTORY_KEEP: Record<Frequency, number> = { daily: 70, weekly: 30, monthly: 14, quarterly: 9 };

/** The newest readings of a series as observations (each formatted from the history up to it, like the live run and --backfill-macro). */
export function historyObservations(id: string, points: Point[]): MacroObservation[] {
  const info = SERIES[id];
  if (!info) return [];
  const out: MacroObservation[] = [];
  for (let i = Math.max(0, points.length - HISTORY_KEEP[info.frequency]); i < points.length; i++) {
    const o = buildObservation(id, points.slice(0, i + 1));
    if (o) out.push(o);
  }
  return out;
}

/** Keeps the chart history of one series filled (one batched call). Never throws: a missing RPC or a failure only costs the chart. */
async function storeHistory(deps: Deps, tag: string, id: string, points: Point[]): Promise<void> {
  if (!deps.publisher.upsertMacroBatch) return;
  try {
    const rows = historyObservations(id, points);
    if (rows.length > 1) await deps.publisher.upsertMacroBatch(rows);
  } catch (e) {
    deps.log(`${tag}: ${id}: chart history not stored: ${(e as Error).message}`);
  }
}

/** One series' points -> Numbers panel row and, if `cardAllowed` and the move is big enough, a data card. */
export async function publishSeries(deps: Deps, stats: RunStats, tag: string, id: string, points: Point[], cardAllowed: boolean, ctx: { targetRange?: string } = {}): Promise<void> {
  const obs = buildObservation(id, points);
  if (!obs) { deps.log(`${tag}: ${id}: not enough data`); return; }
  await deps.publisher.upsertMacro(obs);
  stats.macro++;
  await storeHistory(deps, tag, id, points);
  const card = cardAllowed ? buildDataCard(obs, [], ctx) : null;
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
