// AI caps count every request (rewrite, scorer, model fallback, format retry), the file counter is atomic
// across processes, a failed item insert does not end a source's run, and rule 3 (Guardian text only to a
// paid key) is enforced in summarize(). All offline: fake fetch, fake providers, fixture sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { fileCounter, memoryCounter, summarizeWithChain } from '../src/summarizer/chain.ts';
import { createGeminiSummarizer } from '../src/summarizer/gemini.ts';
import { createGroqSummarizer } from '../src/summarizer/groq.ts';
import { parseSec8kAtom, parseTickerExchangeJson, secEntryToItem } from '../src/sources/sec.ts';
import { assertPaidKeyFor, isGuardianText, NotSummarizableError, PaidKeyRequiredError } from '../src/validate.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';
import type { FetchLike } from '../src/allowlist.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const gopro = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], parseTickerExchangeJson(fx('sec-company-tickers-exchange.json')))!;
const DRAFT: SummaryDraft = {
  headline: 'GoPro files results of operations for the quarter',
  body: 'GoPro filed its results with the SEC on 2026-10-16. The filing also covers Item 4.02.',
  category: 'earnings', event_type: 'earnings', tickers: ['GPRO'], everyday_relevance: 4,
};
const geminiOk = (d: SummaryDraft) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(d) }] } }] }), { status: 200 });
const groqOk = (d: SummaryDraft) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(d) }, finish_reason: 'stop' }] }), { status: 200 });
function net(reply: (n: number) => Response) {
  let n = 0;
  const impl: FetchLike = async () => reply(n++);
  return { impl, calls: () => n };
}

// ---- P2-8: the retired-model fallback request is counted ---------------------------------------------------
test('gemini: the retired-model fallback request counts against the daily cap (counter = HTTP requests)', async () => {
  const f = net((n) => (n === 0 ? new Response('model not found', { status: 404 }) : geminiOk(DRAFT)));
  const g = createGeminiSummarizer({ apiKey: 'gemini-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0, fallbackModel: 'gemini-fallback-test' });
  const counter = memoryCounter();
  await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [g], counter, { minIntervalMs: 0, maxAttempts: 1 });
  assert.equal(g.modelMissing, true);
  assert.equal(f.calls(), 2);
  assert.equal(counter.used('gemini'), 2);
});

test('groq: the model fallback and the json_schema -> json_object retry are counted too', async () => {
  const f = net((n) => (n === 0 ? new Response('{"error":{"message":"model not found"}}', { status: 404 })
    : n === 1 ? new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 }) : groqOk(DRAFT)));
  const g = createGroqSummarizer({ apiKey: 'groq-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0, fallbackModel: 'groq-fallback-test' });
  const counter = memoryCounter();
  await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [g], counter, { minIntervalMs: 0, maxAttempts: 1 });
  assert.equal(f.calls(), 3);
  assert.equal(counter.used('groq'), 3);
});

// ---- P2-7: fileCounter is atomic across processes -------------------------------------------------------------
test('fileCounter: two processes adding at the same time lose no increment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'element-usage-'));
  try {
    const file = join(dir, 'ai-usage.json');
    const N = 150;
    const chain = pathToFileURL(new URL('../src/summarizer/chain.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
    const script = `import { fileCounter } from ${JSON.stringify(chain)}; const c = fileCounter(${JSON.stringify(file)}); for (let i = 0; i < ${N}; i++) c.add('gemini');`;
    const run = () => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${err}`))));
    });
    await Promise.all([run(), run()]);
    assert.equal(fileCounter(file).used('gemini'), 2 * N);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- P2-6: report-card rewrite and scorer calls are counted ------------------------------------------------
const ENTRY = (id: string, over: Record<string, unknown>) => ({ id, topic_fit: true, matched_topic: 'x', scores: { headline: 2, summary: 2, trust: 2, importance: 2 }, relation: 'NEW', related_id: null, reason: 'ok', recommendations: [], ...over });
const scoreReply = (prompt: string, over: Record<string, unknown>) => {
  const cards = prompt.slice(prompt.lastIndexOf('CARDS '), prompt.lastIndexOf('RECENT '));
  return JSON.stringify({ scores: [ENTRY(/"id":"([^"]+)"/.exec(cards)![1]!, over)] });
};
function fakeWriter(calls: string[]): Summarizer {
  let n = 0;
  return {
    name: 'gemini', usesAi: true, model: 'fake-writer',
    async summarize(i) {
      calls.push(i.retryErrors?.length ? 'rewrite' : 'write');
      return { headline: `A short plain news card number ${['one', 'two', 'three', 'four', 'five', 'six'][n++ % 6]}`, body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 };
    },
  };
}
function fakeGroq(gen: string[], over: Record<string, unknown>): Summarizer {
  return {
    name: 'groq', usesAi: true, model: 'fake-scorer', dailyCap: 74,
    async summarize() { throw new Error('writer is gemini in this test'); },
    async generate(prompt) { gen.push(prompt); return scoreReply(prompt, over); },
  };
}
function deps(over: Partial<Deps>, pub: Partial<Publisher> = {}) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const d: Deps = { fetchText: fixtureFetcher(), publisher: { ...dry.publisher, async setItemStatus() {}, async auditCards() { return []; }, ...pub }, providers: [], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (l) => lines.push(l), ...over };
  return { d, dry, lines };
}

test('protocol: every scorer request and every rewrite count against the daily caps', async () => {
  const writes: string[] = [], gen: string[] = [];
  const revise = { scores: { headline: 1, summary: 0, trust: 2, importance: 2 }, recommendations: ['add why it matters'] };
  const t = deps({ providers: [fakeWriter(writes), fakeGroq(gen, revise)], reportCard: { enabled: true } });
  await runOnce(t.d, { only: ['cpsc'], limit: 3 });
  assert.ok(writes.includes('rewrite'), t.lines.join('\n'));
  assert.ok(gen.length > 0);
  assert.equal(t.d.counter.used('gemini'), writes.length, 'writes + rewrites');
  assert.equal(t.d.counter.used('groq'), gen.length, 'scorer requests');
});

test('protocol: at the Groq daily cap the scorer is not called and cards publish unscored', async () => {
  const writes: string[] = [], gen: string[] = [];
  const counter = memoryCounter();
  for (let i = 0; i < 74; i++) counter.add('groq');
  const t = deps({ providers: [fakeWriter(writes), fakeGroq(gen, {})], counter, reportCard: { enabled: true } });
  const s = await runOnce(t.d, { only: ['cpsc'], limit: 3 });
  assert.equal(gen.length, 0);
  assert.equal(counter.used('groq'), 74);
  assert.ok(s.published > 0);
});

// ---- P2-9: a failed upsertItem marks that item failed and the run goes on ------------------------------
test('a failing upsertItem fails only that item; the rest of the source still publishes', async () => {
  const writes: string[] = [];
  const dry = createDryRunPublisher();
  let n = 0;
  const t = deps({ providers: [fakeWriter(writes)] }, { upsertItem: async (it: RawItem) => { if (n++ === 0) throw new Error('db hiccup'); return dry.publisher.upsertItem(it); } });
  const s = await runOnce(t.d, { only: ['cpsc'], limit: 5 });
  assert.equal(s.failed, 1, t.lines.join('\n'));
  assert.ok(s.published >= 1);
  assert.ok(t.lines.some((l) => /failed: record item .*db hiccup/.test(l)));
});

// ---- rule 3: Guardian text only goes to the paid key; summarize() throws otherwise -----------------------
const guardian = { ...gopro, source: 'guardian', license_class: 'guardian' } as unknown as RawItem;

test('rule 3: Guardian text is refused by summarize() on a free Gemini key and on Groq, before any request', async () => {
  assert.equal(isGuardianText(guardian), true);
  assert.equal(isGuardianText(gopro), false);
  const f = net(() => geminiOk(DRAFT));
  const free = createGeminiSummarizer({ apiKey: 'gemini-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0 });
  await assert.rejects(free.summarize({ item: guardian, text: 'guardian text' }), PaidKeyRequiredError);
  const groq = createGroqSummarizer({ apiKey: 'groq-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0 });
  await assert.rejects(groq.summarize({ item: guardian, text: 'guardian text' }), PaidKeyRequiredError);
  assert.equal(f.calls(), 0, 'no request was sent');
  const paid = createGeminiSummarizer({ apiKey: 'gemini-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0, paidKey: true });
  await paid.summarize({ item: guardian, text: 'guardian text' });
  assert.equal(f.calls(), 1, 'the paid key may send it');
  assert.throws(() => assertPaidKeyFor(guardian, { name: 'x' }), PaidKeyRequiredError);
  assert.doesNotThrow(() => assertPaidKeyFor(gopro, { name: 'x' }));
});

test('rule 3: the chain still refuses Guardian text outright in this build (license gate first)', async () => {
  const f = net(() => geminiOk(DRAFT));
  const paid = createGeminiSummarizer({ apiKey: 'gemini-test-key-not-real', fetchImpl: f.impl, minIntervalMs: 0, paidKey: true });
  await assert.rejects(summarizeWithChain({ item: guardian, text: 'guardian text' }, [paid], memoryCounter()), NotSummarizableError);
  assert.equal(f.calls(), 0);
});
