// Read-only live field check for the M9c3 sources (run by hand, never in CI):
//   node --experimental-strip-types ingest/scripts/live-m9c3-check.ts [--save <dir>]
// Reads EIA_API_KEY from the repo .env in-process (never printed), fetches each public endpoint once and prints the card each
// parser builds. --save writes the raw responses (no keys in the bodies) as test fixtures.
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { buildDataCard, buildObservation } from '../src/sources/macro.ts';
import { blsSeriesUrl, parseBlsSeries } from '../src/sources/bls.ts';
import { dieselCard, eiaUrl, parseEia } from '../src/sources/eia.ts';
import { beigeCard, beigeSummaryUrl, parseBeigeSummary } from '../src/sources/beige.ts';
import { parseTrade, selectTrade, tradeCard, tradeUrl } from '../src/sources/trade.ts';
import { parseRss } from '../src/sources/fed.ts';
import { regPressCard, selectRegPress } from '../src/sources/regpress.ts';

const env = readFileSync(process.env.ENV_FILE ?? new URL('../../.env', import.meta.url), 'utf8');
const key = (n: string) => (new RegExp(`^${n}=(.*)$`, 'm').exec(env)?.[1] ?? '').replace(/[\r"' ]/g, '');
const EIA = key('EIA_API_KEY');
const save = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : null;
const get = async (url: string) => { const r = await fetch(url, { headers: { 'user-agent': 'Element-news live-check (read-only)' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const keep = (name: string, body: string) => { if (save) writeFileSync(`${save}/${name}`, body); };
const now = new Date();

for (const [sid, id] of Object.entries(config.bls.series).filter(([, id]) => id.startsWith('BLS_CPI'))) {
  try {
    const body = await get(blsSeriesUrl(sid));
    keep(`bls-${sid}.json`, body);
    const obs = buildObservation(id, parseBlsSeries(body));
    const card = obs ? buildDataCard(obs, [], { force: true }) : null;
    console.log(id.padEnd(20), card ? `${card.headline} | ${card.dedupe_key}` : 'no card');
  } catch (e) { console.log(id, 'ERR', (e as Error).message); }
}
try {
  const body = await get(eiaUrl(config.agency.eia.diesel.route, [config.agency.eia.diesel.series], EIA, 4));
  keep('eia-diesel.json', body);
  const c = dieselCard(parseEia(body));
  console.log('EIA diesel', c?.headline, '|', c?.dedupe_key, '|', c?.body);
} catch (e) { console.log('EIA diesel ERR', (e as Error).message.replace(EIA, 'KEY')); }
try {
  const body = await get(beigeSummaryUrl('2026-10-14'));
  keep('beige-summary-202610.html', body);
  const s = parseBeigeSummary(body);
  console.log('Beige', JSON.stringify(s));
  console.log('Beige card', beigeCard({ date: '2026-10-14', stage: 'release' }, s, now).body);
} catch (e) { console.log('Beige ERR', (e as Error).message); }
try {
  const body = await get(tradeUrl(now));
  keep('fr-trade.json', body);
  const picked = selectTrade(parseTrade(body), now);
  console.log(`trade: ${picked.length} cards`);
  for (const p of picked.slice(0, 8)) console.log('  ', p.doc.publication_date, tradeCard(p.doc, p.verb, now)?.headline, '<-', p.doc.title.slice(0, 80));
} catch (e) { console.log('trade ERR', (e as Error).message); }
for (const f of config.agency.regpress.feeds) {
  try {
    const body = await get(f.url);
    keep(`regpress-${f.id}.xml`, body);
    const items = parseRss(body);
    const sel = selectRegPress(items, new Date(now.getTime() + 20 * 86_400_000 * 0));
    console.log(`${f.id}: ${items.length} items, ${sel.length} crypto in window; any-age crypto:`, items.filter((i) => new RegExp(config.agency.regpress.crypto, 'i').test(i.title)).map((i) => i.title.slice(0, 70)));
    for (const i of sel) console.log('  card:', regPressCard(i, f)?.headline);
  } catch (e) { console.log(f.id, 'ERR', (e as Error).message); }
}
