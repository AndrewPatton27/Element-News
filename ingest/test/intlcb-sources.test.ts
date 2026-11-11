// Foreign central-bank headline source (ECB, Bank of England, BIS): parsing, cards, gating, rules.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed } from '../src/allowlist.ts';
import { config } from '../src/config.ts';
import { runOnce, SOURCE_NAMES, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { parseBis } from '../src/sources/bis.ts';
import { parseBoe } from '../src/sources/boe.ts';
import { parseEcb } from '../src/sources/ecb.ts';
import { intlCard, selectIntl } from '../src/sources/intlcb.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { validatePublish } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-11T15:00:00Z');
const feed = (id: string) => config.agency.intlcb.feeds.find((f) => f.id === id)!;

function fakeDeps(fetchText: Deps['fetchText'], over: Partial<Deps> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = { fetchText, publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: NOW, log: (l) => lines.push(l), ...over };
  return { dry, lines, deps };
}
const serve = (u: string) => (u.includes('ecb.europa') ? fx('ecb-press.rss.xml') : u.includes('bankofengland') ? fx('boe-speeches.rss.xml') : fx('bis-pressrels.rss.xml'));

test('registered, off by default, feeds pass the api allowlist and never the page list', () => {
  assert.ok((SOURCE_NAMES as readonly string[]).includes('intlcb'));
  assert.equal(config.agency.intlcb.enabled, false);
  for (const f of config.agency.intlcb.feeds) {
    assert.doesNotThrow(() => assertAllowed(f.url, 'api'), f.id);
    assert.throws(() => assertAllowed(f.url, 'page'), f.id);
  }
  assert.deepEqual(config.agency.intlcb.feeds.filter((f) => f.noncommercial).map((f) => f.id).sort(), ['biscb', 'bispress', 'boenews', 'boespeech']);
});

test('parsers read the three real feed shapes', () => {
  const ecb = parseEcb(fx('ecb-press.rss.xml'));
  assert.ok(ecb.length >= 3 && ecb.every((i) => i.link.startsWith('https://www.ecb.europa.eu/')));
  assert.ok(parseBoe(fx('boe-speeches.rss.xml')).length >= 3);
  const bis = parseBis(fx('bis-pressrels.rss.xml'));
  assert.ok(bis.length >= 1);
  assert.match(bis[0].pubDate, /^2026-11-\d\d/);
  assert.equal(parseBis('<rdf:RDF><item><title>x</title><link>https://www.bis.org/a</link></item></rdf:RDF>').length, 0, 'no date: skipped');
});

test('cards: verbatim headline, link to the institution, template, no description text, rules hold', () => {
  for (const [id, parse, file] of [['ecb', parseEcb, 'ecb-press.rss.xml'], ['boespeech', parseBoe, 'boe-speeches.rss.xml'], ['bispress', parseBis, 'bis-pressrels.rss.xml']] as const) {
    const items = selectIntl(parse(fx(file)), NOW).map((i) => (id === 'bispress' ? { ...i, title: 'BIS appoints new committee chair' } : i));   // the real BIS title is over 90 characters (skipped, see guards)
    const f = feed(id);
    const cards = items.map((i) => intlCard(i, f)).filter((c) => c !== null);
    assert.ok(cards.length >= 1, id);
    for (const c of cards) {
      assert.equal(c.ai_generated, false);
      assert.equal(c.kind, 'summary');
      assert.match(c.dedupe_key, new RegExp(`^INTLCB-${id}-[0-9a-f]{10}$`));
      assert.ok(c.headline.length <= 90 && !c.headline.startsWith(' '));
      assert.ok(c.sources.length >= 1 && c.sources[0].license_class === 'company_filing');
      assert.ok(f.hosts.includes(new URL(c.sources[0].url).hostname));
      assert.ok(!c.sources[0].url.includes('//press') && !/\.eu\/\//.test(c.sources[0].url), 'double slash fixed');
      assert.match(c.attribution ?? '', new RegExp(f.agency));
      assert.deepEqual(validatePublish(c).errors, []);
      assert.doesNotMatch(`${c.headline} ${c.body}`, /\b(buy|sell|should invest)\b/i);
    }
  }
});

test('card guards: long titles skipped not cut, foreign host and http link rejected, old items outside the window', () => {
  const f = feed('ecb');
  const base = { title: 'Rates', link: 'https://www.ecb.europa.eu/press/pr/x.html', description: '', category: null, pubDate: '2026-11-10T10:00:00.000Z', guid: 'g' };
  assert.ok(intlCard(base, f));
  assert.equal(intlCard({ ...base, title: 'word '.repeat(30) }, f), null);
  assert.equal(intlCard({ ...base, title: 'x'.repeat(91) }, f), null);
  assert.equal(intlCard({ ...base, link: 'https://evil.example/x' }, f), null);
  assert.equal(intlCard({ ...base, link: 'http://www.ecb.europa.eu/x' }, f), null);
  assert.equal(selectIntl([{ ...base, pubDate: '2026-11-01T10:00:00.000Z' }], NOW).length, 0);
  assert.equal(selectIntl([{ ...base, pubDate: '2026-11-20T10:00:00.000Z' }], NOW).length, 0, 'future');
});

test('runOnce intlcb: off without INTLCB_ENABLED; ECB only without the non-commercial flag; all with both; capped per feed; a rerun never repeats a card', async () => {
  const off = fakeDeps(async () => { throw new Error('must not fetch'); });
  await runOnce(off.deps, { only: ['intlcb'] });
  assert.ok(off.lines.some((l) => /intlcb: disabled/.test(l)));

  const urls: string[] = [];
  const ecbOnly = fakeDeps(async (u) => { urls.push(u); return serve(u); }, { keys: { intlEnabled: true } });
  await runOnce(ecbOnly.deps, { only: ['intlcb'] });
  assert.deepEqual(urls, [feed('ecb').url], 'BoE and BIS are not fetched without the flag');
  assert.ok(ecbOnly.dry.cards.length >= 1 && ecbOnly.dry.cards.length <= config.agency.intlcb.maxCardsPerFeed);

  const all = fakeDeps(async (u) => serve(u), { keys: { intlEnabled: true, intlNoncommercialOk: true } });
  await runOnce(all.deps, { only: ['intlcb'] });
  assert.ok(all.dry.cards.length > ecbOnly.dry.cards.length);
  await runOnce(all.deps, { only: ['intlcb'] });   // the cap counts new cards only, so a rerun publishes the next ones, never a repeat
  const keys = all.dry.cards.map((c) => c.dedupe_key);
  assert.equal(new Set(keys).size, keys.length, 'no card published twice');

  const bad = fakeDeps(async (u) => { if (u.includes('ecb.europa')) throw new Error('boom'); return serve(u); }, { keys: { intlEnabled: true, intlNoncommercialOk: true } });
  await runOnce(bad.deps, { only: ['intlcb'] });
  assert.ok(bad.lines.some((l) => /intlcb: ecb failed/.test(l)));
  assert.ok(bad.dry.cards.length >= 1, 'one failing feed does not stop the others');
});
