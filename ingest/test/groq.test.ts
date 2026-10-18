// Groq fallback: Gemini -> Groq -> template. All offline (fake fetch), no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeWithChain, memoryCounter } from '../src/summarizer/chain.ts';
import { RateLimitedError, ProviderError } from '../src/summarizer/gemini.ts';
import { createGroqSummarizer, parseJsonLoose } from '../src/summarizer/groq.ts';
import { buildProviders } from '../src/summarizer/providers.ts';
import { parseSec8kAtom, secEntryToItem, parseTickerExchangeJson } from '../src/sources/sec.ts';
import { buildPublishPayload } from '../src/publish.ts';
import { aiDailyCap, config, groqDailyCap, groqMinIntervalMs } from '../src/config.ts';
import { NotSummarizableError } from '../src/validate.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';
import type { FetchLike } from '../src/allowlist.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
const gopro = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], tickers)!;
const input = { item: gopro, text: gopro.summary_text };

const GOOD: SummaryDraft = {
  headline: 'GoPro files results of operations for the quarter',
  body: 'GoPro filed its results with the SEC on 2026-10-16. The filing also covers Item 4.02.',
  category: 'earnings', event_type: 'earnings', tickers: ['GPRO'],
};
const BAD: SummaryDraft = { ...GOOD, body: 'GoPro revenue rose 14% to $800 million.' };   // invented numbers

const GEMINI_KEY = 'gemini-test-key-not-real';
const GROQ_KEY = 'groq-test-key-not-real';

type Reply = Response | Error;
const geminiOk = (d: SummaryDraft) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(d) }] } }] }), { status: 200 });
const groqOk = (d: SummaryDraft | string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof d === 'string' ? d : JSON.stringify(d) }, finish_reason: 'stop' }] }), { status: 200 });

/** Fake network: routes by host, records every request. */
function fakeNet(replies: { gemini?: () => Reply; groq?: () => Reply }) {
  const calls: { host: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const impl: FetchLike = async (url, init) => {
    const host = new URL(url).hostname;
    calls.push({ host, url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = host === 'api.groq.com' ? replies.groq?.() : replies.gemini?.();
    if (!r) return new Response('no route', { status: 404 });
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, impl, count: (h: string) => calls.filter((c) => c.host === h).length };
}

function realProviders(net: ReturnType<typeof fakeNet>, keys = { geminiApiKey: GEMINI_KEY as string | null, groqApiKey: GROQ_KEY as string | null }) {
  return buildProviders(keys, { fetchImpl: net.impl, minIntervalMs: 0 });
}

test('fallback: Gemini HTTP 429 -> Groq writes the card, Groq model recorded', async () => {
  const net = fakeNet({ gemini: () => new Response('{}', { status: 429 }), groq: () => groqOk(GOOD) });
  const r = await summarizeWithChain(input, realProviders(net).providers, memoryCounter());
  assert.equal(r.provider, 'groq');
  assert.equal(r.ai_generated, true);
  assert.equal(r.model, 'openai/gpt-oss-120b');
  assert.equal(net.count('generativelanguage.googleapis.com'), 1);   // no Gemini retry after a 429
  assert.match(r.log.join(' | '), /gemini: RateLimitedError/);
  console.log('  chain log:', r.log.join(' | '));
});

test('fallback: Gemini HTTP 503 -> Groq', async () => {
  const net = fakeNet({ gemini: () => new Response('overloaded', { status: 503 }), groq: () => groqOk(GOOD) });
  const r = await summarizeWithChain(input, realProviders(net).providers, memoryCounter());
  assert.equal(r.provider, 'groq');
  assert.match(r.log.join(), /gemini: ProviderError: gemini: HTTP 503/);
});

test('fallback: Gemini daily cap reached -> Gemini not called, Groq used', async () => {
  const net = fakeNet({ gemini: () => geminiOk(GOOD), groq: () => groqOk(GOOD) });
  const c = memoryCounter();
  for (let i = 0; i < aiDailyCap(); i++) c.add('gemini');
  const r = await summarizeWithChain(input, realProviders(net).providers, c);
  assert.equal(net.count('generativelanguage.googleapis.com'), 0);
  assert.equal(r.provider, 'groq');
  assert.equal(c.used('groq'), 1);
  assert.match(r.log.join(), /gemini: daily cap 500 reached/);
});

test('fallback: Gemini timeout -> Groq', async () => {
  const net = fakeNet({
    gemini: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError') as unknown as Error,
    groq: () => groqOk(GOOD),
  });
  const r = await summarizeWithChain(input, realProviders(net).providers, memoryCounter());
  assert.equal(r.provider, 'groq');
  assert.match(r.log.join(), /gemini: TimeoutError/);
});

test('missing keys: providers are skipped cleanly', async () => {
  const names = (k: { geminiApiKey: string | null; groqApiKey: string | null }) => buildProviders(k).providers.map((p) => p.name);
  assert.deepEqual(names({ geminiApiKey: GEMINI_KEY, groqApiKey: GROQ_KEY }), ['gemini', 'groq', 'template']);
  assert.deepEqual(names({ geminiApiKey: null, groqApiKey: GROQ_KEY }), ['groq', 'template']);
  assert.deepEqual(names({ geminiApiKey: GEMINI_KEY, groqApiKey: null }), ['gemini', 'template']);
  assert.deepEqual(names({ geminiApiKey: null, groqApiKey: null }), ['template']);
  assert.deepEqual(buildProviders({ geminiApiKey: null, groqApiKey: null }).skipped,
    ['gemini (GEMINI_API_KEY not set)', 'groq (GROQ_API_KEY not set)']);

  // No Gemini key: Groq writes the card and Gemini's host is never contacted.
  const net = fakeNet({ gemini: () => geminiOk(GOOD), groq: () => groqOk(GOOD) });
  const r = await summarizeWithChain(input, realProviders(net, { geminiApiKey: null, groqApiKey: GROQ_KEY }).providers, memoryCounter());
  assert.equal(r.provider, 'groq');
  assert.equal(net.count('generativelanguage.googleapis.com'), 0);
});

test('Gemini drafts rejected twice -> Groq gets a fresh first attempt', async () => {
  const net = fakeNet({ gemini: () => geminiOk(BAD), groq: () => groqOk(GOOD) });
  const r = await summarizeWithChain(input, realProviders(net).providers, memoryCounter());
  assert.equal(net.count('generativelanguage.googleapis.com'), 2);
  assert.equal(r.provider, 'groq');
  assert.equal(r.model, 'openai/gpt-oss-120b');
  const groqPrompt = net.calls.find((c) => c.host === 'api.groq.com')!.body.messages[0].content as string;
  assert.doesNotMatch(groqPrompt, /previous answer was rejected/);   // Gemini's errors are not carried over
});

test('Groq rejected twice (after Gemini 429) -> template card', async () => {
  const net = fakeNet({ gemini: () => new Response('{}', { status: 429 }), groq: () => groqOk(BAD) });
  const r = await summarizeWithChain(input, realProviders(net).providers, memoryCounter());
  assert.equal(net.count('api.groq.com'), 2);
  assert.equal(r.provider, 'template');
  assert.equal(r.ai_generated, false);
  assert.equal(r.model, null);
  const second = net.calls.filter((c) => c.host === 'api.groq.com')[1].body.messages[0].content as string;
  assert.match(second, /rejected for: numbers not in source: 14, 800/);   // retry carries the validator errors
  console.log('  chain log:', r.log.join(' | '));
});

test('Groq limits (verified 2026-10-17): daily cap 74 (sum-v3 token estimate), pacing 30 s; cap reached -> skipped', async () => {
  assert.deepEqual([config.groq.freeRpm, config.groq.freeRpd, config.groq.freeTpm, config.groq.freeTpd], [30, 1000, 8000, 200000]);
  assert.equal(config.groq.estimatedTokensPerCall, 2700);  // card + detail (sum-v3)
  assert.ok(config.groq.maxCompletionTokens >= 2048);
  assert.equal(groqDailyCap(), 74);                       // min(80, 1000, floor(200000 / 2700) = 74)
  assert.equal(groqMinIntervalMs({ freeRpm: 30, freeTpm: 8000, estimatedTokensPerCall: 2700, minIntervalMsFloor: 0 }), 25_313);   // TPM gap below the 30 s floor
  const base = { dailyCapCode: 1000, freeRpd: 1000, freeTpd: 200_000, estimatedTokensPerCall: 2200 };
  assert.equal(groqDailyCap(base), 90);                   // token-per-day bound
  assert.equal(groqDailyCap({ ...base, freeRpd: 50 }), 50);
  assert.equal(groqMinIntervalMs(), 30_000);              // floor wins over 16.5 s (TPM) and 2 s (RPM)
  // with the 0.8 safety factor: TPM gap 16.5 s / 0.8 = 20.6 s, RPM gap 2 s / 0.8 = 2.5 s
  assert.equal(groqMinIntervalMs({ freeRpm: 30, freeTpm: 8000, estimatedTokensPerCall: 2200, minIntervalMsFloor: 0 }), 20_625);
  assert.equal(groqMinIntervalMs({ freeRpm: 30, freeTpm: null, estimatedTokensPerCall: 2200, minIntervalMsFloor: 0 }), 2500);
  assert.equal(groqMinIntervalMs({ freeRpm: 30, freeTpm: 8000, estimatedTokensPerCall: 2200, minIntervalMsFloor: 0 }, 1), 16_500);

  const net = fakeNet({ gemini: () => new Response('{}', { status: 429 }), groq: () => groqOk(GOOD) });
  const c = memoryCounter();
  for (let i = 0; i < 74; i++) c.add('groq');
  const r = await summarizeWithChain(input, realProviders(net).providers, c);
  assert.equal(net.count('api.groq.com'), 0);
  assert.equal(r.provider, 'template');
  assert.match(r.log.join(), /groq: daily cap 74 reached/);
});

test('Groq gets at most 6,000 characters of source text', async () => {
  const net = fakeNet({ groq: () => groqOk(GOOD) });
  const g = createGroqSummarizer({ apiKey: GROQ_KEY, fetchImpl: net.impl });
  const long = 'A'.repeat(6000) + 'TAILMARK' + 'B'.repeat(4000);   // 10,008 chars; marker starts at char 6,001
  await g.summarize({ item: gopro, text: long });
  const prompt = net.calls[0].body.messages[0].content as string;
  assert.doesNotMatch(prompt, /TAILMARK|B{10}/);
  assert.ok(prompt.split('SOURCE TEXT:\n')[1].length <= 6000);
});

test('Groq adapter: key only in the Authorization header, never in the URL; JSON schema mode', async () => {
  const net = fakeNet({ groq: () => groqOk(GOOD) });
  const g = createGroqSummarizer({ apiKey: GROQ_KEY, fetchImpl: net.impl });
  assert.deepEqual(await g.summarize(input), GOOD);
  const c = net.calls[0];
  assert.equal(c.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.doesNotMatch(c.url, /test-key/);
  assert.equal(c.headers.Authorization, `Bearer ${GROQ_KEY}`);
  assert.doesNotMatch(JSON.stringify(c.body), /test-key/);
  assert.equal(c.body.model, 'openai/gpt-oss-120b');
  assert.equal(c.body.response_format.type, 'json_schema');
  assert.equal(c.body.response_format.json_schema.strict, true);
  assert.match(c.body.messages[0].content, /SOURCE TEXT:\nGoPro, Inc\. Form 8-K/);
});

test('Groq adapter: 400 on json_schema -> one retry in json_object mode', async () => {
  let n = 0;
  const net = fakeNet({
    groq: () => (n++ === 0 ? new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 }) : groqOk(GOOD)),
  });
  const g = createGroqSummarizer({ apiKey: GROQ_KEY, fetchImpl: net.impl });
  assert.deepEqual(await g.summarize(input), GOOD);
  assert.equal(net.calls.length, 2);
  assert.equal(net.calls[1].body.response_format.type, 'json_object');
});

test('Groq adapter: 429 -> RateLimitedError, 500 -> ProviderError, empty -> ProviderError', async () => {
  const mk = (r: () => Reply) => createGroqSummarizer({ apiKey: GROQ_KEY, fetchImpl: fakeNet({ groq: r }).impl });
  await assert.rejects(mk(() => new Response('{}', { status: 429 })).summarize(input), RateLimitedError);
  await assert.rejects(mk(() => new Response('oops', { status: 500 })).summarize(input), ProviderError);
  await assert.rejects(mk(() => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 })).summarize(input), /finish_reason length/);
});

test('parseJsonLoose: plain, fenced, with text around it; garbage throws', () => {
  assert.deepEqual(parseJsonLoose(JSON.stringify(GOOD)), GOOD);
  assert.deepEqual(parseJsonLoose('```json\n' + JSON.stringify(GOOD) + '\n```'), GOOD);
  assert.deepEqual(parseJsonLoose('Here it is: ' + JSON.stringify(GOOD) + ' done'), GOOD);
  assert.throws(() => parseJsonLoose('no json here'), ProviderError);
});

test('license gate: non-summarizable text reaches neither Gemini nor Groq', async () => {
  const net = fakeNet({ gemini: () => geminiOk(GOOD), groq: () => groqOk(GOOD) });
  for (const lc of ['link_out', 'dev_only', 'guardian_noncomm']) {
    const item = { ...gopro, license_class: lc } as unknown as RawItem;
    await assert.rejects(summarizeWithChain({ item, text: 'x' }, realProviders(net).providers, memoryCounter()), NotSummarizableError);
  }
  assert.equal(net.calls.length, 0);
});

test('pacing is per provider: Groq does not wait on Gemini\'s timer', async () => {
  const times: Record<string, number[]> = { pa: [], pb: [] };
  const mk = (name: string): Summarizer => ({
    name, usesAi: true, minIntervalMs: 300, async summarize() { times[name].push(Date.now()); return GOOD; },
  });
  const a = mk('pa'), b = mk('pb');
  await summarizeWithChain(input, [a], memoryCounter());
  await summarizeWithChain(input, [b], memoryCounter());   // other provider: no wait
  await summarizeWithChain(input, [a], memoryCounter());   // same provider: waits
  const bGap = times.pb[0] - times.pa[0];
  const aGap = times.pa[1] - times.pa[0];
  assert.ok(bGap < 150, `second provider waited ${bGap} ms`);
  assert.ok(aGap >= 290, `same provider gap was only ${aGap} ms`);
});

test('real adapters carry their own pacing and caps: Gemini 5 s / 500, Groq 30 s / 74', () => {
  const { providers } = buildProviders({ geminiApiKey: GEMINI_KEY, groqApiKey: GROQ_KEY });
  assert.deepEqual(providers.map((p) => [p.name, p.minIntervalMs, p.dailyCap, p.model ?? null]), [
    ['gemini', 5000, 500, 'gemini-3.5-flash-lite'],
    ['groq', 30000, 74, 'openai/gpt-oss-120b'],
    ['template', undefined, undefined, null],
  ]);
});

test('model recorded on the card: Gemini model for Gemini, Groq model for Groq, null for template', async () => {
  const g = await summarizeWithChain(input, realProviders(fakeNet({ gemini: () => geminiOk(GOOD) })).providers, memoryCounter());
  assert.equal(g.provider, 'gemini');
  assert.equal(g.model, 'gemini-3.5-flash-lite');

  const q = await summarizeWithChain(input, realProviders(fakeNet({ gemini: () => new Response('', { status: 429 }), groq: () => groqOk(GOOD) })).providers, memoryCounter());
  const payload = buildPublishPayload(gopro, q.draft, { itemId: 'x', aiGenerated: q.ai_generated, model: q.model });
  assert.equal(payload.model, 'openai/gpt-oss-120b');
  assert.equal(payload.ai_generated, true);

  const fakeNoModel: Summarizer = { name: 'other', usesAi: true, async summarize() { return GOOD; } };
  assert.equal((await summarizeWithChain(input, [fakeNoModel], memoryCounter())).model, null);   // no longer defaults to Gemini's model
});
