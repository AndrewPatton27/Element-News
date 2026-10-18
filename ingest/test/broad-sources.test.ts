// Broad topics (PM review 2): Wikipedia "In the news" (world), CPSC recalls (safety), USGS
// significant earthquakes (science), plus the contract consistency check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher, parseArgs } from '../src/main.ts';
import { runOnce, templateAllowed, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { cpscToItem, cpscUrl, parseCpscJson, selectRecalls } from '../src/sources/cpsc.ts';
import { nasaToItem, parseNasaRss, selectNasaReleases } from '../src/sources/nasa.ts';
import { isAtSea, lowInterestReason, parseUsgsGeoJson, plainQuakeLocation, usgsDraft, usgsHeadline, usgsToItem, type UsgsFeature } from '../src/sources/usgs.ts';
import { parseWikiFeed, storyDate, storyText, wikiFeedUrl, wikiItemToItem, wikimediaUserAgent } from '../src/sources/wiki.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { RESPONSE_SCHEMA } from '../src/summarizer/gemini.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import { AI_CATEGORY_SLUGS, CATEGORY_SLUGS, validateDraft, validatePublish } from '../src/validate.ts';
import type { RawItem, SummarizeInput, Summarizer } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const root = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const WIKI = fx('wiki-featured-2026-10-17.json');      // RECONSTRUCTED (news array verbatim)
const CPSC = fx('cpsc-recalls-2026-10-03.json');       // REAL
const USGS = fx('usgs-significant-week.geojson');      // REAL

function deps(providers: Summarizer[], only?: string) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const requests: { url: string; kind: string }[] = [];
  const base = fixtureFetcher();
  const d: Deps = {
    fetchText: async (url, kind, ttl) => { requests.push({ url, kind }); return base(url, kind, ttl); },
    publisher: dry.publisher, providers, counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (s) => lines.push(s),
  };
  void only;
  return { d, dry, lines, requests };
}

/** Fake AI: plain headline from the item, relevance 4, a category the code must override. */
function fakeAi(seen: SummarizeInput[], relevance = 4): Summarizer {
  return {
    name: 'gemini', usesAi: true, model: 'm',
    async summarize(i) {
      seen.push(i);
      return { headline: "A short plain news card", body: null, category: 'policy', event_type: 'fed', tickers: [], everyday_relevance: relevance };
    },
  };
}

// ---- contract consistency ------------------------------------------------------------

test('category lists agree: contract CategorySlug = categories.json = DB seed = CATEGORY_SLUGS; AI enum is the original 9', () => {
  const types = root('contract/types.ts');
  const block = /export type CategorySlug =([\s\S]*?);/.exec(types)![1];
  const fromTypes = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  const fromJson = (JSON.parse(root('contract/fixtures/categories.json')) as { slug: string }[]).map((c) => c.slug).sort();
  const seed = new Set<string>();
  for (const f of ['supabase/migrations/20261017000000_init.sql', 'supabase/migrations/20261017020000_broad_topics.sql']) {
    const sql = root(f);
    const ins = /insert into core\.categories[^;]*?values([\s\S]*?)on conflict/i.exec(sql)![1];
    for (const m of ins.matchAll(/\('([a-z-]+)',/g)) seed.add(m[1]);
  }
  assert.deepEqual(fromJson, fromTypes);
  assert.deepEqual([...seed].sort(), fromTypes);
  assert.deepEqual([...CATEGORY_SLUGS].sort(), fromTypes);
  assert.deepEqual([...AI_CATEGORY_SLUGS], ['markets', 'earnings', 'economy', 'policy', 'tech', 'deals', 'energy', 'insider', 'personal-finance']);
  assert.deepEqual(RESPONSE_SCHEMA.properties.category.enum, [...AI_CATEGORY_SLUGS], 'the AI can never pick world/science/safety');
  assert.match(types, /\| 'cc_by_sa'/);
  for (const e of ['world_event', 'recall', 'science']) assert.match(types, new RegExp(`\\| '${e}'`));
});

test('new hosts are API hosts only; page hosts unchanged; --only accepts the new sources', () => {
  assert.deepEqual([...config.pageHosts], ['www.sec.gov', 'www.federalreserve.gov', 'www.bls.gov']);
  for (const u of [wikiFeedUrl(DRY_NOW), cpscUrl(DRY_NOW), config.usgs.url]) {
    assert.doesNotThrow(() => assertAllowed(u, 'api'), u);
    assert.throws(() => assertAllowed(u, 'page'), /page host not allowed/, u);
  }
  assert.deepEqual(parseArgs(['--only', 'wiki,cpsc,usgs']).only, ['wiki', 'cpsc', 'usgs']);
});

// ---- Wikipedia --------------------------------------------------------------------------

test('wiki: today\'s UTC date in the URL; missing news key = 0 items; story text and date comment', () => {
  assert.equal(wikiFeedUrl(new Date('2026-10-17T23:59:00Z')), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/17');
  assert.equal(wikiFeedUrl(new Date('2026-10-18T00:01:00Z')), 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/18');
  assert.deepEqual(parseWikiFeed('{"tfa":{},"mostread":{}}'), []);
  assert.throws(() => parseWikiFeed('<html>'), /not JSON/);
  const news = parseWikiFeed(WIKI);
  assert.equal(news.length, 4);
  assert.equal(storyText(news[1].story), 'South African jurist Navi Pillay is awarded the Nobel Peace Prize.');
  assert.doesNotMatch(storyText(news[0].story), /image shown/);
  assert.equal(storyDate(news[1].story, DRY_NOW), '2026-10-09T00:00:00.000Z');
  assert.equal(storyDate('<!--Dec 30-->x', new Date('2026-01-02T00:00:00Z')), '2025-12-30T00:00:00.000Z', 'future date = last year');
  assert.equal(storyDate('no comment', DRY_NOW), DRY_NOW.toISOString());
});

test('wiki: item mapping (world / world_event / cc_by_sa / exact attribution); AI text = story + extract only, <= 1,500 chars, no thumbnails', () => {
  const news = parseWikiFeed(WIKI);
  const items = news.map((n) => wikiItemToItem(n, DRY_NOW)).map((r) => ('item' in r ? r.item : null));
  assert.ok(items.every(Boolean));
  const it = items[1]!;
  assert.equal(it.url, 'https://en.wikipedia.org/wiki/Navi_Pillay');
  assert.equal(it.category, 'world');
  assert.equal(it.event_type, 'world_event');
  assert.equal(it.license_class, 'cc_by_sa');
  assert.equal(it.source_name, 'Wikipedia');
  assert.equal(it.source_kind, 'news');
  assert.equal(it.doc_label, 'In the news');
  assert.equal(it.attribution, 'Adapted from Wikipedia ("Navi Pillay") · CC BY-SA 4.0');
  assert.ok(it.summary_text.startsWith('South African jurist Navi Pillay is awarded the Nobel Peace Prize.\n\nNavanetham Pillay'));
  for (const x of items) {
    assert.ok(x!.summary_text.length <= 1500);
    assert.doesNotMatch(x!.summary_text, /upload\.wikimedia|\.jpg|\.png|thumbnail/i);
  }
  assert.equal(new Set(items.map((x) => x!.external_id)).size, 4, 'dedupe key: story text + link');
  assert.equal(config.copyLimitWords.cc_by_sa, 10);
});

test('wiki: User-Agent follows the Wikimedia format, contact from SEC_USER_AGENT (never hard-coded)', () => {
  assert.equal(wikimediaUserAgent('Element hackathon someone@example.org'), 'Element/0.1 (someone@example.org) node-fetch');
  assert.equal(wikimediaUserAgent('https://github.com/x/y'), 'Element/0.1 (https://github.com/x/y) node-fetch');
  assert.equal(wikimediaUserAgent(''), null);
  assert.doesNotMatch(readFileSync(new URL('../src/sources/wiki.ts', import.meta.url), 'utf8'), /@[a-z0-9-]+\.(edu|com|org)/i);
});

test('wiki: copy limit 10 words applies to Wikipedia text', () => {
  const it = (wikiItemToItem(parseWikiFeed(WIKI)[0], DRY_NOW) as { item: RawItem }).item;
  const src = { text: it.summary_text, licenseClass: it.license_class, tickers: [] };
  const copied = { headline: 'Houthi attacks', body: 'The Houthis launch a series of attacks on Saudi Arabian airports, including King Khalid International Airport.', category: 'policy', event_type: null, tickers: [] };
  assert.match(validateDraft(copied, src).errors.join(), /copies \d+ consecutive words .*limit 10/);
});

test('wiki pipeline: API request for today only (default), AI cards in world with the attribution on card and source; low relevance skipped', async () => {
  const seen: SummarizeInput[] = [];
  const { d, dry, requests } = deps([fakeAi(seen), templateSummarizer]);
  const s = await runOnce(d, { only: ['wiki'] });
  assert.equal(config.wiki.lookbackDays, 1);
  assert.deepEqual(requests, [
    { url: 'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/17', kind: 'api' },
  ]);
  assert.equal(s.published, 4, '4 stories in today\'s feed');
  for (const c of dry.cards) {
    assert.equal(c.category, 'world');
    assert.equal(c.event_type, 'world_event');
    assert.equal(c.ai_generated, true);
    assert.match(c.attribution!, /^Adapted from Wikipedia \("[^"]+"\) · CC BY-SA 4\.0$/);
    assert.equal(c.sources[0].attribution, c.attribution);
    assert.equal(c.sources[0].license_class, 'cc_by_sa');
    assert.deepEqual(validatePublish(c).errors, []);
  }
  for (const i of seen) assert.equal(i.text, i.item.summary_text, 'feed text only');
  const low = deps([fakeAi([], 2), templateSummarizer]);
  const s2 = await runOnce(low.d, { only: ['wiki'] });
  assert.equal(s2.published, 0);
  assert.equal(low.lines.filter((l) => l.startsWith('skip low_relevance (2)')).length, 4);
});

// ---- CPSC ----------------------------------------------------------------------------------

test('cpsc: 14-day lookback URL, newest first, recall URL as the source, AI text from the JSON only (cap of 5 applies to new recalls in the pipeline)', () => {
  assert.equal(cpscUrl(DRY_NOW), 'https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2026-10-03');
  const all = parseCpscJson(CPSC);
  assert.equal(all.length, 14);
  assert.equal(selectRecalls(all, DRY_NOW).length, 14);
  const picked = selectRecalls(all, DRY_NOW, config.cpsc.maxPerRun);
  assert.equal(picked.length, 5);
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i - 1].RecallDate! >= picked[i].RecallDate!);
  const it = (cpscToItem(picked[0], DRY_NOW) as { item: RawItem }).item;
  assert.equal(it.url, picked[0].URL);
  assert.match(it.url, /^https:\/\/(www\.)?cpsc\.gov\/Recalls\//);
  assert.equal(it.category, 'safety');
  assert.equal(it.event_type, 'recall');
  assert.equal(it.license_class, 'public_domain');
  assert.equal(it.attribution, 'Source: U.S. Consumer Product Safety Commission');
  assert.ok(it.summary_text.startsWith(picked[0].Title!));
  assert.match(it.summary_text, /Hazards: /);
  assert.match(it.summary_text, /Remedies: /);
  assert.doesNotMatch(it.summary_text, /\.(jpg|png)\b/i, 'no image URLs');
  assert.deepEqual(cpscToItem({ ...picked[0], URL: 'http://evil.example/x' }, DRY_NOW), { skip: 'bad_url' });
  assert.throws(() => parseCpscJson('{"a":1}'), /list of recalls/);
});

test('cpsc pipeline: AI cards fixed to safety/recall; template recall cards are not published', async () => {
  const seen: SummarizeInput[] = [];
  const { d, dry } = deps([fakeAi(seen), templateSummarizer]);
  const s = await runOnce(d, { only: ['cpsc'] });
  assert.equal(s.published, 5);
  assert.ok(dry.cards.every((c) => c.category === 'safety' && c.event_type === 'recall' && c.sources[0].kind === 'government'));
  for (const i of seen) assert.equal(i.text, i.item.summary_text);
  const t = deps([templateSummarizer]);
  const s2 = await runOnce(t.d, { only: ['cpsc'] });
  assert.equal(s2.published, 0);
  assert.equal(templateAllowed({ source: 'cpsc' } as RawItem), false);
  assert.equal(templateAllowed({ source: 'wiki_itn' } as RawItem), false);
});

// ---- USGS ----------------------------------------------------------------------------------

test('usgs: template card from title/mag/place/time, event URL as the source, USGS credit, no AI', async () => {
  const f = parseUsgsGeoJson(USGS);
  assert.equal(f.length, 5);
  const it = (usgsToItem(f[0], DRY_NOW) as { item: RawItem }).item;
  assert.equal(it.url, 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u2y1');
  assert.equal(it.attribution, 'Credit: U.S. Geological Survey');
  const dft = usgsDraft(it);
  assert.equal(dft.headline, 'Magnitude 5.7 earthquake hits Pakistan');
  assert.equal(dft.body, 'A magnitude 5.7 earthquake struck in Pakistan. The USGS rated the expected damage as yellow (some damage is possible).');
  // No over-specific detail leaks into the headline or body.
  for (const s of [dft.headline, dft.body!]) {
    assert.doesNotMatch(s, /48 km|WNW|Khuzdar|05:06|UTC/, s);
  }
  // (the real ridge quake has a green alert and is now skipped as low interest; an orange one shows the wording)
  const ridge = usgsDraft((usgsToItem({ ...f[2], properties: { ...f[2].properties, alert: 'orange' } }, DRY_NOW) as { item: RawItem }).item);
  assert.equal(ridge.headline, 'Magnitude 6.8 earthquake on the Mid-Atlantic Ridge');
  assert.match(ridge.body!, /struck on the Mid-Atlantic Ridge\. .* official tsunami warnings come from tsunami\.gov\./);
  assert.doesNotMatch(ridge.body!, /central|km|UTC/);
  assert.deepEqual(usgsToItem(f[0], new Date('2026-11-30T00:00:00Z')), { skip: 'too_old' });

  let aiCalls = 0;
  const ai: Summarizer = { name: 'gemini', usesAi: true, async summarize() { aiCalls++; throw new Error('no'); } };
  const { d, dry } = deps([ai, templateSummarizer]);
  const s = await runOnce(d, { only: ['usgs'] });
  assert.equal(aiCalls, 0);
  assert.equal(s.published, 2, 'Pakistan (yellow) and Russia (green but M6.9 on land)');
  assert.equal(s.skipped, 3, 'two green ridge quakes and the M6.1 Panama quake');
  assert.equal(s.template, 2);
  for (const c of dry.cards) {
    assert.equal(c.category, 'science');
    assert.equal(c.event_type, 'science');
    assert.equal(c.ai_generated, false);
    assert.equal(c.sources[0].name, 'U.S. Geological Survey');
    assert.deepEqual(validatePublish(c).errors, []);
  }
  const again = await runOnce(d, { only: ['usgs'] });
  assert.equal(again.published, 0, 'dedupe on the event URL');
});

// ---- USGS publishing threshold (audit A1.12) ------------------------------------------------

test('usgs threshold: yellow/orange/red always publish; green or no alert is skipped at sea / ridge / no country or under M6.5', () => {
  assert.equal(config.usgs.minMagnitudeWithoutAlert, 6.5);
  assert.deepEqual([...config.usgs.keepAlerts], ['yellow', 'orange', 'red']);
  const f = parseUsgsGeoJson(USGS);
  const low = (p: Partial<UsgsFeature['properties']>) => lowInterestReason({ mag: 6.9, place: '76 km NE of Ozernovskiy, Russia', alert: 'green', ...p });
  // kept
  assert.equal(low({}), null, 'M6.9 green on land (Russia) stays');
  assert.equal(low({ alert: null }), null, 'no alert but big and near a country stays');
  for (const a of ['yellow', 'orange', 'red', 'YELLOW']) {
    assert.equal(low({ alert: a, mag: 4.5, place: 'central Mid-Atlantic Ridge' }), null, `${a} always stays, even small and at sea`);
  }
  // skipped
  assert.match(low({ place: 'central Mid-Atlantic Ridge' })!, /green alert, at sea or no country/);
  assert.match(low({ place: 'southern East Pacific Rise', alert: null })!, /no alert, at sea or no country/);
  assert.match(low({ place: '120 km S of Kodiak, Alaska, Pacific Ocean' })!, /at sea/, 'ocean word even with a comma');
  assert.match(low({ place: 'Fiji region' })!, /at sea or no country/, 'no comma = no country');
  assert.match(low({ mag: 6.1, place: '17 km W of Río Grande, Panama' })!, /magnitude 6\.1 under 6\.5/);
  assert.equal(low({ mag: 6.5, place: '17 km W of Río Grande, Panama' }), null, '6.5 is the threshold');
  assert.equal(low({ mag: 6.8, place: '10 km N of Ridgecrest, CA' }), null, '"Ridgecrest" is not a ridge');
  assert.equal(isAtSea('Seaside, Oregon'), false, '"Seaside" is not the sea');
  // on the real week: Pakistan (yellow) and Russia stay; both ridge quakes and Panama are skipped with a logged reason
  const results = f.map((x) => usgsToItem(x, DRY_NOW));
  assert.deepEqual(results.map((r) => ('item' in r ? 'item' : r.skip)), ['item', 'item', 'low_interest', 'low_interest', 'low_interest']);
  assert.match(String((results[4] as { note?: string }).note), /magnitude 6\.1 under 6\.5/);
});

test('usgs pipeline: skipped quakes are counted and logged with the reason, nothing is published for them', async () => {
  const { d, dry, lines } = deps([templateSummarizer]);
  const s = await runOnce(d, { only: ['usgs'] });
  assert.equal(s.published, 2);
  assert.equal(s.skipped, 3);
  assert.deepEqual(dry.cards.map((c) => c.headline).sort(), ['Magnitude 5.7 earthquake hits Pakistan', 'Magnitude 6.9 earthquake hits Russia']);
  assert.ok(lines.includes('skip low_interest (green alert, at sea or no country): USGS us6000u214'), lines.join('\n'));
  assert.ok(lines.includes('skip low_interest (green alert, magnitude 6.1 under 6.5): USGS us6000u1wn'), lines.join('\n'));
});

// ---- USGS plain headlines (Drew's rules: no distance, bearing, nearest town or time) -------

test('usgs plain headline: Khuzdar example drops "48 km" and "WNW"; broad place only', () => {
  const h = usgsHeadline(5.7, '48 km WNW of Khuzdar, Pakistan');
  assert.equal(h, 'Magnitude 5.7 earthquake hits Pakistan');
  assert.doesNotMatch(h, /48 km|WNW|Khuzdar/);
  assert.ok(h.length <= config.headlineMaxChars);
});

test('usgs plain headline: US state abbreviation maps to the full state name (Ridgecrest, CA -> California)', () => {
  assert.equal(usgsHeadline(4.5, '10 km N of Ridgecrest, CA'), 'Magnitude 4.5 earthquake in California');
  assert.deepEqual(plainQuakeLocation('10 km N of Ridgecrest, CA'), { region: 'California', headlineVerb: 'in', bodyPrep: 'in' });
  // body also stays plain: no distance, bearing, town or clock time
  const it = { summary_text: JSON.stringify({ mag: 4.5, place: '10 km N of Ridgecrest, CA', time: 1792213617657, alert: null, tsunami: 0 }), category: 'science', event_type: 'science', title: 'M 4.5' } as unknown as RawItem;
  const dft = usgsDraft(it);
  assert.equal(dft.headline, 'Magnitude 4.5 earthquake in California');
  assert.equal(dft.body, 'A magnitude 4.5 earthquake struck in California.');
  assert.doesNotMatch(dft.body!, /10 km|Ridgecrest|UTC|:/);
});

test('usgs plain headline: a place with no comma (Mid-Atlantic Ridge) reads naturally', () => {
  assert.equal(usgsHeadline(6.8, 'central Mid-Atlantic Ridge'), 'Magnitude 6.8 earthquake on the Mid-Atlantic Ridge');
  assert.deepEqual(plainQuakeLocation('central Mid-Atlantic Ridge'), { region: 'Mid-Atlantic Ridge', headlineVerb: 'on the', bodyPrep: 'on the' });
});

// ---- NASA ----------------------------------------------------------------------------------

test('nasa: only news releases (APOD and image articles dropped); release text without figures or image URLs', async () => {
  const all = parseNasaRss(fx('nasa-news-release.rss.xml'));   // RECONSTRUCTED (3 of 10 items verbatim)
  assert.equal(all.length, 3);
  const rel = selectNasaReleases(all, DRY_NOW);
  assert.deepEqual(rel.map((i) => i.link), ['https://www.nasa.gov/news-release/nasa-names-stephen-cash-marshall-space-flight-center-director/']);
  const it = nasaToItem(rel[0], DRY_NOW);
  assert.equal(it.category, 'science');
  assert.equal(it.event_type, 'science');
  assert.equal(it.license_class, 'public_domain');
  assert.equal(it.source_name, 'NASA');
  assert.equal(it.attribution, 'Source: NASA');
  assert.ok(it.summary_text.startsWith('NASA Names Stephen Cash Marshall Space Flight Center Director. '));
  assert.ok(it.summary_text.length > 200, 'release text is present');
  assert.doesNotMatch(it.summary_text, /\.(jpg|jpeg|png|webp)\b|<img|<figure/i);
  assert.equal(selectNasaReleases(all, new Date('2026-11-30T00:00:00Z')).length, 0, 'max age');

  const seen: SummarizeInput[] = [];
  const { d, dry, requests } = deps([fakeAi(seen), templateSummarizer]);
  const s = await runOnce(d, { only: ['nasa'] });
  assert.equal(config.nasa.feedPages, 1);
  assert.deepEqual(requests, [
    { url: 'https://www.nasa.gov/news-release/feed/', kind: 'api' },
  ]);
  assert.equal(s.published, 1, 'the page 1 release only (the 9-day-old release is on page 2, which is not read by default)');
  assert.equal(dry.cards[0].category, 'science');
  assert.equal(seen[0].text, seen[0].item.summary_text);
  assert.doesNotThrow(() => assertAllowed(config.nasa.feedUrl, 'api'));
  assert.throws(() => assertAllowed(config.nasa.feedUrl, 'page'));
});
