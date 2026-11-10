// M9 workstream 9: data-card templates (bp, no filler bullets, why-it-matters, Economy), the daily Treasury
// yield-curve card (ticker and card read the same observation), the agency detail stub. Offline, no AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { templateDetail } from '../src/detail.ts';
import { buildDataCard, buildObservation, buildYieldCurveCard, CURVE_SERIES, observationFromFact, SERIES, WHY, type Point } from '../src/sources/macro.ts';
import { checkDetailShape, findAdvice } from '../src/validate.ts';
import type { RawItem } from '../src/types.ts';

const pts = (...p: [string, number][]): Point[] => p.map(([date, value]) => ({ date, value }));
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// fictional readings, two days
const D1 = '2026-11-05', D2 = '2026-11-06';
const curve = (over: Record<string, Point[]> = {}): Record<string, Point[]> => ({
  DGS2: pts([D1, 4.46], [D2, 4.51]),
  DGS5: pts([D1, 4.58], [D2, 4.62]),
  DGS10: pts([D1, 4.84], [D2, 4.86]),
  DGS30: pts([D1, 5.02], [D2, 5.01]),
  ...over,
});

test('rates read in basis points, never "pts"; unemployment, GDP and CPI keep percentage points', () => {
  const o = buildObservation('DGS10', pts([D1, 4.84], [D2, 4.86]))!;
  assert.equal(o.change_text, '+2 bp');
  assert.equal(o.move, 0.02, 'thresholds stay in percentage points');
  assert.equal(buildObservation('DGS10', pts([D1, 4.86], [D2, 4.83]))!.change_text, '-3 bp');
  assert.equal(buildObservation('DGS10', pts([D1, 4.86], [D2, 4.86]))!.change_text, '0 bp');
  assert.equal(buildObservation('DGS10', pts([D1, 4.86], [D2, 4.86]))!.direction, 'flat');
  assert.equal(buildObservation('DFF', pts([D1, 3.88], [D2, 3.83]))!.change_text, '-5 bp');
  assert.match(buildObservation('UNRATE', pts(['2026-08-01', 4.1], ['2026-09-01', 4.2]))!.change_text!, /pts$/);
  const card = buildDataCard(buildObservation('DFF', pts([D1, 3.88], [D2, 3.83]))!)!;
  assert.match(card.body!, /down 5 basis points/);
  assert.doesNotMatch(JSON.stringify(card), /\bpts\b|0\.05 points/);
  assert.match(buildDataCard(buildObservation('DFF', pts([D1, 3.88], [D2, 3.89]))!, [], { force: true })!.body!, /up 1 basis point from/);
});

test('every series: Economy or Energy category, a why-it-matters line, no repeat of the definition, no advice or forecast', () => {
  for (const [id, s] of Object.entries(SERIES)) {
    assert.ok(['economy', 'energy'].includes(s.category), `${id} is ${s.category}`);
    assert.ok(WHY[id], `${id} has a why line`);
    assert.equal(findAdvice(WHY[id]).length, 0, `${id}: advice word in why line`);
    assert.doesNotMatch(WHY[id], /\b(will|expect|expected|forecast|predict|likely|should|could)\b/i, `${id}: prediction wording`);
    assert.ok(!s.about.includes(WHY[id]) && !WHY[id].includes(s.about), `${id}: why repeats about`);
  }
  assert.ok(WHY.YIELDCURVE);
});

test('data card detail: no Change or Period filler bullets, 3-5 short key points, why line in the sheet, template label kept', () => {
  const card = buildDataCard(buildObservation('PAYEMS', pts(['2026-08-01', 158_925], ['2026-09-01', 159_044]))!)!;
  assert.equal(card.ai_generated, false, 'template card: the app shows "No AI used"');
  assert.equal(card.category, 'economy');
  const kp = card.detail!.key_points;
  assert.deepEqual(checkDetailShape(card.detail), []);
  assert.ok(kp.length >= 3 && kp.length <= 5 && kp.every((k) => words(k) <= 15), kp.join(' | '));
  assert.ok(!kp.some((k) => /^(Change|Period):/.test(k)), kp.join(' | '));
  assert.ok(card.detail!.paragraphs.some((p) => p.includes(WHY.PAYEMS)));
  assert.ok(card.body!.endsWith(WHY.PAYEMS));
  const rate = buildDataCard(buildObservation('DFF', pts([D1, 3.88], [D2, 3.83]))!, [], { targetRange: '3.75% to 4.00%' })!;
  assert.ok(rate.detail!.key_points.includes('Fed target range: 3.75% to 4.00%'));
  assert.match(rate.headline, /^Effective fed funds rate falls to 3\.83%/, 'effective rate is labelled as such');
  assert.equal(rate.macro[0].label, 'Fed funds (effective)');
  assert.equal(rate.category, 'economy');
});

test('fed funds card cites the agency and the FRED wording is unchanged (never bare FRED)', () => {
  const card = buildDataCard(buildObservation('DFF', pts([D1, 3.88], [D2, 3.83]))!)!;
  assert.equal(card.macro[0].source_name, 'Board of Governors of the Federal Reserve System (US) via FRED');
  assert.equal(card.macro[0].source_short, 'Federal Reserve via FRED');
  assert.equal(card.sources[0].name, 'Federal Reserve Board');
  for (const s of Object.values(SERIES)) assert.notEqual(s.source_short, 'FRED');
});

test('stored facts with the old "pts" wording are read as basis points (--rewrite)', () => {
  const o = observationFromFact({ series_id: 'DGS10', label: '10-yr Treasury', value: '4.86%', change: '+0.05 pts', direction: 'up', period: null, as_of: '2026-11-06', source_name: 'x', source_short: 'y', source_url: 'https://z', sort_order: 2 })!;
  assert.equal(o.change_text, '+5 bp');
});

test('Treasury maturities no longer get one card each: numbers panel only', () => {
  for (const id of ['DGS2', 'DGS3MO', 'DGS5', 'DGS10', 'DGS30']) {
    const o = buildObservation(id, pts([D1, 4.0], [D2, 4.5]))!;   // a 50 bp move
    assert.equal(buildDataCard(o), null, id);
  }
});

test('yield-curve card: one card, 2/5/10/30-year and the 2s10s gap in basis points, economy, agency source', () => {
  const c = buildYieldCurveCard(curve())!;
  assert.equal(c.dedupe_key, `YIELDCURVE:${D2}`);
  assert.equal(c.kind, 'data');
  assert.equal(c.category, 'economy');
  assert.equal(c.ai_generated, false);
  assert.equal(c.headline, 'Treasury yields mixed, 10-year at 4.86%');
  assert.ok(c.headline.length <= config.headlineMaxChars);
  assert.match(c.body!, /^The 2-year yield was up 5 basis points and the 10-year up 2 basis points from the prior day\./);
  assert.ok(c.body!.endsWith(WHY.YIELDCURVE));
  assert.deepEqual(c.detail!.key_points, [
    '2-year: 4.51% (+5 bp)', '5-year: 4.62% (+4 bp)', '10-year: 4.86% (+2 bp)', '30-year: 5.01% (-1 bp)', '10-year minus 2-year: 35 bp (-3 bp)',
  ]);
  assert.deepEqual(checkDetailShape(c.detail), []);
  assert.match(c.detail!.paragraphs[0], /On Nov 6, 2026, Treasury yields were 2-year 4\.51%, 5-year 4\.62%, 10-year 4\.86%, 30-year 5\.01%\./);
  assert.match(c.detail!.paragraphs[1], /35 basis points above the 2-year yield, a narrower gap/);
  assert.equal(c.sources[0].url, 'https://www.federalreserve.gov/releases/h15/');
  assert.equal(c.sources[0].license_class, 'public_domain');
  assert.equal(c.macro.length, 3);
  assert.deepEqual(c.macro.map((m) => m.series_id), ['DGS10', 'DGS2', 'SPREAD_10Y2Y']);
  assert.ok(c.macro.every((m) => m.source_short.endsWith('via FRED') && m.source_short !== 'FRED'));
  assert.equal(c.macro[2].source_url, 'https://fred.stlouisfed.org/series/DGS10', 'the derived gap links to a real FRED page');
  assert.doesNotMatch(JSON.stringify(c), /\bpts\b/);
  assert.equal(findAdvice(`${c.headline} ${c.body} ${c.detail!.paragraphs.join(' ')}`).length, 0);
});

test('yield-curve card and the Numbers ticker read the same observation (value and date)', () => {
  const ticker = buildObservation('DGS10', curve().DGS10)!;      // what api.upsert_macro stores and the ticker shows
  const card = buildYieldCurveCard(curve())!;
  const fact = card.macro.find((m) => m.series_id === 'DGS10')!;
  assert.equal(fact.value, ticker.display_value);
  assert.equal(fact.change, ticker.change_text);
  assert.equal(fact.as_of.slice(0, 10), ticker.obs_date);
  assert.equal(card.dedupe_key.split(':')[1], ticker.obs_date);
});

test('yield-curve card: skipped (retried next run) when a maturity lags the 10-year or is missing', () => {
  assert.equal(buildYieldCurveCard(curve({ DGS30: pts(['2026-11-04', 5.0], [D1, 5.02]) })), null, '30-year has no Nov 6 reading yet');
  assert.equal(buildYieldCurveCard({ ...curve(), DGS5: undefined }), null);
  assert.equal(buildYieldCurveCard(curve({ DGS2: pts([D2, 4.51]) })), null, 'no prior reading, no change to report');
});

test('yield-curve card: all up, all down, unchanged wording; default threshold is every new reading', () => {
  const up = buildYieldCurveCard(curve({ DGS30: pts([D1, 5.0], [D2, 5.03]) }))!;
  assert.match(up.headline, /^Treasury yields rise, /);
  const down = buildYieldCurveCard({ DGS2: pts([D1, 4.5], [D2, 4.4]), DGS5: pts([D1, 4.6], [D2, 4.5]), DGS10: pts([D1, 4.9], [D2, 4.8]), DGS30: pts([D1, 5.1], [D2, 5.0]) })!;
  assert.match(down.headline, /^Treasury yields fall, /);
  const flat = buildYieldCurveCard({ DGS2: pts([D1, 4.5], [D2, 4.5]), DGS5: pts([D1, 4.6], [D2, 4.6]), DGS10: pts([D1, 4.9], [D2, 4.9]), DGS30: pts([D1, 5.1], [D2, 5.1]) })!;
  assert.match(flat.headline, /^Treasury yields unchanged, /);
  assert.match(flat.body!, /unchanged and the 10-year unchanged/);
  assert.equal(config.yieldCurve.minMovePoints, 0, 'default: a card on every new reading (only the newest stays live)');
  assert.equal(CURVE_SERIES.length, 4);
});

test('an inverted curve is described plainly (gap below the 2-year)', () => {
  const c = buildYieldCurveCard({ DGS2: pts([D1, 4.9], [D2, 4.95]), DGS5: pts([D1, 4.7], [D2, 4.7]), DGS10: pts([D1, 4.6], [D2, 4.6]), DGS30: pts([D1, 4.8], [D2, 4.8]) })!;
  assert.match(c.detail!.paragraphs[1], /35 basis points below the 2-year yield/);
  assert.equal(c.detail!.key_points[4], '10-year minus 2-year: -35 bp (-5 bp)');
});

test('agency detail stub: plain sentences, no "From / Published / Title" field dump', () => {
  const it: RawItem = {
    source: 'fed_rss', external_id: 'x', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261104a.htm',
    title: 'Federal Reserve issues FOMC statement', published_at: '2026-11-04T19:00:00Z', license_class: 'public_domain',
    category: 'policy', event_type: null, tickers: [], source_name: 'Federal Reserve Board', source_kind: 'government',
    doc_label: 'Press release', summary_text: 'x',
  };
  const d = templateDetail(it)!;
  assert.deepEqual(checkDetailShape(d), []);
  assert.ok(d.key_points.every((k) => !/^(From|Published|Title):/.test(k) && words(k) <= 15), d.key_points.join(' | '));
  assert.equal(d.key_points[0], 'Published by Federal Reserve Board on Nov 4, 2026');
  assert.equal(d.key_points[1], 'The Federal Reserve is the U.S. central bank');
  assert.match(d.paragraphs[0], /Federal Reserve issues FOMC statement/);
});
