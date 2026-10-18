// Federal Register source: offline, from the REAL fixtures (2026-10-17) plus one SYNTHETIC
// null-abstract document. No network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, AllowlistError, fetchAllowed } from '../src/allowlist.ts';
import { config, fedRegisterUrls } from '../src/config.ts';
import { agencyName, clampedPublishedAt, fedRegDocToItem, mergeFedRegDocs, parseFedRegJson, type FrDoc } from '../src/sources/fedreg.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, buildPublishPayload } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateDraft, templateSummarizer } from '../src/summarizer/template.ts';
import { validatePublish } from '../src/validate.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const agencies = parseFedRegJson(fx('fedreg-agencies.json'));
const significant = parseFedRegJson(fx('fedreg-significant.json'));
const nullAbs = parseFedRegJson(fx('fedreg-null-abstract.json'));
const NOW = new Date('2026-10-17T21:00:00Z');

const itemOf = (d: FrDoc): RawItem => {
  const r = fedRegDocToItem(d, NOW);
  assert.ok('item' in r, `expected an item for ${d.document_number}`);
  return r.item;
};

test('allowlist: www.federalregister.gov is an API host only; page fetches are refused', async () => {
  assert.ok((config.apiHosts as readonly string[]).includes('www.federalregister.gov'));
  assert.ok(!(config.pageHosts as readonly string[]).includes('www.federalregister.gov'));
  const page = 'https://www.federalregister.gov/documents/2026/10/15/2026-21069/sale-and-issue-of-marketable-book-entry-treasury-bills-notes-and-bonds';
  assert.throws(() => assertAllowed(page, 'page'), AllowlistError);
  let called = false;
  await assert.rejects(fetchAllowed(page, { kind: 'page', fetchImpl: async () => { called = true; return new Response(''); } }), AllowlistError);
  assert.equal(called, false, 'no request may leave for a refused page');
  for (const u of fedRegisterUrls()) assert.doesNotThrow(() => assertAllowed(u, 'api'));
});

test('query URLs: query A (significant) is off; query B lists the 10 wallet-relevant agencies', () => {
  assert.equal(config.fedRegister.significantQuery, false);
  const urls = fedRegisterUrls();
  assert.equal(urls.length, 1, 'only query B');
  const [b] = urls;
  assert.match(b, /conditions\[type\]\[\]=RULE/);
  assert.doesNotMatch(b, /conditions\[significant\]/);
  assert.equal((b.match(/conditions\[agencies\]\[\]=/g) ?? []).length, 10);
  for (const a of ['consumer-financial-protection-bureau', 'transportation-department', 'federal-trade-commission',
    'internal-revenue-service', 'treasury-department', 'federal-reserve-system', 'securities-and-exchange-commission',
    'federal-communications-commission', 'energy-department', 'education-department']) assert.match(b, new RegExp(`=${a}(&|$)`));
  for (const a of ['commerce-department', 'commodity-futures-trading-commission', 'labor-department', 'industry-and-security-bureau']) {
    assert.doesNotMatch(b, new RegExp(`=${a}(&|$)`));
  }
  // query A still works when switched back on
  const both = fedRegisterUrls({ ...config.fedRegister, significantQuery: true });
  assert.equal(both.length, 2);
  assert.match(both[1], /conditions\[significant\]=1/);
});

test('parse: REAL fixtures load; HTML (bot challenge) throws; empty search is []', () => {
  assert.equal(agencies.length, 5);
  assert.equal(significant.length, 4);
  assert.throws(() => parseFedRegJson('<html>unblock</html>'), /not JSON/);
  assert.deepEqual(parseFedRegJson('{"count":0,"description":"x"}'), []);
});

test('merge: dedupe on document_number, 14-day max age, newest first', () => {
  const merged = mergeFedRegDocs([agencies, significant, agencies], NOW);
  assert.equal(merged.length, 9);
  assert.equal(new Set(merged.map((d) => d.document_number)).size, 9);
  const old = { ...agencies[0], document_number: 'old-1', publication_date: '2026-10-01' };
  assert.equal(mergeFedRegDocs([[old]], NOW).length, 0);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].publication_date >= merged[i].publication_date);
});

test('null abstract: skipped with reason no_abstract (and counted as skipped in a run)', async () => {
  assert.equal(nullAbs[0].abstract, null);
  assert.deepEqual(fedRegDocToItem(nullAbs[0], NOW), { skip: 'no_abstract' });
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = {
    fetchText: async () => fx('fedreg-null-abstract.json'),
    publisher: dry.publisher, providers: [templateSummarizer], counter: memoryCounter(),
    fredApiKey: null, now: NOW, log: (l) => lines.push(l),
  };
  const s = await runOnce(deps, { only: ['fedreg'] });
  assert.equal(s.skipped, 1);                              // both queries return the same doc: deduped to one
  assert.equal(s.published, 0);
  assert.match(lines.join('\n'), /skip no_abstract: Federal Register C1-2026-20019/);
});

test('future publication_date (scheduled issue) is clamped to now', () => {
  const future = agencies.find((d) => d.publication_date === '2026-10-19')!;
  assert.ok(future, 'REAL fixture has a 2026-10-19 item');
  assert.equal(itemOf(future).published_at, NOW.toISOString());
  const past = agencies.find((d) => d.publication_date === '2026-10-15')!;
  assert.equal(clampedPublishedAt(past, NOW), '2026-10-15T00:00:00.000Z');
});

test('the AI input is the abstract only (no title, no page text, no page fetch)', async () => {
  const seen: string[] = [];
  const fetched: string[] = [];
  const spy: Summarizer = {
    name: 'spy', usesAi: true, minIntervalMs: 0,
    async summarize(i) {
      seen.push(i.text);
      return { headline: 'Treasury updates its auction rules', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 } satisfies SummaryDraft;
    },
  };
  const dry = createDryRunPublisher();
  const deps: Deps = {
    fetchText: async (url, kind) => {
      fetched.push(`${kind} ${new URL(url).hostname}`);
      return url === fedRegisterUrls()[0] ? fx('fedreg-agencies.json') : fx('fedreg-significant.json');   // query A is off: never asked
    },
    publisher: dry.publisher, providers: [spy, templateSummarizer], counter: memoryCounter(),
    fredApiKey: null, now: NOW, log: () => {},
  };
  await runOnce(deps, { only: ['fedreg'] });
  assert.deepEqual(fetched, ['api www.federalregister.gov']);   // one API call (query B), zero pages
  const abstracts = mergeFedRegDocs([agencies], NOW).map((d) => d.abstract!.replace(/\s+/g, ' ').trim());
  assert.deepEqual(seen, abstracts);
  for (const d of [...agencies, ...significant]) assert.ok(!seen.some((t) => t.includes(d.title) && !d.abstract!.includes(d.title)));
});

test('category policy and event_type null are fixed in code (the AI draft cannot change them)', () => {
  const it = itemOf(agencies[3]);
  const p = buildPublishPayload(it, { headline: 'Treasury updates its auction rules', body: null, category: 'markets', event_type: 'fed', tickers: [] },
    { aiGenerated: true, model: 'm' });
  assert.equal(p.category, 'policy');
  assert.equal(p.event_type, null);
  assert.equal(validatePublish(p).ok, true);
});

test('card mapping: html_url source, public_domain, attribution names the sub-agency', () => {
  const it = itemOf(agencies[3]);                             // Treasury / Fiscal Service
  assert.equal(it.source_name, 'Federal Register');
  assert.equal(it.source_kind, 'government');
  assert.equal(it.license_class, 'public_domain');
  assert.equal(it.url, agencies[3].html_url);
  assert.equal(it.external_id, agencies[3].document_number);
  assert.equal(it.attribution, 'Source: Federal Register (National Archives), Fiscal Service');
  assert.equal(config.copyLimitWords[it.license_class], 25);
  // REAL data: one agency entry has raw_name but no name; agencyName falls back instead of printing "undefined".
  for (const d of [...agencies, ...significant]) assert.doesNotMatch(agencyName(d) ?? '', /undefined/);
});

test('template headline is plain (never the raw official title) and stays within 90 chars', () => {
  for (const d of [...agencies, ...significant]) {
    const it = itemOf(d);
    const t = templateDraft({ item: it, text: '' });
    assert.ok(t.headline.length <= config.headlineMaxChars, t.headline);
    assert.match(t.body!, /published this final rule in the Federal Register/);
    // the plain headline is not the raw document title and carries no section/docket citations
    assert.notEqual(t.headline, it.title);
    assert.doesNotMatch(t.headline, /Section 511\(b\)|Executive Order|Airworthiness Directives/);
  }
});

test('fedreg: an "Airworthiness Directives" title becomes a plain FAA safety-order headline naming the planemaker', () => {
  const faaDoc: FrDoc = {
    document_number: '2026-99999',
    title: 'Airworthiness Directives; The Boeing Company Airplanes',
    abstract: 'The FAA adopts a new airworthiness directive for certain Boeing Model 737 airplanes.',
    html_url: 'https://www.federalregister.gov/documents/2026/10/17/2026-99999/airworthiness-directives-the-boeing-company-airplanes',
    publication_date: '2026-10-17',
    type: 'Rule',
    agencies: [{ name: 'Federal Aviation Administration', parent_id: 492 }],
  };
  const h = templateDraft({ item: itemOf(faaDoc), text: '' }).headline;
  assert.equal(h, 'The FAA issues a safety order for Boeing planes');
  assert.doesNotMatch(h, /Airworthiness Directives|The Boeing Company Airplanes/);
  assert.ok(h.length <= config.headlineMaxChars);
});

test('non-https or foreign html_url is refused', () => {
  assert.deepEqual(fedRegDocToItem({ ...agencies[0], html_url: 'https://example.com/x' }, NOW), { skip: 'bad_url' });
  assert.deepEqual(fedRegDocToItem({ ...agencies[0], html_url: 'http://www.federalregister.gov/x' }, NOW), { skip: 'bad_url' });
});
