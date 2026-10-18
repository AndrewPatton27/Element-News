import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeWithChain, memoryCounter, fileCounter } from '../src/summarizer/chain.ts';
import { templateDraft } from '../src/summarizer/template.ts';
import { buildPrompt, createGeminiSummarizer, RateLimitedError } from '../src/summarizer/gemini.ts';
import { parseSec8kAtom, secEntryToItem, parseTickerExchangeJson } from '../src/sources/sec.ts';
import { fedItemToItem, parseRss } from '../src/sources/fed.ts';
import { NotSummarizableError, validateDraft } from '../src/validate.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';
import type { FetchLike } from '../src/allowlist.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
const gopro = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], tickers)!;
const costco = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-5.02.atom.xml'))[0], tickers)!;
const fedItem = fedItemToItem(parseRss(fx('fed-press-monetary.rss.xml'))[0]);

const GOOD: SummaryDraft = {
  headline: 'GoPro files results of operations for the quarter',
  body: 'GoPro filed its results with the SEC on 2026-10-16. The filing also covers Item 4.02.',
  category: 'earnings', event_type: 'earnings', tickers: ['GPRO'],
};

function fake(name: string, outputs: (SummaryDraft | Error)[]): Summarizer & { calls: number } {
  const s = {
    name, usesAi: true, calls: 0,
    async summarize() {
      const o = outputs[Math.min(s.calls, outputs.length - 1)];
      s.calls++;
      if (o instanceof Error) throw o;
      return o;
    },
  };
  return s;
}

test('template cards pass the validator (SEC 5.02, Fed); the 2.02 template card has no figures and fails no_figures', () => {
  const g = templateDraft({ item: gopro, text: '' });
  const gv = validateDraft(g, { text: gopro.summary_text, licenseClass: gopro.license_class, tickers: ['GPRO'], requireFigures: true });
  assert.equal(gv.ok, false);
  assert.match(gv.errors.join(), /no_figures/);
  for (const item of [costco, fedItem]) {
    const d = templateDraft({ item, text: item.summary_text });
    const v = validateDraft(d, { text: item.summary_text, licenseClass: item.license_class, tickers: item.tickers.map((t) => t.symbol) });
    assert.deepEqual(v.errors, [], d.headline);
    assert.ok(d.headline.length <= 90);
  }
  assert.equal(templateDraft({ item: gopro, text: '' }).headline, 'GoPro, Inc. shares its latest financial results');
  assert.equal(templateDraft({ item: gopro, text: '' }).body,
    'GoPro, Inc. sent the SEC a report on its latest results, like sales and profit. Open the filing to see the numbers.');
  assert.equal(templateDraft({ item: costco, text: '' }).headline, 'Costco Wholesale Corp reports a change in its top leaders');
});

test('license gate: link_out / dev_only text never reaches any provider', async () => {
  const p = fake('gemini', [GOOD]);
  for (const lc of ['link_out', 'dev_only', 'guardian_noncomm']) {
    const item = { ...gopro, license_class: lc } as unknown as RawItem;
    await assert.rejects(summarizeWithChain({ item, text: 'x' }, [p], memoryCounter()), NotSummarizableError);
  }
  assert.equal(p.calls, 0);
});

test('valid AI draft is used and counted', async () => {
  const p = fake('gemini', [GOOD]);
  const c = memoryCounter();
  const r = await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [p], c);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.ai_generated, true);
  assert.equal(c.used('gemini'), 1);
});

test('invented number: one retry with the errors, then template card', async () => {
  const bad = { ...GOOD, body: 'GoPro revenue rose 14% to $800 million.' };
  const seen: (string[] | undefined)[] = [];
  const p: Summarizer = { name: 'gemini', usesAi: true, async summarize(i) { seen.push(i.retryErrors); return bad; } };
  const r = await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [p], memoryCounter());
  assert.equal(r.provider, 'template');
  assert.equal(r.ai_generated, false);
  assert.equal(seen.length, 2);
  assert.match(seen[1]!.join(), /numbers not in source: 14, 800/);
  console.log('  chain log:', r.log.join(' | '));
});

test('retry fixes it: second attempt accepted', async () => {
  const p = fake('gemini', [{ ...GOOD, body: 'Profit tripled to 900.' }, GOOD]);
  const r = await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [p], memoryCounter());
  assert.equal(r.provider, 'gemini');
  assert.equal(p.calls, 2);
});

test('429 moves to the next provider; daily cap skips a provider', async () => {
  const limited = fake('gemini', [new RateLimitedError('gemini')]);
  const backup = fake('groq', [GOOD]);
  const r = await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [limited, backup], memoryCounter());
  assert.equal(r.provider, 'groq');

  const c = memoryCounter();
  for (let i = 0; i < 3; i++) c.add('gemini');
  const capped = fake('gemini', [GOOD]);
  const r2 = await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [capped], c, { cap: 3 });
  assert.equal(capped.calls, 0);
  assert.equal(r2.provider, 'template');
  assert.match(r2.log.join(), /daily cap 3 reached/);
});

test('file counter persists per day and resets on a new day', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ingest-')), 'usage.json');
  let day = '2026-10-17';
  const c = fileCounter(path, () => day);
  c.add('gemini'); c.add('gemini');
  assert.equal(fileCounter(path, () => day).used('gemini'), 2);
  day = '2026-10-18';
  assert.equal(c.used('gemini'), 0);
});

test('Gemini adapter: key in header (not URL), JSON mode, parses the reply', async () => {
  let sentUrl = '', sentHeaders: Record<string, string> = {}, sentBody: any;
  const impl: FetchLike = async (url, init) => {
    sentUrl = url; sentHeaders = init.headers as Record<string, string>; sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] }), { status: 200 });
  };
  const g = createGeminiSummarizer({ apiKey: 'test-key-not-real', fetchImpl: impl });
  const d = await g.summarize({ item: gopro, text: gopro.summary_text });
  assert.deepEqual(d, GOOD);
  assert.equal(sentUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.doesNotMatch(sentUrl, /test-key/);
  assert.equal(sentHeaders['x-goog-api-key'], 'test-key-not-real');
  assert.equal(sentBody.generationConfig.responseMimeType, 'application/json');
  assert.match(sentBody.contents[0].parts[0].text, /SOURCE TEXT:\nGoPro, Inc\. Form 8-K/);
});

test('Gemini adapter: HTTP 429 -> RateLimitedError', async () => {
  const g = createGeminiSummarizer({ apiKey: 'k', fetchImpl: async () => new Response('{}', { status: 429 }) });
  await assert.rejects(g.summarize({ item: gopro, text: 'x' }), RateLimitedError);
});

test('prompt includes the rules and the retry errors', () => {
  const p = buildPrompt({ item: gopro, text: 'T', retryErrors: ['numbers not in source: 9'] });
  assert.match(p, /Every number you write must appear in the source text/);
  assert.match(p, /rejected for: numbers not in source: 9/);
  assert.match(p, /TICKERS: GPRO \(GoPro, Inc\.\)/);
});

test('prompt: plain headline and body rules (lead with what happened; no over-specific details; precise details only in detail.key_points)', () => {
  const p = buildPrompt({ item: gopro, text: 'T' });
  // headline leads with what happened
  assert.match(p, /headline must say WHAT HAPPENED in plain words/i);
  // no over-specific details in headline AND body
  assert.match(p, /OUT of the headline AND the body/);
  assert.match(p, /no exact distances, compass bearings, coordinates, exact clock times, docket, item or section numbers, model numbers, or long official titles/i);
  // precise details only in detail.key_points
  assert.match(p, /belong ONLY in "detail"\.key_points, never in the headline or the body/);
  // about 60 characters target still present
  assert.match(p, /aim for about 60/);
});

// A product-recall item (category 'safety'), like the ones CPSC produces.
const recall = { ...gopro, source: 'cpsc', category: 'safety', event_type: 'recall', tickers: [] } as unknown as RawItem;

test('safety-card prompt tells the AI to give a direct instruction and avoid "should"', () => {
  const p = buildPrompt({ item: recall, text: 'Acme recalls heaters.' });
  assert.match(p, /PRODUCT-SAFETY RECALL/);
  assert.match(p, /do NOT use the word "should"/i);
  assert.match(p, /Stop using it and contact the company for a refund/);
});

test('a non-safety prompt does not add the recall instruction block', () => {
  const p = buildPrompt({ item: gopro, text: 'T' });
  assert.doesNotMatch(p, /PRODUCT-SAFETY RECALL/);
});

test('detail prompt asks for paraphrase, source-only numbers and under the copy limit', () => {
  const p = buildPrompt({ item: gopro, text: 'T' });
  // paraphrase in the model's own words, not copy
  assert.match(p, /your OWN plain words/i);
  assert.match(p, /never copy a phrase of more than 8 words in a row/i);
  // numbers only from the source
  assert.match(p, /Use ONLY numbers that appear in the source text exactly/i);
  assert.match(p, /if a number is not in the source, leave it out/i);
});

test('AI calls are spaced by minIntervalMs (free-tier requests-per-minute limit)', async () => {
  const times: number[] = [];
  const p: Summarizer = { name: 'gemini', usesAi: true, async summarize() { times.push(Date.now()); return GOOD; } };
  await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [p], memoryCounter(), { minIntervalMs: 80 });
  await summarizeWithChain({ item: gopro, text: gopro.summary_text }, [p], memoryCounter(), { minIntervalMs: 80 });
  assert.ok(times[1]! - times[0]! >= 75, `gap was ${times[1]! - times[0]!} ms`);
});
