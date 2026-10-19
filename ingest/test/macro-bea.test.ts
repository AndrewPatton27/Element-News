// More FRED series (weekly / monthly / quarterly wording, "number" unit, thresholds,
// MORTGAGE30US forbidden) and the BEA release RSS (feed text only, apps.bea.gov as API host).
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { beaItemToItem } from '../src/sources/bea.ts';
import { mergeFedItems, parseRss } from '../src/sources/fed.ts';
import { buildDataCard, buildObservation, formatAmount, fredUrl, SERIES, type Point } from '../src/sources/macro.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import { validatePublish } from '../src/validate.ts';
import type { SummarizeInput, Summarizer } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const pts = (...p: [string, number][]): Point[] => p.map(([date, value]) => ({ date, value }));
const NEW = ['GASREGW', 'ICSA', 'RSAFS', 'HOUST', 'PAYEMS', 'A191RL1Q225SBEA'];

// ---- FRED series ------------------------------------------------------------------

test('new series are configured, cite the agency "via FRED", and match the migration rows', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261017010000_more_series.sql', import.meta.url), 'utf8');
  for (const id of NEW) {
    assert.ok((config.macroSeries as readonly string[]).includes(id), id);
    const s = SERIES[id];
    assert.match(s.source_short, /^.+ via FRED$/, id);
    assert.match(s.source_name, /^U\.S\. .+ via FRED$/, id);
    assert.match(s.agency.url, /^https:\/\//, id);
    const row = new RegExp(`\\('${id}',\\s*'([^']+)',\\s*'fred',\\s*'([^']+)',\\s*'([^']+)',\\s*'([^']+)',\\s*'[^']+',\\s*'[^']+',\\s*(\\d+)`).exec(sql);
    assert.ok(row, `migration row for ${id}`);
    assert.deepEqual([row[1], row[2], row[3], row[4], Number(row[5])],
      [s.label, s.source_name, s.source_short, `https://fred.stlouisfed.org/series/${id}`, s.sort_order], id);
  }
  assert.equal(Object.keys(SERIES).length, 12);
});

test('MORTGAGE30US (Freddie Mac copyright) is absent everywhere and refused', () => {
  assert.ok(!(config.macroSeries as readonly string[]).includes('MORTGAGE30US'));
  assert.equal(SERIES.MORTGAGE30US, undefined);
  assert.ok((config.forbiddenSeries as readonly string[]).includes('MORTGAGE30US'));
  assert.throws(() => fredUrl('MORTGAGE30US', '2026-01-01'), /forbidden series/);
  assert.equal(buildObservation('MORTGAGE30US', pts(['2026-10-09', 6.3], ['2026-10-16', 6.2])), null);
  for (const f of ['20261017000000_init.sql', '20261017010000_more_series.sql']) {
    const sql = readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8');
    assert.ok(!/\('MORTGAGE30US'/.test(sql), f);
  }
});

test('amount formatting', () => {
  assert.equal(formatAmount(745_021e6, 1), '745.0B');
  assert.equal(formatAmount(1_275e3, 2), '1.28M');
  assert.equal(formatAmount(199_000, 0), '199,000');
  assert.equal(formatAmount(4.331, 2), '4.33');
});

test('gas price (weekly, usd): card at >= 1% with "week of" wording; smaller move -> panel only', () => {
  const o = buildObservation('GASREGW', pts(['2026-10-05', 4.28], ['2026-10-12', 4.331]))!;
  assert.equal(o.display_value, '$4.33');
  assert.equal(o.change_text, '+1.2%');
  assert.equal(o.period_label, 'Week of Oct 12');
  const c = buildDataCard(o)!;
  assert.equal(c.headline, 'Average regular gas price rises to $4.33 in the week of Oct 12');
  assert.equal(c.body, 'The average regular gas price, what drivers pay per gallon across the U.S., was $4.33 in the week of Oct 12, up 1.2% from the prior week.');
  assert.equal(c.category, 'energy');
  assert.equal(c.macro[0].source_short, 'EIA via FRED');
  assert.deepEqual(validatePublish(c).errors, []);
  assert.equal(buildDataCard(buildObservation('GASREGW', pts(['2026-10-05', 4.30], ['2026-10-12', 4.331]))!), null, '+0.7% < 1%');
});

test('jobless claims (weekly, number): card at >= 5%, "week ending" wording, change as a count', () => {
  const o = buildObservation('ICSA', pts(['2026-10-03', 189_000], ['2026-10-10', 199_000]))!;
  assert.equal(o.display_value, '199,000');
  assert.equal(o.change_text, '+10,000');
  assert.equal(o.move, 5.29);
  const c = buildDataCard(o)!;
  assert.equal(c.headline, 'Initial jobless claims rise to 199,000 in the week ending Oct 10');
  assert.equal(c.body, 'Initial jobless claims, the number of people who newly applied for unemployment benefits, were 199,000 in the week ending Oct 10, up 10,000 from the prior week.');
  assert.equal(c.sources[0].name, 'U.S. Department of Labor');
  assert.equal(buildDataCard(buildObservation('ICSA', pts(['2026-10-03', 195_000], ['2026-10-10', 199_000]))!), null, '+2% < 5%');
});

test('monthly series: one card per new month regardless of size (retail sales, housing starts, payrolls)', () => {
  const r = buildObservation('RSAFS', pts(['2026-08-01', 739_100], ['2026-09-01', 745_021]))!;
  assert.deepEqual([r.display_value, r.change_text, r.period_label], ['$745.0B', '+0.8%', 'Sep 2026']);
  assert.equal(buildDataCard(r)!.headline, 'Retail sales rise to $745.0B in September');

  const h = buildObservation('HOUST', pts(['2026-07-01', 1_230], ['2026-08-01', 1_275]))!;
  assert.deepEqual([h.display_value, h.change_text], ['1.28M', '+45,000']);
  const hc = buildDataCard(h)!;
  assert.equal(hc.headline, 'Housing starts rise to 1.28M (annual rate) in August');
  assert.equal(hc.body, 'Housing starts, the number of new homes builders began, were 1.28M (annual rate) in August, up 45,000 from the prior month.');

  const p = buildObservation('PAYEMS', pts(['2026-08-01', 158_925], ['2026-09-01', 159_044]))!;
  const pc = buildDataCard(p)!;
  assert.equal(pc.body, 'Nonfarm payroll jobs, the total number of U.S. jobs outside farming, were 159.0M in September, up 119,000 from the prior month.');
  assert.equal(pc.category, 'economy');
  assert.equal(pc.event_type, 'macro_release');
  // a tiny monthly move still gets its card
  assert.ok(buildDataCard(buildObservation('PAYEMS', pts(['2026-08-01', 159_043], ['2026-09-01', 159_044]))!));
});

test('GDP (quarterly): "Q2 2026" period and "prior quarter" wording', () => {
  const o = buildObservation('A191RL1Q225SBEA', pts(['2026-01-01', 1.8], ['2026-04-01', 2.2]))!;
  assert.equal(o.period_label, 'Q2 2026');
  const c = buildDataCard(o)!;
  assert.equal(c.headline, 'Real GDP growth rate rises to 2.2% in Q2 2026');
  assert.equal(c.body, 'The real GDP growth rate, how fast the U.S. economy grew, at a yearly pace, was 2.2% in Q2 2026, up 0.4 points from the prior quarter.');
  assert.equal(c.macro[0].source_name, 'U.S. Bureau of Economic Analysis via FRED');
});

test('daily wording unchanged ("prior day", no date in the headline)', () => {
  const c = buildDataCard(buildObservation('DGS2', pts(['2026-10-15', 3.4], ['2026-10-16', 3.48]))!)!;
  assert.equal(c.body, 'The 2-year Treasury yield, the interest rate the U.S. government pays to borrow for 2 years, was 3.48% on Oct 16, up 0.08 points from the prior day.');
});

// ---- BEA RSS ------------------------------------------------------------------------

test('BEA fixture is labelled; apps.bea.gov is an API host only, never a page host', () => {
  assert.match(fx('bea-releases.rss.xml').slice(0, 400), /\bSYNTHETIC\b/);
  assert.equal(config.feeds.beaRss, 'https://apps.bea.gov/rss/rss.xml');
  assert.doesNotThrow(() => assertAllowed(config.feeds.beaRss, 'api'));
  assert.throws(() => assertAllowed(config.feeds.beaRss, 'page'));
  assert.throws(() => assertAllowed('https://www.bea.gov/news/2026/example-gdp-q2-2026-third', 'page'));
  assert.ok(!(config.pageHosts as readonly string[]).includes('apps.bea.gov'));
});

test('BEA items: public domain, economy / macro_release, attribution, 30-day window', () => {
  const list = parseRss(fx('bea-releases.rss.xml'));
  assert.equal(list.length, 3);
  const kept = mergeFedItems([list], new Date('2026-10-17T21:00:00Z'), config.beaMaxAgeDays);
  assert.equal(config.beaMaxAgeDays, 30);
  assert.deepEqual(kept.map((i) => i.title), [
    'U.S. International Trade in Goods and Services, August 2026',
    'Gross Domestic Product, 2nd Quarter 2026 (Third Estimate)',
  ]);
  const it = beaItemToItem(kept[0]);
  assert.equal(it.license_class, 'public_domain');
  assert.equal(it.category, 'economy');
  assert.equal(it.event_type, 'macro_release');
  assert.equal(it.attribution, 'Source: U.S. Bureau of Economic Analysis');
  assert.equal(it.source_name, 'U.S. Bureau of Economic Analysis');
  assert.ok(!/<p>|<\/p>/.test(it.summary_text), 'HTML stripped from the description');
  assert.match(it.summary_text, /^U\.S\. International Trade in Goods and Services, August 2026\. The U\.S\. goods and services trade deficit was \$61\.2 billion/);
});

test('pipeline --only bea: AI sees only the feed text, one API request, no page fetch, fixed category', async () => {
  const base = fixtureFetcher();
  const requests: { url: string; kind: string }[] = [];
  const seen: SummarizeInput[] = [];
  const ai: Summarizer = {
    name: 'gemini', usesAi: true,
    async summarize(i) {
      seen.push(i);
      // AI picks another category; BEA cards stay economy / macro_release
      return { headline: i.item.title.slice(0, 80), body: null, category: 'markets', event_type: 'earnings', tickers: [], everyday_relevance: 4 };
    },
  };
  const dry = createDryRunPublisher();
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => { requests.push({ url, kind }); return base(url, kind, ttl); },
    publisher: dry.publisher, providers: [ai, templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: new Date('2026-10-17T21:00:00Z'), log: () => {},
  };
  const s = await runOnce(deps, { only: ['bea'] });
  assert.equal(s.published, 2);
  assert.equal(s.ai, 2);
  assert.deepEqual(requests, [{ url: 'https://apps.bea.gov/rss/rss.xml', kind: 'api' }]);
  for (const i of seen) assert.equal(i.text, i.item.summary_text, 'feed text only');
  for (const c of dry.cards) {
    assert.equal(c.category, 'economy');
    assert.equal(c.event_type, 'macro_release');
    assert.equal(c.attribution, 'Source: U.S. Bureau of Economic Analysis');
    assert.equal(c.sources[0].attribution, 'Source: U.S. Bureau of Economic Analysis');
    assert.equal(c.sources[0].license_class, 'public_domain');
    assert.deepEqual(validatePublish(c).errors, []);
  }
});
