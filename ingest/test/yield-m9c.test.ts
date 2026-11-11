// M9c yield work (R-300): bulk handled-items check, bounded soft retry, Gemini second-model attempt on HTTP 5xx,
// template cards for 1.01 / 2.01, per-source work cap. All offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { fixtureFetcher } from '../src/main.ts';
import { runOnce, templateAllowed, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { aiDraftsRejected, decideSoftRetry, softRetryFailures } from '../src/retry.ts';
import { memoryCounter, summarizeWithChain } from '../src/summarizer/chain.ts';
import { createGeminiSummarizer } from '../src/summarizer/gemini.ts';
import { templateDraft, templateSummarizer } from '../src/summarizer/template.ts';
import type { FetchLike } from '../src/allowlist.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';
import { validatePublish } from '../src/validate.ts';
import { buildPublishPayload } from '../src/publish.ts';

// ---- soft retry bookkeeping -----------------------------------------------------------------------------------------------

test('decideSoftRetry: stays new with a counter, third failure skips; other notes count as zero', () => {
  assert.equal(config.softRetry.maxFailures, 3);
  assert.deepEqual(decideSoftRetry(null, 'template_not_allowed'), { status: 'new', note: 'retry:1:template_not_allowed', failures: 1 });
  assert.deepEqual(decideSoftRetry('retry:1:template_not_allowed', 'template_not_allowed'), { status: 'new', note: 'retry:2:template_not_allowed', failures: 2 });
  assert.deepEqual(decideSoftRetry('retry:2:no_figures', 'no_figures'), { status: 'skipped', note: 'no_figures', failures: 3 });
  assert.equal(softRetryFailures('report_card_retry:2:x'), 0);
  assert.equal(softRetryFailures('low_relevance (2)'), 0);
  assert.equal(softRetryFailures(undefined), 0);
});

test('aiDraftsRejected: only a rejected AI draft counts, not a cap, a rate limit or the template', () => {
  assert.equal(aiDraftsRejected(['gemini: rejected (attempt 1): numbers not in source', 'template: used']), true);
  assert.equal(aiDraftsRejected(['gemini: daily cap 500 reached', 'groq: daily cap 62 reached', 'template: used']), false);
  assert.equal(aiDraftsRejected(['gemini: RateLimitedError: gemini: rate limited', 'template: used']), false);
  assert.equal(aiDraftsRejected([]), false);
});

// ---- pipeline: stuck items ------------------------------------------------------------------------------------------------

const NOW = new Date('2026-08-05T12:00:00Z');
const badAi: Summarizer = {
  name: 'gemini', usesAi: true, model: 'm',
  async summarize() { return { headline: 'Apple shares its latest results', body: 'Apple shared results.', category: 'earnings', event_type: 'earnings', tickers: ['AAPL'] } as SummaryDraft; },
};

function run(providers: Summarizer[], opts: { publisherPatch?: Partial<Publisher>; statusNote?: string | null } = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const statuses: string[] = [];
  const upserted: string[] = [];
  const publisher: Publisher = {
    ...dry.publisher,
    async upsertItem(item) {
      upserted.push(item.url);
      const r = await dry.publisher.upsertItem(item);
      return { ...r, status_note: opts.statusNote ?? null };
    },
    async setItemStatus(_id, status, note) { statuses.push(`${status}:${note}`); },
    ...opts.publisherPatch,
  };
  const deps: Deps = { fetchText: fixtureFetcher(), publisher, providers, counter: memoryCounter(), fredApiKey: null, now: NOW, log: (s) => lines.push(s) };
  return { deps, dry, lines, statuses, upserted };
}

test('soft retry: an Apple 2.02 whose AI drafts keep failing is retried twice, then skipped for good', async () => {
  const a = run([badAi, templateSummarizer], { statusNote: null });
  await runOnce(a.deps, { only: ['sec'] });
  assert.deepEqual(a.statuses.filter((x) => !x.includes('routine')), ['new:retry:1:no_figures']);
  const b = run([badAi, templateSummarizer], { statusNote: 'retry:1:no_figures' });
  await runOnce(b.deps, { only: ['sec'] });
  assert.deepEqual(b.statuses.filter((x) => !x.includes('routine')), ['new:retry:2:no_figures']);
  const c = run([badAi, templateSummarizer], { statusNote: 'retry:2:no_figures' });
  await runOnce(c.deps, { only: ['sec'] });
  assert.deepEqual(c.statuses.filter((x) => !x.includes('routine')), ['skipped:no_figures']);
  assert.ok(c.lines.some((l) => /no_figures: failure 3 of 3, final/.test(l)), c.lines.join('\n'));
  assert.ok(c.lines.some((l) => /^skip no_figures .*\[gemini: rejected/.test(l)), 'the skip line carries the chain log');
});

test('soft retry: no AI reachable (template only) leaves the item new without counting a failure', async () => {
  const r = run([templateSummarizer], { statusNote: 'retry:2:no_figures' });
  await runOnce(r.deps, { only: ['sec'] });
  assert.deepEqual(r.statuses.filter((x) => !x.includes('routine')), []);
});

// ---- pipeline: bulk handled check -----------------------------------------------------------------------------------------

test('handledUrls: handled filings cost no upsert; unhandled ones are processed; counted as skipped', async () => {
  const probe = run([badAi, templateSummarizer]);
  await runOnce(probe.deps, { only: ['sec'] });
  const all = [...probe.upserted];
  assert.ok(all.length >= 2, `fixture has at least 2 candidates (${all.length})`);
  const handled = new Set([all[0]]);
  let asked = 0;
  const r = run([badAi, templateSummarizer], { publisherPatch: { async handledUrls(urls) { asked++; assert.ok(urls.includes(all[0])); return handled; } } });
  const s = await runOnce(r.deps, { only: ['sec'] });
  assert.equal(asked, 1, 'one bulk call for the SEC source');
  assert.ok(!r.upserted.includes(all[0]), 'the handled filing was not upserted');
  assert.equal(r.upserted.length, all.length - 1);
  assert.ok(s.skipped >= 1);
});

test('handledUrls failing is harmless: every item is checked one by one', async () => {
  const probe = run([badAi, templateSummarizer]);
  await runOnce(probe.deps, { only: ['sec'] });
  const r = run([badAi, templateSummarizer], { publisherPatch: { async handledUrls() { throw new Error('rpc down'); } } });
  await runOnce(r.deps, { only: ['sec'] });
  assert.equal(r.upserted.length, probe.upserted.length);
  assert.ok(r.lines.some((l) => /handled-items check failed/.test(l)));
});

// ---- template cards for 1.01 / 2.01 -----------------------------------------------------------------------------------------

test('1.01 and 2.01 watch-list filings may be template cards; the card passes the publish checks and names the source', () => {
  const mk = (n: string) => ({
    source: 'sec_8k', source_name: 'SEC EDGAR', source_kind: 'filing', doc_label: '8-K', license_class: 'company_filing', company: 'Acme Corp',
    title: 'Acme Corp 8-K', url: `https://www.sec.gov/Archives/edgar/data/1/2/${n}-index.htm`, external_id: `x-${n}`, published_at: '2026-08-05T10:00:00Z',
    summary_text: '', category: 'deals', event_type: 'deal', tickers: [{ symbol: 'ACME', name: 'Acme Corp', exchange: 'NASDAQ' }],
    items: [{ number: n, title: `Item ${n}` }, { number: '9.01', title: 'Item 9.01' }],
  }) as unknown as RawItem;
  for (const n of ['1.01', '2.01']) {
    const it = mk(n);
    assert.equal(templateAllowed(it), true);
    const d = templateDraft({ item: it, text: '' });
    assert.match(d.headline, /^Acme Corp (signs a major agreement|completes an acquisition or asset sale)$/);
    assert.doesNotMatch(d.body ?? '', /\d/);
    const p = buildPublishPayload(it, d, { aiGenerated: false, model: null });
    assert.equal(p.sources.length >= 1, true);
    const v = validatePublish(p);
    assert.deepEqual(v.errors ?? [], []);
  }
});

// ---- Gemini: HTTP 5xx -> the other model -------------------------------------------------------------------------------------

const GOOD: SummaryDraft = {
  headline: 'Fed holds its policy rate steady', body: 'The Federal Reserve kept its target range unchanged. Officials cited steady inflation.',
  category: 'economy', event_type: 'fed', tickers: [], everyday_relevance: 5,
};
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] }), { status: 200 });
const fedItem = {
  source: 'fed_rss', source_name: 'Federal Reserve', source_kind: 'primary', doc_label: 'Press release', license_class: 'public_domain',
  title: 'Federal Reserve issues FOMC statement', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260805a.htm',
  external_id: 'fed-1', published_at: '2026-08-05T18:00:00Z', summary_text: 'The Federal Reserve kept its target range unchanged. Officials cited steady inflation.',
  category: 'economy', event_type: 'fed', tickers: [], items: [],
} as unknown as RawItem;

function gemNet(replies: number[]) {
  const urls: string[] = [];
  const impl: FetchLike = async (url) => {
    urls.push(url);
    const st = replies[Math.min(urls.length - 1, replies.length - 1)];
    return st === 200 ? geminiOk() : new Response('overloaded', { status: st });
  };
  return { urls, impl };
}

test('Gemini 503 then OK on the other model: one card, two requests, both counted against the daily cap', async () => {
  const net = gemNet([503, 200]);
  const g = createGeminiSummarizer({ apiKey: 'k', fetchImpl: net.impl, minIntervalMs: 0 });
  const counter = memoryCounter();
  const r = await summarizeWithChain({ item: fedItem, text: fedItem.summary_text }, [g], counter, { minIntervalMs: 0 });
  assert.equal(r.ai_generated, true);
  assert.equal(r.provider, 'gemini');
  assert.equal(net.urls.length, 2);
  assert.ok(net.urls[0].includes(config.gemini.model) && net.urls[1].includes(config.gemini.fallbackModel), net.urls.join('\n'));
  assert.equal(counter.used('gemini'), 2, 'the chain counts the first request, onExtraCall the second');
});

test('Gemini 503 on both models: ProviderError after exactly two requests (Groq takes over in the chain)', async () => {
  const net = gemNet([503, 503]);
  const g = createGeminiSummarizer({ apiKey: 'k', fetchImpl: net.impl, minIntervalMs: 0 });
  const counter = memoryCounter();
  const r = await summarizeWithChain({ item: fedItem, text: fedItem.summary_text }, [g], counter, { minIntervalMs: 0 });
  assert.equal(r.ai_generated, false);
  assert.equal(net.urls.length, 2);
  assert.match(r.log.join(' '), /gemini: ProviderError: gemini: HTTP 503/);
});

test('Gemini 429 is not retried on the other model; overloadFallback:false switches the 5xx attempt off', async () => {
  const net429 = gemNet([429]);
  const g = createGeminiSummarizer({ apiKey: 'k', fetchImpl: net429.impl, minIntervalMs: 0 });
  await summarizeWithChain({ item: fedItem, text: fedItem.summary_text }, [g], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(net429.urls.length, 1);
  const net503 = gemNet([503]);
  const g2 = createGeminiSummarizer({ apiKey: 'k', fetchImpl: net503.impl, minIntervalMs: 0, overloadFallback: false });
  await summarizeWithChain({ item: fedItem, text: fedItem.summary_text }, [g2], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(net503.urls.length, 1);
});
