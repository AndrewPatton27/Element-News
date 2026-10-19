// Checks every contract fixture against the rules in contract/types.ts and the
// project rules (source link, no images, no prices, AI label, [SAMPLE] marker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AppConfig, BlurbCard, Category, FeedPage, MacroFact } from '../../contract/types.ts';

const read = <T>(f: string): T => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${f}`, import.meta.url), 'utf8')) as T;

const CARD_KEYS = [
  'id', 'kind', 'headline', 'body', 'category', 'event_type', 'tickers', 'macro', 'sources', 'source_count',
  'as_of', 'published_at', 'sort_at', 'updated_at', 'revision', 'freshness', 'ai', 'attribution', 'image',
  'is_saved', 'share_path', 'importance', 'detail',
];
const MACRO_KEYS = ['series_id', 'label', 'value', 'change', 'direction', 'period', 'as_of', 'source_name', 'source_short', 'source_url', 'sort_order'];
const SLUGS = ['markets', 'earnings', 'economy', 'policy', 'tech', 'deals', 'energy', 'insider', 'personal-finance', 'world', 'science', 'safety'];
const BUSINESS_SLUGS = SLUGS.slice(0, 9);   // page 1 covers the original 9; the 3 broad-topic samples are on page 2
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;

const config = read<AppConfig>('app_config.json');
const page1 = read<FeedPage>('feed.page1.json');
const page2 = read<FeedPage>('feed.page2.json');
const empty = read<FeedPage>('feed.empty.json');

function checkMacro(m: MacroFact) {
  assert.deepEqual(Object.keys(m).filter((k) => k !== 'updated_at'), MACRO_KEYS);   // updated_at is optional (numbers_to_know only)
  assert.ok(m.source_name.length > 0 && m.source_short !== 'FRED' && !/^FRED$/.test(m.source_name), m.series_id);
  assert.ok(m.source_url.startsWith('https://'));
  assert.match(m.as_of, ISO);
  assert.ok(['up', 'down', 'flat', null].includes(m.direction));
}

function checkCard(c: BlurbCard) {
  const at = c.headline;
  assert.deepEqual(Object.keys(c), CARD_KEYS, at);
  assert.ok(['summary', 'data'].includes(c.kind), `${at}: fixtures never contain link_out`);
  assert.ok(c.headline.startsWith('[SAMPLE] '), `${at}: missing [SAMPLE] marker`);
  assert.ok(c.headline.length <= 90, `${at}: headline too long`);
  if (c.body) assert.ok(c.body.split(/\s+/).length <= 60, `${at}: body too long`);
  assert.ok(SLUGS.includes(c.category), at);
  assert.ok(c.sources.length >= 1 && c.sources.length <= 8, `${at}: needs 1..8 sources`);
  for (const s of c.sources) {
    assert.ok(s.url.startsWith('https://'), at);
    assert.ok(['filing', 'government', 'news'].includes(s.kind), at);
    assert.notEqual(s.license_class as string, 'dev_only', at);
  }
  assert.equal(c.sources.filter((s) => s.is_primary).length, 1, `${at}: exactly one primary source`);
  assert.ok(c.source_count >= 1);
  assert.equal(c.image, null, `${at}: images are never allowed`);
  assert.ok(c.tickers.length <= 5);
  for (const t of c.tickers) assert.equal(t.quote, null, `${at}: prices are never shown`);
  assert.ok(c.macro.length <= 3);
  c.macro.forEach(checkMacro);
  if (c.kind === 'data') assert.ok(c.macro.length >= 1, `${at}: data card needs a MacroFact`);
  assert.equal(c.ai.label, c.ai.generated ? config.ai_notice : null, `${at}: ai.label rule`);
  if (c.kind === 'data') assert.equal(c.ai.generated, false, `${at}: data cards are templates`);
  assert.equal(c.share_path, `/b/${c.id}`);
  assert.equal(c.is_saved, false);
  for (const k of ['as_of', 'published_at', 'sort_at'] as const) assert.match(c[k], ISO, `${at}: ${k}`);
  if (c.detail != null) {
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    assert.ok(c.detail.paragraphs.length >= 2 && c.detail.paragraphs.length <= 4, `${at}: 2-4 paragraphs`);
    assert.ok(words(c.detail.paragraphs.join(' ')) <= 180, `${at}: detail over 180 words`);
    assert.ok(c.detail.key_points.length >= 3 && c.detail.key_points.length <= 5, `${at}: 3-5 key points`);
    for (const k of c.detail.key_points) assert.ok(words(k) <= 15, `${at}: key point over 15 words`);
  }
}

test('several sample cards carry a detail, some leave it null', () => {
  const all = [...page1.items, ...page2.items];
  assert.ok(all.filter((c) => c.detail).length >= 4);
  assert.ok(all.filter((c) => c.detail === null).length >= 4);
});

test('app_config has the exact disclaimer and AI notice, no prices, no link-outs', () => {
  assert.equal(config.disclaimer, 'Informational only · Not investment advice');
  assert.equal(config.ai_notice, 'AI-generated summary · may contain errors');
  assert.equal(config.quotes_enabled, false);
  assert.equal(config.linkout_cards, false);
  const fred = config.required_notices.find((n) => n.key === 'fred');
  assert.ok(fred, 'FRED notice present');
  assert.deepEqual([...fred.placements].sort(), ['about', 'data_card', 'numbers_panel', 'share']);
});

test('no TODO-verify marker is left in the app_config fixture', () => {
  assert.doesNotMatch(JSON.stringify(config), /TODO-verify/);
});

test('every feed card follows the contract and the project rules', () => {
  for (const c of [...page1.items, ...page2.items]) checkCard(c);
});

test('page 1 has 20+ cards, all 9 categories, summary + data + template cards', () => {
  assert.ok(page1.items.length >= 20);
  assert.deepEqual([...new Set(page1.items.map((c) => c.category))].sort(), [...BUSINESS_SLUGS].sort());
  assert.ok(page1.items.some((c) => c.kind === 'data'));
  assert.ok(page1.items.some((c) => c.kind === 'summary' && c.ai.generated));
  assert.ok(page1.items.some((c) => c.kind === 'summary' && !c.ai.generated));
  assert.equal(typeof page1.next_cursor, 'string');
});

test('page 2 ends the feed; empty page is empty; ids are unique', () => {
  assert.equal(page2.next_cursor, null);
  assert.deepEqual(empty, { items: [], next_cursor: null });
  const ids = [...page1.items, ...page2.items].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('numbers_to_know has the six series in order, each citing its agency via FRED', () => {
  const rows = read<MacroFact[]>('numbers_to_know.json');
  assert.deepEqual(rows.map((r) => r.series_id), ['DGS2', 'DGS10', 'DFF', 'CPIAUCSL', 'UNRATE', 'DCOILWTICO']);
  rows.forEach(checkMacro);
  for (const r of rows) assert.match(r.source_name, /^(Board of Governors of the Federal Reserve System \(US\)|U\.S\. Bureau of Labor Statistics|U\.S\. Energy Information Administration) via FRED$/);
});

test('categories.json has the 12 slugs in the PM review 2 order with the new display names', () => {
  const cats = read<Category[]>('categories.json');
  assert.deepEqual(cats.map((c) => c.slug), ['world', 'policy', 'economy', 'personal-finance', 'markets', 'tech', 'science', 'safety', 'earnings', 'deals', 'energy', 'insider']);
  assert.deepEqual(cats.map((c) => c.sort_order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...cats.map((c) => c.slug)].sort(), [...SLUGS].sort());
  const name = Object.fromEntries(cats.map((c) => [c.slug, c.name]));
  assert.deepEqual([name.policy, name['personal-finance'], name.markets, name.world, name.science, name.safety],
    ['Government', 'Money', 'Business', 'World', 'Science & Space', 'Recalls & Safety']);
});

test('page 2 has one [SAMPLE] card per new category; the Wikipedia card carries the exact CC BY-SA attribution', () => {
  for (const slug of ['world', 'science', 'safety']) assert.ok(page2.items.some((c) => c.category === slug), slug);
  const w = page2.items.find((c) => c.sources[0].license_class === 'cc_by_sa')!;
  assert.match(w.attribution!, /^Adapted from Wikipedia \("[^"]+"\) · CC BY-SA 4\.0$/);
  assert.equal(w.sources[0].attribution, w.attribution);
  assert.equal(w.sources[0].kind, 'news');
  assert.equal(w.ai.generated, true);
  const cc = config.required_notices.find((n) => n.key === 'cc_by_sa');
  assert.equal(cc?.url, 'https://creativecommons.org/licenses/by-sa/4.0/');
});
