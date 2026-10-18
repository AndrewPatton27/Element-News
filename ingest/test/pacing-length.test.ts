// Live-run fixes (2026-10-17): pacing safety margin, 429 cooldown, length compliance and the
// body-trim safety net. All offline (fake fetch / fake providers), no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChainState, memoryCounter, summarizeWithChain } from '../src/summarizer/chain.ts';
import { buildPrompt, RateLimitedError, RESPONSE_SCHEMA } from '../src/summarizer/gemini.ts';
import { GROQ_JSON_SCHEMA, groqJsonSchema } from '../src/summarizer/groq.ts';
import { buildProviders } from '../src/summarizer/providers.ts';
import { parseSec8kAtom, parseTickerExchangeJson, secEntryToItem } from '../src/sources/sec.ts';
import { config } from '../src/config.ts';
import { countWords, splitSentences, trimBodyToFit } from '../src/validate.ts';
import type { Summarizer, SummaryDraft } from '../src/types.ts';
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

// Three sentences, 66 words in total; the first two (46 words) fit the 60-word limit.
const S1 = 'The camera maker told regulators about its latest quarterly results in a 2026-10-16 filing that points readers to an attached press release for the details.';
const S2 = 'The company also flagged that some earlier financial statements may need another look, which usually means extra review by its auditors.';
const S3 = 'Readers who follow the company may want to watch for a fuller report and any restated figures later this year.';
const LONG_BODY: SummaryDraft = { ...GOOD, body: `${S1} ${S2} ${S3}` };
const LONG_HEADLINE: SummaryDraft = { ...LONG_BODY, headline: 'GoPro tells regulators about quarterly results and flags that earlier statements may need another careful look' };

function fake(name: string, outputs: (SummaryDraft | Error)[]): Summarizer & { calls: number; inputs: unknown[] } {
  const s = {
    name, usesAi: true, model: `${name}-model`, calls: 0, inputs: [] as unknown[],
    async summarize(i: unknown) {
      s.inputs.push(i);
      const o = outputs[Math.min(s.calls++, outputs.length - 1)];
      if (o instanceof Error) throw o;
      return o;
    },
  };
  return s;
}

// ---- Fix 1: pacing and cooldown ---------------------------------------------------

test('pacing uses the safety factor: Gemini 5 s (12/min, was 4 s = exactly 15/min), Groq floor 30 s', () => {
  const { providers } = buildProviders({ geminiApiKey: 'gemini-test-key-not-real', groqApiKey: 'groq-test-key-not-real' });
  assert.equal(providers.find((p) => p.name === 'gemini')!.minIntervalMs, 5000);
  assert.equal(providers.find((p) => p.name === 'groq')!.minIntervalMs, 30_000);
  assert.ok(60_000 / 5000 <= config.gemini.freeRpm * config.rpmSafetyFactor);
});

test('429 cooldown: after a Gemini rate limit, the next items in the run skip Gemini for 60 s', async () => {
  let t = 1_000_000;
  const now = () => t;
  const state = createChainState();
  const gemini = fake('gemini', [new RateLimitedError('gemini'), GOOD]);
  const groq = fake('groq', [GOOD]);

  const r1 = await summarizeWithChain(input, [gemini, groq], memoryCounter(), { minIntervalMs: 0, state, now });
  assert.equal(r1.provider, 'groq');
  assert.equal(gemini.calls, 1);

  t += 30_000;                                         // 30 s later: still cooling down
  const r2 = await summarizeWithChain(input, [gemini, groq], memoryCounter(), { minIntervalMs: 0, state, now });
  assert.equal(r2.provider, 'groq');
  assert.equal(gemini.calls, 1, 'Gemini must not be called during the cooldown');
  assert.match(r2.log.join(' | '), /gemini: cooling down after a rate limit \(30 s left\), skipped/);

  t += 31_000;                                         // 61 s after the 429: Gemini is tried again
  const r3 = await summarizeWithChain(input, [gemini, groq], memoryCounter(), { minIntervalMs: 0, state, now });
  assert.equal(r3.provider, 'gemini');
  assert.equal(gemini.calls, 2);
  console.log('  cooldown log:', r2.log.join(' | '));
});

test('cooldown only follows a 429, not other provider errors; no state passed = no memory', async () => {
  const state = createChainState();
  const err = new Error('gemini: HTTP 503'); err.name = 'ProviderError';
  const gemini = fake('gemini', [err, GOOD]);
  const groq = fake('groq', [GOOD]);
  await summarizeWithChain(input, [gemini, groq], memoryCounter(), { minIntervalMs: 0, state });
  const r = await summarizeWithChain(input, [gemini, groq], memoryCounter(), { minIntervalMs: 0, state });
  assert.equal(r.provider, 'gemini');

  const g2 = fake('gemini', [new RateLimitedError('gemini'), GOOD]);
  await summarizeWithChain(input, [g2, groq], memoryCounter(), { minIntervalMs: 0 });
  const r2 = await summarizeWithChain(input, [g2, groq], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(r2.provider, 'gemini');
});

// ---- Fix 2: length compliance ------------------------------------------------------

test('prompt states the hard limits with numbers; schemas describe them; Groq maxLength is opt-in', () => {
  const p = buildPrompt(input);
  assert.match(p, /HARD LIMITS.*headline at most 90 characters including spaces; body 2 or 3 sentences and at most 60 words/);
  assert.match(RESPONSE_SCHEMA.properties.headline.description, /At most 90 characters/);
  assert.match(GROQ_JSON_SCHEMA.schema.properties.headline.description, /At most 90 characters/);
  assert.equal(config.groq.schemaMaxLength, false);
  assert.equal((groqJsonSchema(false).schema.properties.headline as any).maxLength, undefined);
  assert.equal((groqJsonSchema(true).schema.properties.headline as any).maxLength, 90);
  assert.equal((GROQ_JSON_SCHEMA.schema.properties.headline as any).maxLength, undefined, 'base schema not mutated');
});

test('Groq retry request carries the validator errors and the shorter-limits line', async () => {
  const bodies: any[] = [];
  const impl: FetchLike = async (url, init) => {
    const host = new URL(url).hostname;
    if (host !== 'api.groq.com') return new Response('{}', { status: 429 });
    bodies.push(JSON.parse(String(init.body)));
    const d = bodies.length === 1 ? LONG_HEADLINE : GOOD;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(d) }, finish_reason: 'stop' }] }), { status: 200 });
  };
  const { providers } = buildProviders({ geminiApiKey: 'gemini-test-key-not-real', groqApiKey: 'groq-test-key-not-real' }, { fetchImpl: impl, minIntervalMs: 0 });
  const r = await summarizeWithChain(input, providers, memoryCounter());
  assert.equal(r.provider, 'groq');
  assert.equal(bodies.length, 2);
  const retryPrompt: string = bodies[1].messages[0].content;
  assert.match(retryPrompt, /Your previous answer was rejected for: headline longer than 90 chars \(was \d+\)/);
  assert.match(retryPrompt, /Write it shorter: headline at most 90 characters, body at most 60 words/);
  assert.doesNotMatch(bodies[0].messages[0].content, /previous answer/);
  console.log('  groq log:', r.log.join(' | '));
});

test('splitSentences keeps abbreviations and decimals inside a sentence', () => {
  assert.deepEqual(splitSentences('The U.S. economy grew 2.5% in Q3. Acme Inc. named a new CEO. Done'), [
    'The U.S. economy grew 2.5% in Q3.', 'Acme Inc. named a new CEO.', 'Done',
  ]);
});

test('trimBodyToFit: cuts after the last whole sentence that fits 60 words', () => {
  assert.equal(countWords(LONG_BODY.body!), 66);
  const fixed = trimBodyToFit(LONG_BODY, ['body longer than 60 words (was 66)'])!;
  assert.equal(fixed.body, `${S1} ${S2}`);
  assert.ok(countWords(fixed.body!) <= 60);
  assert.equal(fixed.headline, LONG_BODY.headline);
});

test('trimBodyToFit refuses: headline too long, non-length errors, no whole sentence fits', () => {
  assert.equal(trimBodyToFit(LONG_HEADLINE, ['headline longer than 90 chars (was 110)', 'body longer than 60 words (was 66)']), null);
  assert.equal(trimBodyToFit(LONG_BODY, ['body longer than 60 words (was 66)', 'numbers not in source: 14']), null);
  const oneHuge = { ...GOOD, body: Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ') + '.' };
  assert.equal(trimBodyToFit(oneHuge, ['body longer than 60 words (was 70)']), null);
});

test('safety net in the chain: long body fixed without a second request; Gemini and Groq alike', async () => {
  for (const name of ['gemini', 'groq']) {
    const p = fake(name, [LONG_BODY, GOOD]);
    const r = await summarizeWithChain(input, [p], memoryCounter(), { minIntervalMs: 0 });
    assert.equal(r.provider, name);
    assert.equal(r.ai_generated, true);
    assert.equal(p.calls, 1, 'fixed deterministically, no retry request');
    assert.equal(r.draft.body, `${S1} ${S2}`);
    assert.match(r.log.join(' | '), new RegExp(`${name}: ok after trimming the body to whole sentences \\(attempt 1\\)`));
  }
});

test('safety net never fixes a long headline: retry, then the template', async () => {
  const p = fake('groq', [LONG_HEADLINE, LONG_HEADLINE]);
  const r = await summarizeWithChain(input, [p], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(p.calls, 2);
  assert.equal(r.provider, 'template');
  assert.doesNotMatch(r.log.join(' | '), /trimming/);
});

test('trimmed draft is re-validated: a remaining problem (copied text) still rejects it', async () => {
  const src = `${S1} ${S2}`;                             // the kept sentences are copied verbatim from the source
  const p = fake('gemini', [LONG_BODY, LONG_BODY]);
  const r = await summarizeWithChain({ item: gopro, text: src }, [p], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(r.provider, 'template');
  assert.match(r.log.join(' | '), /trimmed body still rejected: copies \d+ consecutive words/);
});
