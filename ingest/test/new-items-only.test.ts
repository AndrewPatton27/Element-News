// New-items-only caps (2026-10-18): a per-run cap counts only items an earlier run has not handled.
// CPSC (max 5 NEW recalls per run), FAA airworthiness cap, Wikipedia look-back over several days,
// NASA wider window and extra feed pages. All offline: fixtures only, no network, no keys.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { cpscUrl, parseCpscJson, selectRecalls } from '../src/sources/cpsc.ts';
import { nasaFeedUrl, parseNasaRss, selectNasaReleases } from '../src/sources/nasa.ts';
import { wikiFeedUrl } from '../src/sources/wiki.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { Summarizer } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const CPSC = fx('cpsc-recalls-2026-10-03.json');

/** Dry-run publisher where the URLs in `handled` were closed by an earlier run (is_new false, status published). */
function publisherWithHandled(handled: Set<string>) {
  const dry = createDryRunPublisher();
  const upserted: string[] = [];
  const publisher: Publisher = {
    ...dry.publisher,
    async upsertItem(item) {
      upserted.push(item.url);
      if (handled.has(item.url)) return { id: `old-${upserted.length}`, is_new: false, status: 'published' };
      return dry.publisher.upsertItem(item);
    },
  };
  return { publisher, dry, upserted };
}

function ai(seenTitles: string[], relevance = 4): Summarizer {
  return {
    name: 'gemini', usesAi: true, model: 'm',
    async summarize(i) {
      seenTitles.push(i.item.title);
      return { headline: 'A short plain news card', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: relevance };
    },
  };
}

function setup(handled: Set<string>, fetchText: Deps['fetchText'] = fixtureFetcher(), titles: string[] = []) {
  const p = publisherWithHandled(handled);
  const lines: string[] = [];
  const requests: string[] = [];
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => { requests.push(url); return fetchText(url, kind, ttl); },
    publisher: p.publisher, providers: [ai(titles)], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (l) => lines.push(l),
  };
  return { deps, lines, requests, titles, ...p };
}

// ---- CPSC ---------------------------------------------------------------------------------------

const recalls = selectRecalls(parseCpscJson(CPSC), DRY_NOW);       // all of the lookback window, newest first
const recallUrls = recalls.map((r) => r.URL!);

test('cpsc: selectRecalls no longer caps by default (the cap counts new recalls in the pipeline); an explicit cap still works', () => {
  assert.equal(config.cpsc.maxPerRun, 5);
  assert.equal(recalls.length, 14, 'the whole 14-day window is considered');
  assert.equal(selectRecalls(parseCpscJson(CPSC), DRY_NOW, 5).length, 5);
  for (let i = 1; i < recalls.length; i++) assert.ok(recalls[i - 1].RecallDate! >= recalls[i].RecallDate!, 'newest first');
});

test('cpsc: recalls already handled by an earlier run do not use up the 5-per-run cap; the next unprocessed ones are taken', async () => {
  const first5 = new Set(recallUrls.slice(0, 5));
  const t = setup(first5);
  const s = await runOnce(t.deps, { only: ['cpsc'] });
  assert.equal(s.published, 5, t.lines.join('\n'));
  assert.deepEqual(t.dry.cards.map((c) => c.dedupe_key), recallUrls.slice(5, 10), 'recalls 6 to 10, newest first');
  assert.equal(t.titles.length, 5, 'one AI call per new recall, none for the handled ones');
  assert.equal(t.upserted.length, 10, 'the 4 recalls after the cap are not even recorded');
  assert.ok(t.lines.some((l) => /^cpsc: 14 recalls in the last 14 days, 14 candidates, 5 already handled, 5 new processed \(max 5 new per run\)$/.test(l)), t.lines.join('\n'));
  assert.ok(t.lines.includes('new-item limit reached (5 new per run)'));
});

test('cpsc: fewer than 5 unprocessed recalls left = only those; everything handled = no AI call and nothing published', async () => {
  const t = setup(new Set(recallUrls.slice(0, 12)));
  const s = await runOnce(t.deps, { only: ['cpsc'] });
  assert.equal(s.published, 2);
  assert.deepEqual(t.dry.cards.map((c) => c.dedupe_key), recallUrls.slice(12));

  const all = setup(new Set(recallUrls));
  const s2 = await runOnce(all.deps, { only: ['cpsc'] });
  assert.equal(s2.published, 0);
  assert.equal(all.titles.length, 0);
  assert.equal(s2.skipped, 14);
});

test('cpsc: with nothing handled the first run still takes exactly the newest 5; a skipped (low relevance) recall counts as processed', async () => {
  const t = setup(new Set());
  const s = await runOnce(t.deps, { only: ['cpsc'] });
  assert.equal(s.published, 5);
  assert.deepEqual(t.dry.cards.map((c) => c.dedupe_key), recallUrls.slice(0, 5));

  // low-relevance recalls are closed by the pipeline (item 'skipped'), so they count against this run's 5 and are not retried
  const low = setup(new Set(), fixtureFetcher(), []);
  low.deps.providers = [ai([], 2)];
  const s2 = await runOnce(low.deps, { only: ['cpsc'] });
  assert.equal(s2.published, 0);
  assert.equal(low.upserted.length, 5);
});

// ---- FAA airworthiness cap: same idea ----------------------------------------------------------------

const frDoc = (n: number, title: string) => ({
  document_number: `2026-4000${n}`, title, abstract: `The agency issued rule number ${n}.`,
  html_url: `https://www.federalregister.gov/documents/2026/10/16/2026-4000${n}/x`, publication_date: `2026-10-${String(16 - n).padStart(2, '0')}`,
  type: 'Rule', agencies: [{ name: 'Federal Aviation Administration', parent_id: 492 }],
});

test('FAA cap counts only NEW directives: an already-handled newest directive no longer hides the next one', async () => {
  const docs = [
    frDoc(1, 'Airworthiness Directives; The Boeing Company Airplanes'),   // handled by an earlier run
    frDoc(2, 'Airworthiness Directives; Pratt & Whitney Engines'),
    frDoc(3, 'Revision of Class E Airspace'),
    frDoc(4, 'Airworthiness Directive; Boeing 787'),
  ];
  const handled = new Set([docs[0].html_url]);
  const t = setup(handled, async () => JSON.stringify({ count: 4, results: docs }));
  const s = await runOnce(t.deps, { only: ['fedreg'] });
  assert.deepEqual(t.titles, ['Airworthiness Directives; Pratt & Whitney Engines', 'Revision of Class E Airspace']);
  assert.equal(s.published, 2);
  assert.equal(t.lines.filter((l) => l.startsWith('skip faa_directive_cap (max 1 airworthiness directive per run)')).length, 1, t.lines.join('\n'));
  assert.equal(t.upserted.includes(docs[3].html_url), false, 'the capped directive is not recorded');
});

// The defaults read today's Wikipedia feed only and NASA feed page 1 only (live runs: past-day feeds had 0 news,
// NASA ?paged=2 answers HTTP 403). The multi-day / multi-page code paths stay tested by raising the value here.
async function withConfig<T>(obj: object, key: string, value: number, fn: () => Promise<T>): Promise<T> {
  const o = obj as Record<string, number>;
  const was = o[key];
  try {
    o[key] = value;
    return await fn();
  } finally {
    o[key] = was;
  }
}

// ---- Wikipedia: look-back over several days -------------------------------------------------------------

test('wiki url: daysBack walks back whole UTC days across month and year ends', () => {
  assert.equal(config.wiki.lookbackDays, 1);
  assert.equal(wikiFeedUrl(DRY_NOW), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/17');
  assert.equal(wikiFeedUrl(DRY_NOW, 1), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/16');
  assert.equal(wikiFeedUrl(new Date('2026-11-01T01:00:00Z'), 2), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/30');
  assert.equal(wikiFeedUrl(new Date('2027-01-01T00:30:00Z'), 1), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/12/31');
  assert.doesNotThrow(() => assertAllowed(wikiFeedUrl(DRY_NOW, 2), 'api'));
  assert.throws(() => assertAllowed(wikiFeedUrl(DRY_NOW, 2), 'page'), /page host not allowed/);
});

test('wiki pipeline (lookbackDays 3): reads today and the 2 days before; a story on several days becomes one card; a day with no news list is fine', async () => {
  const t = setup(new Set());
  const s = await withConfig(config.wiki, 'lookbackDays', 3, () => runOnce(t.deps, { only: ['wiki'] }));
  assert.deepEqual(t.requests, [wikiFeedUrl(DRY_NOW), wikiFeedUrl(DRY_NOW, 1), wikiFeedUrl(DRY_NOW, 2)]);
  assert.equal(s.published, 5, '4 stories today + 1 only yesterday; Navi Pillay is in both feeds');
  assert.equal(t.dry.cards.filter((c) => c.dedupe_key === 'https://en.wikipedia.org/wiki/Navi_Pillay').length, 1);
  const flood = t.dry.cards.find((c) => c.dedupe_key === 'https://en.wikipedia.org/wiki/Example_City_flood')!;
  assert.ok(flood, 'yesterday-only story is published');
  assert.equal(flood.sort_at, '2026-10-15T00:00:00.000Z', 'dated by its <!--Oct 15--> comment');
  assert.ok(t.lines.some((l) => /^wiki: 3 days read \(2026-10-17: 4 stories, 4 new to this run; 2026-10-16: 2 stories, 1 new to this run; 2026-10-15: 0 stories, 0 new to this run\); 5 candidates, 5 new, 0 already handled$/.test(l)), t.lines.join('\n'));
  assert.ok(t.dry.cards.every((c) => c.category === 'world' && c.sources[0].license_class === 'cc_by_sa' && /^Adapted from Wikipedia /.test(c.attribution!)));
});

test('wiki pipeline (lookbackDays 3): stories handled in an earlier run are skipped without an AI call; the newer-day story is still picked up', async () => {
  const base = setup(new Set());
  await withConfig(config.wiki, 'lookbackDays', 3, () => runOnce(base.deps, { only: ['wiki'] }));
  const handled = new Set(base.dry.cards.map((c) => c.dedupe_key).filter((u) => u !== 'https://en.wikipedia.org/wiki/Example_City_flood'));
  const t = setup(handled);
  const s = await withConfig(config.wiki, 'lookbackDays', 3, () => runOnce(t.deps, { only: ['wiki'] }));
  assert.equal(s.published, 1);
  assert.equal(t.titles.length, 1);
  assert.ok(t.lines.some((l) => /4 already handled/.test(l)), t.lines.join('\n'));
});

test('wiki pipeline: a failing past day is logged and the other days still run (lookbackDays 3); the default reads today only', async () => {
  const fixture = fixtureFetcher();
  const failYesterday: Deps['fetchText'] = async (url, kind, ttl) => {
    if (url === wikiFeedUrl(DRY_NOW, 1)) throw new Error('HTTP 404 from en.wikipedia.org');
    return fixture(url, kind, ttl);
  };
  const t = setup(new Set(), failYesterday);
  const s = await withConfig(config.wiki, 'lookbackDays', 3, () => runOnce(t.deps, { only: ['wiki'] }));
  assert.equal(s.published, 4);
  assert.deepEqual(t.requests, [wikiFeedUrl(DRY_NOW), wikiFeedUrl(DRY_NOW, 1), wikiFeedUrl(DRY_NOW, 2)], 'the failing day does not stop the next one');
  assert.ok(t.lines.includes('wiki: feed for 2026-10-16 failed: HTTP 404 from en.wikipedia.org'), t.lines.join('\n'));

  // default (lookbackDays 1): today only; the failing past day is never requested, so no failure is logged
  assert.equal(config.wiki.lookbackDays, 1);
  const one = setup(new Set(), failYesterday);
  const s1 = await runOnce(one.deps, { only: ['wiki'] });
  assert.deepEqual(one.requests, [wikiFeedUrl(DRY_NOW)]);
  assert.equal(s1.published, 4, "4 stories in today's feed");
  assert.ok(!one.lines.some((l) => /feed for .* failed/.test(l)), one.lines.join('\n'));
  assert.ok(one.lines.some((l) => /^wiki: 1 days read \(2026-10-17: 4 stories, 4 new to this run\); 4 candidates, 4 new, 0 already handled$/.test(l)), one.lines.join('\n'));
});

// ---- NASA --------------------------------------------------------------------------------------------------

test('nasa: window is 14 days; only real news releases count (image articles, APOD and blog posts are dropped); pages overlap safely', () => {
  assert.equal(config.nasa.maxAgeDays, 14);
  assert.equal(config.nasa.feedPages, 1);
  assert.equal(nasaFeedUrl(1), 'https://www.nasa.gov/news-release/feed/');
  assert.equal(nasaFeedUrl(2), 'https://www.nasa.gov/news-release/feed/?paged=2');
  assert.doesNotThrow(() => assertAllowed(nasaFeedUrl(2), 'api'));
  const all = [...parseNasaRss(fx('nasa-news-release.rss.xml')), ...parseNasaRss(fx('nasa-news-release-page2.rss.xml'))];
  assert.equal(all.length, 8);
  const links = selectNasaReleases(all, DRY_NOW).map((i) => i.link);
  assert.deepEqual(links, [
    'https://www.nasa.gov/news-release/nasa-names-stephen-cash-marshall-space-flight-center-director/',      // listed on both pages, kept once
    'https://www.nasa.gov/news-release/nasa-sets-launch-date-for-example-weather-satellite/',                // 9 days old: inside 14, outside 7
  ]);
  assert.deepEqual(selectNasaReleases(all, DRY_NOW, 7).map((i) => i.link), [links[0]], 'the old 7-day window would have dropped it');
  assert.ok(!links.some((l) => /image-article|blogs|apod/.test(l)));
});

test('nasa pipeline (feedPages 2): reads feed page 1 and page 2, publishes both recent news releases, skips ones an earlier run handled', async () => {
  const t = setup(new Set());
  const s = await withConfig(config.nasa, 'feedPages', 2, () => runOnce(t.deps, { only: ['nasa'] }));
  assert.deepEqual(t.requests, [nasaFeedUrl(1), nasaFeedUrl(2)]);
  assert.equal(s.published, 2, t.lines.join('\n'));
  assert.ok(t.dry.cards.every((c) => c.category === 'science' && c.sources[0].name === 'NASA'));
  assert.ok(t.lines.some((l) => /^nasa: 8 feed items over 2 page\(s\), 2 news releases in the last 14 days, 0 already handled, 2 new$/.test(l)), t.lines.join('\n'));

  const again = setup(new Set(t.dry.cards.map((c) => c.dedupe_key)));
  const s2 = await withConfig(config.nasa, 'feedPages', 2, () => runOnce(again.deps, { only: ['nasa'] }));
  assert.equal(s2.published, 0);
  assert.equal(again.titles.length, 0);
  assert.ok(again.lines.some((l) => /2 already handled, 0 new$/.test(l)), again.lines.join('\n'));
});

test('nasa pipeline: a failing page 2 is logged and page 1 still publishes (feedPages 2); the default never requests page 2', async () => {
  const fixture = fixtureFetcher();
  const t = setup(new Set(), async (url, kind, ttl) => {
    if (url === nasaFeedUrl(2)) throw new Error('HTTP 404 from www.nasa.gov');
    return fixture(url, kind, ttl);
  });
  const s = await withConfig(config.nasa, 'feedPages', 2, () => runOnce(t.deps, { only: ['nasa'] }));
  assert.equal(s.published, 1);
  assert.ok(t.lines.includes('nasa: feed page 2 failed (continuing): HTTP 404 from www.nasa.gov'), t.lines.join('\n'));

  // default (feedPages 1): only page 1 is requested, so the failing page 2 is never hit
  assert.equal(config.nasa.feedPages, 1);
  const one = setup(new Set(), async (url, kind, ttl) => {
    if (url === nasaFeedUrl(2)) throw new Error('HTTP 403 from www.nasa.gov');
    return fixture(url, kind, ttl);
  });
  const s1 = await runOnce(one.deps, { only: ['nasa'] });
  assert.deepEqual(one.requests, [nasaFeedUrl(1)]);
  assert.equal(s1.published, 1, 'only the page 1 release; the 9-day-old release is on page 2');
  assert.ok(!one.lines.some((l) => /feed page 2 failed/.test(l)), one.lines.join('\n'));
});

test('cpscUrl is unchanged by the new-only cap (14-day lookback, one request)', async () => {
  const t = setup(new Set());
  await runOnce(t.deps, { only: ['cpsc'] });
  assert.deepEqual(t.requests, [cpscUrl(DRY_NOW)]);
});
