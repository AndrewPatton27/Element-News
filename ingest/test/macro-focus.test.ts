// Macro/finance focus (R-218, 20261116000000_macro_focus.sql): recall "material" classifier, CPSC flood limits,
// USGS / NASA narrow-source cap 1, and the new event weights in the ranking mirror. Offline: fixtures only.
import './helpers/fixtureWindows.ts';   // pins the fixture date windows (CPSC 14 days / 5 per run = the production values)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { RANK_DEFAULTS, importance, rankScore, type RankInput } from '../src/ranking.ts';
import { classifyRecall, cpscToItem, maxPrice, parseCpscJson, parseUnits, type CpscRecall } from '../src/sources/cpsc.ts';
import { narrowCap, narrowSourceType } from '../src/topicFilter.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { RawItem, Summarizer } from '../src/types.ts';

const CPSC = parseCpscJson(readFileSync(new URL('../src/fixtures/cpsc-recalls-2026-10-03.json', import.meta.url), 'utf8'));
const byNo = (n: string) => CPSC.find((r) => r.RecallNumber === n)!;
const base: CpscRecall = { RecallNumber: 'x', RecallDate: '2026-10-15T00:00:00', Title: 'Acme Recalls Widgets Due to Fire Hazard', URL: 'https://www.cpsc.gov/Recalls/2027/x' };

// ---- settings -------------------------------------------------------------------------------------------------

test('production settings: CPSC 5 new recalls per run, 14-day lookback, material thresholds; USGS and NASA cap 1', () => {
  // fixtureWindows pins CPSC to 14 days / 5 per run, which are also the production values in config.ts
  assert.equal(config.cpsc.maxPerRun, 5);
  assert.equal(config.cpsc.lookbackDays, 14);
  assert.equal(config.cpsc.materialMinUnits, 100_000);
  assert.equal(config.cpsc.materialMinValueUsd, 10_000_000);
  assert.equal(narrowCap('usgs_quake'), 1);
  assert.equal(narrowCap('nasa_release'), 1);
  assert.equal(narrowCap('faa_airworthiness_directive'), 2, 'FAA keeps the shared cap of 2');
  for (const [, t] of config.cpsc.watchNames) assert.ok((config.watchCompanies as readonly string[]).includes(t), `${t} is on the watch list`);
});

// ---- recall classifier ----------------------------------------------------------------------------------------

test('parseUnits / maxPrice', () => {
  assert.equal(parseUnits('About 42,860 (In addition, about 340 were sold in Canada)'), 42_860);
  assert.equal(parseUnits('About 1.2 million'), 1_200_000);
  assert.equal(parseUnits('About 15 thousand'), 15_000);
  assert.equal(parseUnits(undefined), 0);
  assert.equal(parseUnits('unknown'), 0);
  assert.equal(maxPrice('Amazon.com from June 2024 through September 2026 for between $44 and $56.'), 56);
  assert.equal(maxPrice('for about $1,190.50'), 1190.5);
  assert.equal(maxPrice('no price'), 0);
});

test('fixture recalls: watch-list firm, units, units x price are material; small ones are not', () => {
  const m3m = classifyRecall(byNo('27024'));                  // 3M Company, 53,634 laminators, no injuries
  assert.equal(m3m.material, true);
  assert.deepEqual(m3m.tickers, ['MMM']);
  assert.ok(m3m.reasons.includes('watch_company_MMM'));
  assert.equal(config.cpsc.watchCompanyMaterial, true, "Drew's default: a watch-list company's small recall is material");
  const off = classifyRecall(byNo('27024'), { ...config.cpsc, watchCompanyMaterial: false } as typeof config.cpsc);
  assert.equal(off.material, false, 'with the setting off, 53,634 laminators alone are not material');
  assert.deepEqual(off.tickers, ['MMM'], 'the company link is still stored');
  const swing = classifyRecall(byNo('27019'));                // 110,550 swing seats, fractures and head injuries
  assert.ok(swing.material && swing.reasons.includes('units_110550') && swing.reasons.includes('serious_injuries'), swing.reasons.join());
  const mower = classifyRecall(byNo('27016'));                // 42,860 mowers x the listed price; minor blisters only
  assert.ok(mower.material && mower.reasons.some((r) => r.startsWith('value_usd_')), mower.reasons.join());
  assert.ok(!mower.reasons.includes('serious_injuries'), 'blisters are minor');
  for (const n of ['27026', '27021', '27027', '27022']) {     // 600 cups, 100 fireplaces, 248 sleepers, 476 medals
    const c = classifyRecall(byNo(n));
    assert.equal(c.material, false, `${n}: ${c.reasons.join()}`);
    assert.deepEqual(c.reasons, ['minor']);
  }
  // "Risk of Serious Injury or Death" in nearly every title is NOT a severity signal
  assert.ok(CPSC.filter((r) => /serious injury or death/i.test(r.Title ?? '')).length >= 10);
  const n = CPSC.filter((r) => classifyRecall(r).material).length;
  assert.equal(n, 4, 'four of the 14 fixture recalls are material');
});

test('severity: reported deaths or serious injuries count; "No injuries have been reported" and "no deaths" do not', () => {
  const inj = (t: string) => classifyRecall({ ...base, Injuries: [{ Name: t }] });
  assert.deepEqual(inj('The firm is aware of two deaths.').reasons, ['deaths']);
  assert.deepEqual(inj('One child died after the dresser tipped over.').reasons, ['deaths']);
  assert.deepEqual(inj('Three consumers were hospitalized.').reasons, ['serious_injuries']);
  assert.deepEqual(inj('The firm has received one report. No injuries have been reported.').reasons, ['minor']);
  assert.deepEqual(inj('None reported').reasons, ['minor']);
  assert.deepEqual(inj('Five reports of overheating; no deaths or injuries.').reasons, ['minor']);
  assert.equal(classifyRecall({ ...base, Hazards: [{ Name: 'posing a risk of serious injury or death' }] }).material, false, 'hazard wording alone is not material');
});

test('stop-sale, watch-list name in the recalling firm only (a retailer such as Amazon does not count)', () => {
  assert.ok(classifyRecall({ ...base, Description: 'The firm has agreed to stop sale of the widgets.' }).reasons.includes('stop_sale'));
  assert.deepEqual(classifyRecall({ ...base, Title: 'Walmart Recalls Mainstays Kettles' }).tickers, ['WMT']);
  assert.deepEqual(classifyRecall({ ...base, Retailers: [{ Name: 'Sold Online At: Amazon.com for about $20.' }] }).tickers, []);
  assert.deepEqual(classifyRecall({ ...base, Title: 'Acme Recalls Toys Sold Exclusively at Target' }).tickers, [], 'retailer named after "Recalls" does not count');
  assert.deepEqual(classifyRecall({ ...base, Manufacturers: [{ Name: 'Nike Inc., of Beaverton, Oregon' }] }).tickers, ['NKE']);
  assert.equal(classifyRecall({ ...base, Manufacturers: [{ Name: 'Handelsgesellschaft GmbH' }] }).tickers.length, 0, 'no partial-word match ("dell" in a longer word)');
});

test('cpscToItem attaches the verdict (material, reasons, tickers) and nothing else changes', () => {
  const r = cpscToItem(byNo('27024'), DRY_NOW) as { item: RawItem };
  assert.deepEqual(r.item.material, { material: true, reasons: ['watch_company_MMM'], tickers: ['MMM'] });
  assert.equal(r.item.category, 'safety');
  assert.doesNotMatch(r.item.summary_text, /material/);
});

// ---- pipeline: verdict stored after publish, counted in run stats; failure fails closed -----------------------------

function cpscDeps(publisher: Publisher, lines: string[]): Deps {
  const ai: Summarizer = {
    name: 'gemini', usesAi: true, model: 'm',
    async summarize() { return { headline: 'A short plain news card', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 }; },
  };
  return { fetchText: fixtureFetcher(), publisher, providers: [ai], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (l) => lines.push(l) };
}

test('cpsc pipeline: every published recall gets api.set_card_material; material / not material counted and logged', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const s = await runOnce(cpscDeps(dry.publisher, lines), { only: ['cpsc'] });
  assert.equal(s.published, 5, lines.join('\n'));                       // production cap: 5 new recalls per run
  assert.equal(dry.materials.length, 5);
  assert.equal(s.recall_material + s.recall_not_material, 5);
  assert.equal(dry.materials.filter((m) => m.material).length, s.recall_material);
  assert.ok(lines.some((l) => /^recall not material \(Safety topic only\): minor: /.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^cpsc: 14 recalls in the last 14 days, 14 candidates \(4 material\)/.test(l)), lines.join('\n'));
});

test('cpsc pipeline: a failing set_card_material is logged and the card stays published (it stays out of the feeds)', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const publisher: Publisher = { ...dry.publisher, async setCardMaterial() { throw new Error('rpc down'); } };
  const s = await runOnce(cpscDeps(publisher, lines), { only: ['cpsc'] });
  assert.equal(s.published, 5);
  assert.equal(s.failed, 0);
  assert.ok(lines.some((l) => l.startsWith('set_card_material failed (card stays out of the feeds): rpc down')));
});

// ---- narrow-source caps -----------------------------------------------------------------------------------------

test('narrow source types: USGS and NASA items are narrow; SEC is not', () => {
  const it = (source: RawItem['source'], title = 'x') => ({ source, title } as RawItem);
  assert.equal(narrowSourceType(it('usgs')), 'usgs_quake');
  assert.equal(narrowSourceType(it('nasa')), 'nasa_release');
  assert.equal(narrowSourceType(it('fedreg', 'Airworthiness Directives; Boeing')), 'faa_airworthiness_directive');
  assert.equal(narrowSourceType(it('sec_8k')), null);
});

test('usgs: at most 1 new quake card per run; the next run takes the next one (no card lost)', async () => {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const published = new Set<string>();                         // URLs an earlier run published (like ingest.items status)
  const publisher: Publisher = {
    ...dry.publisher,
    async upsertItem(item) {
      if (published.has(item.url)) return { id: 'old', is_new: false, status: 'published' };
      return dry.publisher.upsertItem(item);
    },
  };
  const d: Deps = { fetchText: fixtureFetcher(), publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (l) => lines.push(l) };
  const s1 = await runOnce(d, { only: ['usgs'] });
  assert.equal(s1.published, 1, lines.join('\n'));
  assert.equal(lines.filter((l) => l.startsWith('skip report_card_variety_cap')).length, 1);
  for (const c of dry.cards) published.add(c.sources[0].url);
  const s2 = await runOnce(d, { only: ['usgs'] });
  assert.equal(s2.published, 1, lines.join('\n'));
  assert.equal(new Set(dry.cards.map((c) => c.dedupe_key)).size, 2, 'two different quakes over two runs');
});

// ---- ranking mirror ---------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-11-09T12:00:00Z');
const card = (id: string, event_type: string, ageH: number, kind = 'government'): RankInput =>
  ({ id, kind: 'summary', event_type, sort_at: new Date(NOW - ageH * 3_600_000).toISOString(), sources: [{ name: id, kind }] });

test('weights mirror the SQL: recall 1.5, science 1.5, earnings 6', () => {
  assert.equal(RANK_DEFAULTS.eventWeights.recall, 1.5);
  assert.equal(RANK_DEFAULTS.eventWeights.science, 1.5);
  assert.equal(RANK_DEFAULTS.eventWeights.earnings, 6);
  assert.equal(importance(card('r', 'recall', 0)), 1.875);
  assert.equal(importance(card('m', 'macro_release', 0)), 10);
});

test('a fresh macro release beats a brand-new recall for any age up to 19 h (crossover 8 x log2(10 / 1.875) = 19.32 h)', () => {
  const recall = rankScore(card('r', 'recall', 0));
  for (let a = 0; a <= 19; a++) assert.ok(rankScore(card('m', 'macro_release', a)) > recall, `macro ${a} h old`);
  assert.ok(rankScore(card('m', 'macro_release', 20)) < recall, 'a 20 h old release loses on score alone (the page cap still applies)');
  // earnings (filing authority 1.0): 8 x log2(6 / 1.875) = 13.4 h head start over a new recall
  assert.ok(rankScore(card('e', 'earnings', 13, 'filing')) > recall, 'earnings 13 h old beats a new recall');
  assert.ok(rankScore(card('e', 'earnings', 14, 'filing')) < recall, 'earnings 14 h old loses on score alone');
});
