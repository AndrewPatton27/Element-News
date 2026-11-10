// Direct agency data APIs: BLS (wages, Employment Cost Index, JOLTS) and BEA (PCE prices, personal income, GDP).
// Numbers only, no AI, no page text: each series goes through the same Numbers/data-card path as the FRED and
// Treasury series (publishSeries in macroRun.ts), so a new period gives one data card and a rerun gives none
// (dedupe key = series + period date). Bounded: one request per series (BLS) or per table (BEA), a fixed list.
// Inputs: Deps (fetcher, publisher, clock, log, keys). Outputs: Numbers rows and data cards via deps.publisher.

import { config } from './config.ts';
import { publishSeries } from './macroRun.ts';
import type { Deps, RunStats } from './pipeline.ts';
import { beaTableUrl, beaYears, parseBeaNipa } from './sources/beadata.ts';
import { blsSeriesUrl, parseBlsSeries } from './sources/bls.ts';

/** BLS: one GET per series (config.bls.series). A failing series is logged and the others still run. */
export async function runBls(deps: Deps, stats: RunStats): Promise<void> {
  for (const [seriesId, id] of Object.entries(config.bls.series)) {
    try {
      const points = parseBlsSeries(await deps.fetchText(blsSeriesUrl(seriesId, deps.keys?.bls), 'api', 0));
      await publishSeries(deps, stats, 'bls', id, points, true);
    } catch (e) {
      deps.log(`bls: ${id}: ${(e as Error).message.replace(/registrationkey=[^&\s]+/gi, 'registrationkey=[hidden]')}`);
    }
  }
}

/** BEA: one GET per table (config.beaData.tables). Off unless config.beaData.enabled or deps.keys.beaDataEnabled; needs BEA_API_KEY. */
export async function runBeaData(deps: Deps, stats: RunStats): Promise<void> {
  if (!config.beaData.enabled && !deps.keys?.beaDataEnabled) { deps.log('beadata: disabled (BEA_DATA_ENABLED not set), skipping'); return; }
  const key = deps.keys?.bea;
  if (!key) { deps.log('beadata: BEA_API_KEY not set, skipping'); return; }
  for (const t of config.beaData.tables) {
    try {
      const byId = parseBeaNipa(await deps.fetchText(beaTableUrl(t.table, t.frequency, beaYears(deps.now, t.yearsBack), key), 'api', 0), t.series);
      for (const id of Object.values(t.series)) {
        if (!byId[id]) { deps.log(`beadata: ${id}: not in the ${t.table} reply`); continue; }
        await publishSeries(deps, stats, 'beadata', id, byId[id], true);
      }
    } catch (e) {
      deps.log(`beadata: ${t.table}: ${(e as Error).message.replace(/UserID=[^&\s]+/gi, 'UserID=[hidden]')}`);
    }
  }
}
