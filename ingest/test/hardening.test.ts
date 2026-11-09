// Hardening (watchdog design sections 5-7): request timeouts including body reads, daily-quota 429s,
// retired-model fallback, and the cloud-only Groq scorer cutoff. Offline: fake fetch, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchAllowed, type FetchLike } from '../src/allowlist.ts';
import { createGeminiSummarizer, isDailyQuota, isModelMissing, RateLimitedError } from '../src/summarizer/gemini.ts';
import { createGroqSummarizer } from '../src/summarizer/groq.ts';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { parseSec8kAtom, secEntryToItem, parseTickerExchangeJson } from '../src/sources/sec.ts';
import type { Summarizer, SummaryDraft } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
const gopro = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], tickers)!;
const input = { item: gopro, text: gopro.summary_text };
const GOOD: SummaryDraft = {
  headline: 'GoPro files results of operations for the quarter',
  body: 'GoPro filed its results with the SEC on 2026-10-16. The filing also covers Item 4.02.',
  category: 'earnings', event_type: 'earnings', tickers: ['GPRO'],
};

/** A response whose body never arrives (text() never resolves, ignores the abort signal). */
const hangingBody = (): Response => {
  const r = new Response('x', { status: 200 });
  (r as { text: () => Promise<string> }).text = () => new Promise<string>(() => {});
  return r;
};

test('fetchAllowed: a body that never arrives times out (TimeoutError), the fetch itself too', async () => {
  const t0 = Date.now();
  await assert.rejects(
    fetchAllowed('https://api.groq.com/x', { kind: 'api', timeoutMs: 60, fetchImpl: async () => hangingBody() }),
    (e: Error) => e.name === 'TimeoutError' && /timed out/.test(e.message),
  );
  await assert.rejects(
    fetchAllowed('https://api.groq.com/x', { kind: 'api', timeoutMs: 60, fetchImpl: () => new Promise<Response>(() => {}) }),
    (e: Error) => e.name === 'TimeoutError',
  );
  assert.ok(Date.now() - t0 < 3000, 'both ended near the 60 ms deadline');
});

test('fetchAllowed: the default timeout is the 20 s from config; a normal reply is unaffected', async () => {
  assert.equal(config.fetchTimeoutMs, 20_000);
  const r = await fetchAllowed('https://api.groq.com/x', { kind: 'api', fetchImpl: async () => new Response('ok', { status: 200 }) });
  assert.equal(r.text, 'ok');
});

test('Groq and Gemini adapters pass the timeout down: a hanging body rejects as TimeoutError', async () => {
  const groq = createGroqSummarizer({ apiKey: 'k', timeoutMs: 60, fetchImpl: async () => hangingBody() });
  await assert.rejects(groq.summarize(input), (e: Error) => e.name === 'TimeoutError');
  await assert.rejects(groq.generate!('say JSON'), (e: Error) => e.name === 'TimeoutError');
  const gem = createGeminiSummarizer({ apiKey: 'k', timeoutMs: 60, fetchImpl: async () => hangingBody() });
  await assert.rejects(gem.summarize(input), (e: Error) => e.name === 'TimeoutError');
});

test('429 bodies: daily quota is told apart from a per-minute limit', async () => {
  assert.equal(isDailyQuota('Rate limit reached for model on tokens per day (TPD): Limit 200000'), true);
  assert.equal(isDailyQuota('Quota exceeded for metric generate_content_free_tier_requests, limit: 500, RequestsPerDay'), true);
  assert.equal(isDailyQuota('Rate limit reached ... on tokens per minute (TPM): Limit 8000, try again in 5.2s'), false);
  const mk = (text: string) => createGroqSummarizer({ apiKey: 'k', fetchImpl: async () => new Response(text, { status: 429 }) });
  await assert.rejects(mk('requests per day (RPD)').summarize(input), (e: RateLimitedError) => e.name === 'RateLimitedError' && e.daily === true);
  await assert.rejects(mk('tokens per minute (TPM)').summarize(input), (e: RateLimitedError) => e.daily === false);
  // the scorer does not wait and retry for a daily quota (it never clears within a run)
  let calls = 0;
  const g = createGroqSummarizer({ apiKey: 'k', fetchImpl: async () => { calls++; return new Response('tokens per day (TPD)', { status: 429 }); } });
  await assert.rejects(g.generate!('JSON'), (e: RateLimitedError) => e.daily === true);
  assert.equal(calls, 1);
});

test('isModelMissing: 404, or 400 that names the model; other errors are not', () => {
  assert.equal(isModelMissing(404, '{}'), true);
  assert.equal(isModelMissing(400, '{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}'), true);
  assert.equal(isModelMissing(400, 'models/gemini-old is not found for API version v1beta'), true);
  assert.equal(isModelMissing(400, 'response_format json_schema is not supported'), false);
  assert.equal(isModelMissing(500, 'model not found'), false);
  assert.equal(isModelMissing(429, ''), false);
});

test('retired model: Gemini 404 -> the same call goes to fallbackModel, modelMissing is set, later calls keep the fallback', async () => {
  const urls: string[] = [];
  const ok = new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] }), { status: 200 });
  const g = createGeminiSummarizer({
    apiKey: 'k', fetchImpl: async (url) => {
      urls.push(url);
      return url.includes(config.gemini.model) ? new Response('{}', { status: 404 }) : ok.clone();
    },
  });
  assert.equal(g.modelMissing, false);
  assert.deepEqual(await g.summarize(input), GOOD);
  assert.equal(urls.length, 2);
  assert.ok(urls[0]!.includes(config.gemini.model) && urls[1]!.includes(config.gemini.fallbackModel));
  assert.equal(g.modelMissing, true);
  assert.equal(g.model, config.gemini.fallbackModel);
  await g.summarize(input);
  assert.equal(urls.length, 3);
  assert.ok(urls[2]!.includes(config.gemini.fallbackModel));
});

test('retired model: Groq 400 "model not found" -> alternativeModel; if that fails too the error surfaces (one switch only)', async () => {
  const models: string[] = [];
  const groqOk = (d: SummaryDraft) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(d) }, finish_reason: 'stop' }] }), { status: 200 });
  const g = createGroqSummarizer({
    apiKey: 'k', fetchImpl: async (_u, init) => {
      const m = JSON.parse(String(init.body)).model as string;
      models.push(m);
      return m === config.groq.model ? new Response('{"error":{"code":"model_not_found","message":"model does not exist"}}', { status: 400 }) : groqOk(GOOD);
    },
  });
  assert.deepEqual(await g.summarize(input), GOOD);
  assert.deepEqual(models, [config.groq.model, config.groq.alternativeModel]);
  assert.equal(g.modelMissing, true);
  const dead = createGroqSummarizer({ apiKey: 'k', fetchImpl: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(dead.summarize(input), /HTTP 404/);
});

// ---- cloud-only scorer cutoff ------------------------------------------------------

function pipelineSetup(groqUsed: number, cutoff: number | undefined) {
  const dry = createDryRunPublisher();
  let scored = 0;
  const writer: Summarizer = {
    name: 'gemini', usesAi: true, model: 'w',
    async summarize() { return { headline: 'A short plain news card one', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 }; },
  };
  const groq: Summarizer = {
    name: 'groq', usesAi: true, model: 'g', summarize: async () => { throw new Error('unused'); },
    generate: async () => { scored++; throw new Error('scorer called'); },
  };
  const counter = memoryCounter();
  for (let i = 0; i < groqUsed; i++) counter.add('groq');
  const deps: Deps = {
    fetchText: fixtureFetcher(), publisher: dry.publisher, providers: [writer, groq], counter, fredApiKey: null, now: DRY_NOW, log: () => {},
    reportCard: { enabled: true, ...(cutoff === undefined ? {} : { scorerMaxGroqUsed: cutoff }) },
  };
  return { deps, dry, scored: () => scored };
}

test('Groq scorer cutoff: at 50 Groq calls the scorer is not called and cards publish unscored', async () => {
  const t = pipelineSetup(50, config.reportCard.cloudScorerMaxGroqUsed);
  assert.equal(config.reportCard.cloudScorerMaxGroqUsed, 50);
  const s = await runOnce(t.deps, { only: ['cpsc'], limit: 3 });
  assert.equal(t.scored(), 0);
  assert.ok(s.published >= 1, `published ${s.published}`);
});

test('Groq scorer cutoff: at 49 the scorer runs (here it fails, so nothing is published); without a cutoff (laptop) it always runs', async () => {
  const under = pipelineSetup(49, 50);
  await runOnce(under.deps, { only: ['cpsc'], limit: 2 });
  assert.ok(under.scored() >= 1);
  const laptop = pipelineSetup(60, undefined);
  await runOnce(laptop.deps, { only: ['cpsc'], limit: 2 });
  assert.ok(laptop.scored() >= 1);
});
