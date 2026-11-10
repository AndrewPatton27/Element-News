// Offline recommendation evaluation in PGlite (not a pass/fail check): the real SQL feeds on the synthetic corpus.
// usage: node supabase/tests/eval/feed-eval.mjs [--scale N] [--sessions 4] [--v3]
//  1. Guest Trending and Latest: full scroll (no repeats, no skips), macro/finance share of the top 10 / 50, micro
//     cards per 10, non-economic Federal Register cards per 10, longest same-topic run, age of the top 10; again
//     with fedreg_noneconomic_micro = 1.
//  2. For you with synthetic readers (personas below): each session opens a new For you scroll, reads the first
//     page, and reacts like the persona (view + dwell for every card, like / open detail on interesting cards,
//     dislike on topics they avoid). Per session: precision of the top 10 against the persona's interests,
//     distinct topics, novelty (not shown in an earlier session), macro share. Baseline: the guest Trending top 10.
//     --v3 also runs the v3 ranker (foryou_ml_mode = 3, which stays OFF in production) for comparison.
//  3. Full For you scroll after the sessions: no repeats, every eligible card once, seen cards last.
//  4. Following: tickers + topics of the tech persona, reasons, no repeats.
//  5. Timing of the first page of each RPC.
import { makeDb, rows, as } from './db.mjs';
import { synthCorpus, loadCards, SECTOR, rng } from './corpus.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scale = Number(arg('--scale', 1));
const SESSIONS = Number(arg('--sessions', 4));
const MACRO = ['economy', 'personal-finance', 'markets', 'earnings', 'deals', 'energy', 'insider'];

const t0 = Date.now();
const db = await makeDb();
await db.exec(`update core.blurbs set status = 'hidden'`);
const corpus = synthCorpus(11, scale);
const ids = await loadCards(db, corpus);
const byId = new Map(ids.map((id, i) => [id, corpus[i]]));
const gated = new Set((await rows(db, `select unnest(core.micro_gated_ids(array_agg(id))) id from core.blurbs where status = 'published'`)).map((r) => r.id));
const macroIds = new Set((await rows(db, `select (c->>'id') id from jsonb_array_elements(core.cards_json((select array_agg(id) from core.blurbs where status='published'), null)) c
   where core.is_macro_card(c, array['economy','personal-finance','markets','earnings','deals','energy','insider'])`)).map((r) => r.id));
const nonEconFR = (c) => c && c._topic === 'faa';
const micro = (c) => c && ['safety', 'science'].includes(c.category);
console.log(`setup ${((Date.now() - t0) / 1000).toFixed(0)} s: ${ids.length} cards, ${gated.size} recalls left out of the feeds (not material), ${ids.length - gated.size} eligible`);

async function scroll(uid, call, limit = 10, max = 200) {
  const out = []; let cur = null; let seenFrom = null;
  for (let i = 0; i < max; i++) {
    const r = (await as(db, uid, () => rows(db, call, [cur, limit])))[0].r;
    if (r.seen_from != null && seenFrom == null) seenFrom = out.length + Number(r.seen_from);
    out.push(...r.items.map((c) => c.id)); cur = r.next_cursor; if (!cur) break;
  }
  return { ids: out, seenFrom };
}
function listStats(list) {
  const cs = list.map((id) => byId.get(id));
  const share = (n) => list.slice(0, n).filter((id) => macroIds.has(id)).length / Math.min(n, list.length);
  const perTen = (f, upto) => { let mx = 0; for (let i = 0; i + 10 <= Math.min(upto, cs.length); i++) mx = Math.max(mx, cs.slice(i, i + 10).filter(f).length); return mx; };
  let run = 1, maxRun = 1; for (let i = 1; i < Math.min(50, cs.length); i++) { run = cs[i]?.category === cs[i - 1]?.category ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
  const ages = cs.slice(0, 10).map((c) => (Date.now() - Date.parse(c.at)) / 36e5).sort((a, b) => a - b);
  return { n: list.length, dup: list.length - new Set(list).size, macro10: share(10), macro50: share(50), micro50: perTen(micro, 50), fr50: perTen(nonEconFR, 50), maxRun, age10: ages[5] };
}
const fmt = (s) => `${s.n} cards, ${s.dup} repeats | macro top10 ${(s.macro10 * 100).toFixed(0)}% top50 ${(s.macro50 * 100).toFixed(0)}% | max per 10 in top 50: micro ${s.micro50}, non-econ FedReg ${s.fr50} | longest topic run ${s.maxRun} | median age top10 ${s.age10.toFixed(0)} h`;

// 1. guest lists
const eligible = ids.filter((id) => !gated.has(id));
for (const sw of [0, 1]) {
  await db.query(`update core.rank_params set value = $1 where key = 'fedreg_noneconomic_micro'`, [sw]);
  for (const mode of ['top', 'latest']) {
    const { ids: list } = await scroll(null, `select api.feed('${mode}', $1, $2, null) r`);
    const missing = eligible.filter((id) => !list.includes(id)).length;
    const leaked = list.filter((id) => gated.has(id)).length;
    console.log(`guest ${mode === 'top' ? 'Trending' : 'Latest  '} fedreg switch ${sw}: ${fmt(listStats(list))} | eligible missing ${missing}, left-out recalls shown ${leaked}`);
  }
}
await db.query(`update core.rank_params set value = 0 where key = 'fedreg_noneconomic_micro'`);
const trendTop = (await scroll(null, `select api.feed('top', $1, $2, null) r`, 10, 1)).ids;

// 2. personas
const PERSONAS = [
  { name: 'rates & macro watcher', follows: ['economy'], likes: (c) => ['rates', 'inflation', 'jobs', 'gdp', 'housing', 'trade'].includes(c._topic), avoid: ['safety', 'science'] },
  { name: 'big-tech investor', follows: ['earnings'], tickers: ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMZN'], likes: (c) => SECTOR[c._co] === 'tech', avoid: ['policy', 'safety'] },
  { name: 'bank & rates investor', follows: [], likes: (c) => SECTOR[c._co] === 'bank' || c._topic === 'rates', avoid: ['science'] },
  { name: 'everything skimmer', follows: [], likes: (c) => false, skim: true, avoid: [] },
  { name: 'new reader (views only)', follows: [], likes: (c) => MACRO.includes(c.category), viewsOnly: true, avoid: [] },
];
const modes = process.argv.includes('--v3') ? [0, 3] : [0];
for (const mlMode of modes) {
  await db.query(`update core.rank_params set value = $1 where key = 'foryou_ml_mode'`, [mlMode]);
  await db.query(`update core.rank_params set value = 0 where key = 'v3_holdout_pct'`);
  console.log(`\nFor you, foryou_ml_mode = ${mlMode}${mlMode === 3 ? ' (v3, OFF in production)' : ' (formula, live)'}; P@10 = share of the top 10 the persona likes`);
  for (const [pi, p] of PERSONAS.entries()) {
    const email = `persona-${mlMode}-${pi}@example.com`;
    const uid = (await rows(db, `insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
    await db.query(`insert into core.user_prefs (user_id, followed_categories) values ($1, $2) on conflict (user_id) do update set followed_categories = excluded.followed_categories`, [uid, p.follows]);
    const base = eligible.filter((id) => p.likes(byId.get(id))).length / eligible.length;
    const trendP = trendTop.filter((id) => p.likes(byId.get(id))).length / 10;
    const r = rng(100 + pi); const shown = new Set(); const line = [];
    for (let s = 0; s < SESSIONS; s++) {
      const page = (await as(db, uid, () => rows(db, `select api.feed_for_you(null, 20) r`)))[0].r.items.map((c) => c.id);
      const top = page.slice(0, 10);
      const prec = top.filter((id) => p.likes(byId.get(id))).length / Math.max(top.length, 1);
      const topics = new Set(top.map((id) => byId.get(id).category)).size;
      const novel = top.filter((id) => !shown.has(id)).length / Math.max(top.length, 1);
      const mac = top.filter((id) => macroIds.has(id)).length / Math.max(top.length, 1);
      line.push(`s${s + 1} P@10 ${prec.toFixed(1)} topics ${topics} new ${(novel * 100).toFixed(0)}% macro ${(mac * 100).toFixed(0)}%`);
      page.forEach((id) => shown.add(id));
      for (const id of page) {
        const c = byId.get(id); const like = p.likes(c);
        const ev = [['view', null], ['dwell', p.skim ? 900 + Math.floor(r() * 1500) : like ? 8000 + Math.floor(r() * 9000) : 1200]];
        if (p.viewsOnly) ev.length = 1;
        if (!p.viewsOnly && like && r() < 0.5) ev.push(['like', null]);
        if (!p.viewsOnly && like && r() < 0.3) ev.push(['open_detail', null]);
        if (!p.viewsOnly && !like && p.avoid.includes(c.category) && r() < 0.4) ev.push(['dislike', null]);
        for (const [k, ms] of ev) {
          await db.query(`insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at) values ($1, $2, $3, $4, now() - make_interval(hours => $5)) on conflict do nothing`,
            [uid, id, k, ms, SESSIONS - s]);
        }
      }
    }
    console.log(`  ${p.name.padEnd(24)} base rate ${base.toFixed(2)} | guest Trending P@10 ${trendP.toFixed(1)} | ${line.join(' | ')}`);
    if (pi === 1 || pi === 4) {
      const sc = await scroll(uid, `select api.feed_for_you($1, $2) r`, 10);
      // For you scores cards of the last for_you_window_days (30) only, and never shows disliked cards
      const disliked = new Set((await rows(db, "select blurb_id from core.user_events where user_id = $1 and kind = 'dislike'", [uid])).map((x) => x.blurb_id));
      const inWindow = eligible.filter((id) => Date.now() - Date.parse(byId.get(id).at) < 30 * 864e5 && !disliked.has(id));
      const missing = inWindow.filter((id) => !sc.ids.includes(id)).length;
      const leaked = sc.ids.filter((id) => gated.has(id)).length;
      const liked = new Set((await rows(db, "select blurb_id from core.user_events where user_id = $1 and kind = 'like'", [uid])).map((x) => x.blurb_id));
      const seenBefore = sc.ids.slice(0, sc.seenFrom ?? sc.ids.length).filter((id) => shown.has(id) && !liked.has(id)).length; // liked cards may come back by design
      console.log(`     full scroll: ${sc.ids.length} cards, ${sc.ids.length - new Set(sc.ids).size} repeats, ${inWindow.length} eligible in the 30-day window, missing ${missing}, left-out recalls ${leaked}, seen tail from ${sc.seenFrom ?? 'n/a'}, seen (not liked) cards before the tail ${seenBefore}`);
    }
  }
}
await db.query(`update core.rank_params set value = 0 where key = 'foryou_ml_mode'`);

// 4. Following (tech persona's tickers + Earnings)
{
  const p = PERSONAS[1];
  const all = []; let cur = null;
  for (let i = 0; i < 50; i++) {
    const r = (await rows(db, `select api.following_feed($1, '{}', $2, $3, 10) r`, [['earnings'], p.tickers, cur]))[0].r;
    all.push(...r.items); cur = r.next_cursor; if (!cur) break;
  }
  const prec = all.slice(0, 10).filter((c) => p.likes(byId.get(c.id))).length / 10;
  const reasons = {}; all.forEach((c) => { reasons[c.follow_match || 'none'] = (reasons[c.follow_match || 'none'] || 0) + 1; });
  console.log(`\nFollowing (Earnings + ${p.tickers.join(',')}): ${all.length} cards, ${all.length - new Set(all.map((c) => c.id)).size} repeats, top10 tech share ${prec.toFixed(1)}, matches ${JSON.stringify(reasons)}`);
}

// 5. timing (first page, best of 3)
const uid0 = (await rows(db, `select id from auth.users where email = 'element-test-a@example.com'`))[0].id;
const T = [['feed top', null, `select api.feed('top', null, 20, null)`], ['feed latest', null, `select api.feed('latest', null, 20, null)`],
  ['feed_for_you', uid0, `select api.feed_for_you(null, 20)`], ['search "fed rate cut"', null, `select api.search('fed rate cut', null, 20)`],
  ['following_feed', null, `select api.following_feed(array['earnings'], '{}', array['AAPL','MSFT'], null, 20)`]];
const tl = [];
for (const [name, uid, sql] of T) {
  let best = 1e9; for (let i = 0; i < 3; i++) { const s = performance.now(); await as(db, uid, () => rows(db, sql)); best = Math.min(best, performance.now() - s); }
  tl.push(`${name} ${best.toFixed(0)} ms`);
}
console.log(`\ntiming (PGlite, ${ids.length} cards, indicative only): ${tl.join(' | ')}`);
await db.close();
