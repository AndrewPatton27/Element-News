// Offline search evaluation in PGlite (not a pass/fail check).
// usage: node supabase/tests/eval/search-eval.mjs [--scale N] [--snapshot cards.json] [--skip <migration fragment>] [-v]
// Loads every migration (minus --skip ones, to measure "before"), loads the synthetic corpus (or a local snapshot of
// the public feed in the api card shape, never committed), then runs the query battery below as a guest and as a
// signed-in reader and prints precision at 5 / 10 per query class, timings and a paging check.
// Relevance is judged by a hand-written pattern per query over headline, summary and tickers.
// P@k = relevant cards in the top k / min(k, R), R = relevant cards in the corpus (so a query with 2 relevant
// cards scores 1.0 when both are on top).
import fs from 'node:fs';
import { makeDb, rows, as } from './db.mjs';
import { synthCorpus, loadCards } from './corpus.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scale = Number(arg('--scale', 1));
const snapshot = arg('--snapshot', null);
const skip = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--skip' ? [a] : []));
const verbose = process.argv.includes('-v');

import { BATTERY, text } from './battery.mjs';
export { BATTERY };

const t0 = Date.now();
const db = await makeDb({ skip });
const cards = snapshot ? JSON.parse(fs.readFileSync(snapshot, 'utf8')) : synthCorpus(7, scale);
await db.exec(`update core.blurbs set status = 'hidden'`);       // seed cards from migrations (if any) out of the way
const ids = await loadCards(db, cards);
const corpus = (await rows(db, `select b.id, b.headline, b.body, b.tickers, b.category from core.blurbs b where b.status = 'published'`));
console.log(`setup ${((Date.now() - t0) / 1000).toFixed(1)} s, ${ids.length} cards loaded, ${corpus.length} published${skip.length ? `, skipped: ${skip.join(',')}` : ''}`);

const reader = (await rows(db, `select id from auth.users where email = 'element-test-a@example.com'`))[0].id;
async function battery(label, quiet) {
const by = {}; const times = [];
for (const [cls, q, re] of BATTERY) {
  const R = corpus.filter((c) => re.test(text(c))).length;
  const s = Date.now();
  const res = await as(db, null, () => rows(db, `select api.search($1, null, 20) r`, [q]));
  const ms = Date.now() - s; times.push(ms);
  const items = res[0].r.items;
  const rel = items.map((c) => re.test(text(c)));
  const pk = (k) => (R === 0 ? (items.length === 0 ? 1 : 0) : rel.slice(0, k).filter(Boolean).length / Math.min(k, R));
  const row = { q, R, n: items.length, p5: pk(5), p10: pk(10), ms };
  (by[cls] ||= []).push(row);
  if (!quiet && (verbose || row.p5 < 1)) {
    console.log(`${cls.padEnd(7)} ${q.padEnd(24)} n=${String(items.length).padStart(2)} R=${String(R).padStart(3)} P@5=${row.p5.toFixed(2)} P@10=${row.p10.toFixed(2)} ${ms} ms`);
    if (verbose || row.p5 < 1) items.slice(0, 6).forEach((c, i) => console.log(`     ${i + 1}${rel[i] ? '+' : '-'} ${c.category} | ${c.headline.slice(0, 66)}`));
  }
}
console.log(`\n[${label}]\nclass    queries  P@5   P@10  median ms`);
const all = [];
for (const [cls, rs] of Object.entries(by)) {
  all.push(...rs);
  const m = (k) => (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(2);
  console.log(`${cls.padEnd(8)} ${String(rs.length).padStart(7)}  ${m('p5')}  ${m('p10')}  ${String(rs.map((r) => r.ms).sort((a, b) => a - b)[rs.length >> 1]).padStart(9)}`);
}
const m = (k) => (all.reduce((a, r) => a + r[k], 0) / all.length).toFixed(2);
times.sort((a, b) => a - b);
console.log(`ALL      ${String(all.length).padStart(7)}  ${m('p5')}  ${m('p10')}  median ${times[times.length >> 1]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, max ${times[times.length - 1]} ms`);

}

// --ablate: the same battery with each v6 setting switched off in turn (core.rank_params, rolled back after)
await battery('current settings', false);
if (process.argv.includes('--ablate')) {
  for (const [k, v] of [['search_headline_weight', 0], ['search_headline_weight', 0.15], ['search_micro_penalty', 0], ['search_company_min_confidence', 0], ['search_idf_weighting', 0]]) {
    const old = (await rows(db, 'select value from core.rank_params where key = $1', [k]))[0];
    if (!old) continue;
    await db.query('update core.rank_params set value = $2 where key = $1', [k, v]);
    await battery(`${k} = ${v}`, true);
    await db.query('update core.rank_params set value = $2 where key = $1', [k, old.value]);
  }
}

// paging: one-per-page scroll equals one big page (no repeats, no gaps), guest and signed in
for (const [who, uid] of [['guest', null], ['signed in', reader]]) {
  for (const q of ['recall', 'reports revenue', 'treasury']) {
    const big = (await as(db, uid, () => rows(db, `select api.search($1, null, 30) r`, [q])))[0].r.items.map((c) => c.id);
    let cur = null; const seen = [];
    for (let i = 0; i < 40; i++) {
      const p = (await as(db, uid, () => rows(db, `select api.search($1, $2, 3) r`, [q, cur])))[0].r;
      seen.push(...p.items.map((c) => c.id)); cur = p.next_cursor; if (!cur) break;
    }
    const dup = seen.length - new Set(seen).size;
    const same = big.every((id, i) => seen[i] === id);
    console.log(`paging ${who.padEnd(9)} "${q}": ${seen.length} cards in pages of 3, ${dup} repeats, first 30 equal one big page: ${same}`);
  }
}
await db.close();
