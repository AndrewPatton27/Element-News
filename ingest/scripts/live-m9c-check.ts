// Read-only live field check for the M9c sources (run by hand, never in CI):
//   node --experimental-strip-types ingest/scripts/live-m9c-check.ts [--save <dir>]
// Reads FRED_API_KEY and EIA_API_KEY from the repo .env in-process (never printed), fetches each public endpoint once
// and prints the card each parser builds. --save writes the raw responses (keys are not in the bodies) as test fixtures.
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { buildDataCard, buildObservation, fredUrl, parseFredObservations, SERIES } from '../src/sources/macro.ts';
import { eiaUrl, parseEia, supplyCard } from '../src/sources/eia.ts';
import { blsCalendarCard, parseBlsCalendar, upcomingReleases } from '../src/sources/blscal.ts';
import { mtsCard, mtsUrl, parseMts } from '../src/sources/mts.ts';

const env = readFileSync(process.env.ENV_FILE ?? new URL('../../.env', import.meta.url), 'utf8');
const key = (n: string) => (new RegExp(`^${n}=(.*)$`, 'm').exec(env)?.[1] ?? '').replace(/[\r"' ]/g, '');
const FRED = key('FRED_API_KEY'), EIA = key('EIA_API_KEY');
const save = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : null;
const ua = 'Element-news live-check (read-only)';
const get = async (url: string) => { const r = await fetch(url, { headers: { 'user-agent': ua } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const now = new Date();

const ids = (config.macroSeries as string[]).slice(-16);
const start = new Date(now.getTime() - config.fredLookbackDays * 86_400_000).toISOString().slice(0, 10);
for (const id of ids) {
  try {
    const u = new URL(fredUrl(id, start)); u.searchParams.set('api_key', FRED);
    const body = await get(u.toString());
    if (save && id === 'CCSA') writeFileSync(`${save}/fred-CCSA-observations.json`, body);
    if (save && id === 'PCEPI') writeFileSync(`${save}/fred-PCEPI-observations.json`, body);
    const obs = buildObservation(id, parseFredObservations(body));
    const card = obs ? buildDataCard(obs, [], { force: true }) : null;
    console.log(id.padEnd(9), card ? card.headline : `no card (${obs ? obs.display_value : 'no obs'})`, '|', SERIES[id].frequency);
  } catch (e) { console.log(id, 'ERR', (e as Error).message); }
}
try {
  const rows = [
    ...parseEia(await get(eiaUrl(config.agency.eia.supply.routeSupply, Object.values(config.agency.eia.supply.series).filter((s) => s !== 'WPULEUS3'), EIA, 6))),
    ...parseEia(await get(eiaUrl(config.agency.eia.supply.routeUtil, ['WPULEUS3'], EIA, 2))),
  ];
  if (save) { writeFileSync(`${save}/eia-supply-weekly.json`, await get(eiaUrl(config.agency.eia.supply.routeSupply, ['WCRFPUS2', 'WCRIMUS2', 'WRPUPUS2'], EIA, 6))); writeFileSync(`${save}/eia-utilization-weekly.json`, await get(eiaUrl(config.agency.eia.supply.routeUtil, ['WPULEUS3'], EIA, 2))); }
  console.log('EIA supply', supplyCard(rows)?.headline, '|', supplyCard(rows)?.dedupe_key);
} catch (e) { console.log('EIA supply ERR', (e as Error).message.replace(EIA, 'KEY')); }
try {
  const ics = await get(config.agency.blscal.url);
  if (save) writeFileSync(`${save}/bls-calendar-sample.ics`, ics);
  const all = parseBlsCalendar(ics);
  const due = upcomingReleases(all, now, 14);
  console.log(`BLS calendar: ${all.length} events; next 14 days:`);
  for (const r of due) console.log('  ', blsCalendarCard(r, now).headline);
} catch (e) { console.log('BLS calendar ERR', (e as Error).message); }
try {
  const body = await get(mtsUrl(now));
  if (save) writeFileSync(`${save}/mts-table-1.json`, body);
  const m = parseMts(body);
  console.log('MTS', m ? mtsCard(m).headline : 'no month', '|', m ? mtsCard(m).body : '');
} catch (e) { console.log('MTS ERR', (e as Error).message); }
