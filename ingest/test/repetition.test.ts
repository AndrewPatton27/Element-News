// Flow and no repetition (Drew, D-58): the first summary sentence continues from the headline, and
// no two sentences say the same thing. Offline; no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { checkRepetition, validateDraft, type Draft } from '../src/validate.ts';
import { summarizeWithChain, memoryCounter } from '../src/summarizer/chain.ts';
import { buildPrompt } from '../src/summarizer/gemini.ts';
import { templateDraft } from '../src/summarizer/template.ts';
import { parseSec8kAtom, secEntryToItem, parseTickerExchangeJson } from '../src/sources/sec.ts';
import { fedItemToItem, parseRss } from '../src/sources/fed.ts';
import type { RawItem, Summarizer, SummaryDraft } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const tickers = parseTickerExchangeJson(fx('sec-company-tickers-exchange.json'));
const gopro = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'))[0], tickers)!;
const costco = secEntryToItem(parseSec8kAtom(fx('sec-8k-item-5.02.atom.xml'))[0], tickers)!;
const fedItem = fedItemToItem(parseRss(fx('fed-press-monetary.rss.xml'))[0]);

const IRS_SOURCE = `The Internal Revenue Service announced that taxpayers can now pay their federal taxes directly with a debit or credit card,
without going through a third-party service. The change takes effect next year. The agency said the option is meant to make paying easier.`;
const src = { text: IRS_SOURCE, licenseClass: 'public_domain', checkFlow: true };

const irs = (body: string): SummaryDraft & Draft => ({
  headline: 'IRS lets people pay taxes by card',
  body,
  category: 'policy',
  event_type: null,
  tickers: [],
});

const BAD_BODY = 'The IRS now lets people pay taxes by card. The change takes effect next year.';
const GOOD_BODY = 'Taxpayers can use a debit or credit card directly, without a third-party service. The change takes effect next year.';

test('IRS bad example: the first sentence restates the headline -> rejected with a clear reason', () => {
  const r = validateDraft(irs(BAD_BODY), src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /repetition: the first summary sentence repeats the headline \(100% of its key words, limit 70%\)/);
  console.log('  validator output (IRS bad example):', r.errors.join('; '));
});

test('IRS good example: the summary continues the headline -> passes', () => {
  const r = validateDraft(irs(GOOD_BODY), src);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('a first sentence that starts with the headline text is rejected', () => {
  const e = checkRepetition('Fed holds rates steady', 'Fed holds rates steady as inflation cools. Prices rose less last month.');
  assert.match(e.join(), /starts with the headline/);
});

test('two near-duplicate summary sentences are rejected', () => {
  const body = 'Taxpayers can use a debit or credit card directly, without a third-party service. '
    + 'People can pay with a credit or debit card directly, with no third-party service.';
  const r = validateDraft(irs(body), src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /repetition: summary sentences 1 and 2 say nearly the same thing/);
  console.log('  validator output (near-duplicate sentences):', r.errors.join('; '));
});

test('a second sentence that only re-words the first is rejected, a new fact is not', () => {
  const h = 'Costco names a new finance chief';
  assert.match(
    checkRepetition(h, 'The retailer appointed Jane Roe as its chief financial officer. Jane Roe was appointed chief financial officer by the retailer.').join(),
    /sentences 1 and 2/,
  );
  assert.deepEqual(
    checkRepetition(h, 'Jane Roe, a longtime executive at the retailer, takes over on January 5. The previous finance chief is retiring after a decade in the role.'),
    [],
  );
});

test('short headlines and short sentences are not compared by overlap (too little to judge)', () => {
  assert.deepEqual(checkRepetition('Rates fall', 'Rates fall for the first time in a year. Borrowing gets cheaper.'), []);
  assert.deepEqual(checkRepetition('Rates fall', 'Rates fall.'), []);
  assert.deepEqual(checkRepetition('Rates fall', null), []);
  // but a 3-word headline that is simply said again is caught
  assert.match(checkRepetition('Fed cuts rates', 'The Fed cut rates by a quarter point. Borrowing gets cheaper.').join(), /repeats the headline/);
});

test('normal cards still pass: a first sentence may reuse the company and the topic word', () => {
  assert.deepEqual(checkRepetition(
    'Northwind revenue rises 12% to $4.1 billion',
    'Northwind Corp said third-quarter revenue grew from a year earlier, helped by demand from logistics customers. It also raised its full-year forecast.',
  ), []);
  assert.deepEqual(checkRepetition(
    'Magnitude 5.7 earthquake hits western Pakistan',
    'The U.S. Geological Survey rated the expected damage as moderate. Such quakes can topple weak buildings in nearby towns.',
  ), []);
});

test('template and data cards are exempt: the chain never sets checkFlow for them, and their fixed wording would fail it', () => {
  // The 5.02 template ("X reports a change in its top leaders" / "X told the SEC about a change among its top leaders")
  // restates its headline on purpose, so the check must stay AI-only.
  const d = templateDraft({ item: costco, text: '' });
  assert.match(checkRepetition(d.headline, d.body).join(), /repeats the headline/);
  const base = { text: costco.summary_text, licenseClass: costco.license_class, tickers: costco.tickers.map((t) => t.symbol) };
  assert.deepEqual(validateDraft(d, base).errors, [], 'exempt without checkFlow');
  assert.match(validateDraft(d, { ...base, checkFlow: true }).errors.join(), /repetition/, 'checked when checkFlow is set (AI path)');
  for (const item of [gopro, fedItem]) {
    const t = templateDraft({ item, text: '' });
    assert.deepEqual(validateDraft(t, { text: item.summary_text, licenseClass: item.license_class, tickers: item.tickers.map((x) => x.symbol) }).errors.filter((e) => /repetition/.test(e)), []);
  }
});

test('chain: the AI path sets checkFlow, the template fallback is not validated', async () => {
  const item = { ...costco } as RawItem;
  const p: Summarizer = { name: 'gemini', usesAi: true, async summarize() { return { ...templateDraft({ item, text: '' }), everyday_relevance: 4 }; } };
  const r = await summarizeWithChain({ item, text: costco.summary_text }, [p], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(r.provider, 'template');            // the AI draft restated its headline twice -> template fallback (exempt)
  assert.match(r.log.join('\n'), /gemini: rejected \(attempt 2\): repetition/);
  assert.equal(r.draft.headline, 'Costco Wholesale Corp reports a change in its top leaders');
});

test('chain: a repeating draft is retried once with the reason, then a clean one is used', async () => {
  const seen: (string[] | undefined)[] = [];
  const outputs: SummaryDraft[] = [
    { ...irs(BAD_BODY), everyday_relevance: 4 },
    { ...irs(GOOD_BODY), everyday_relevance: 4 },
  ];
  let calls = 0;
  const p: Summarizer = {
    name: 'gemini', usesAi: true,
    async summarize(input) { seen.push(input.retryErrors); return outputs[Math.min(calls++, 1)]; },
  };
  const item = { ...fedItem, license_class: 'public_domain', title: 'IRS card payments' } as RawItem;
  const r = await summarizeWithChain({ item, text: IRS_SOURCE }, [p], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(r.ai_generated, true);
  assert.equal(r.draft.body, GOOD_BODY);
  assert.equal(calls, 2);
  assert.match((seen[1] ?? []).join(), /repeats the headline/);
  assert.match(r.log.join('\n'), /rejected \(attempt 1\): repetition/);
});

test('chain: two repeating drafts fall back to the template card', async () => {
  const p: Summarizer = { name: 'gemini', usesAi: true, async summarize() { return { ...irs(BAD_BODY), everyday_relevance: 4 }; } };
  const item = { ...fedItem, license_class: 'public_domain' } as RawItem;
  const r = await summarizeWithChain({ item, text: IRS_SOURCE }, [p], memoryCounter(), { minIntervalMs: 0 });
  assert.equal(r.provider, 'template');
  assert.equal(r.ai_generated, false);
});

test('prompt (shared by Gemini and Groq): flow rules, bad/good example, retry hint; version sum-v6', () => {
  const prompt = buildPrompt({ item: gopro, text: 'SOURCE BODY' });
  assert.match(prompt, /FLOW AND NO REPETITION/);
  assert.match(prompt, /NEVER restate the headline/);
  assert.match(prompt, /Bad \(do not copy, example only\): headline "IRS lets people pay taxes by card"/);
  assert.match(prompt, /Good \(example only\)/);
  assert.match(prompt, /Every sentence adds something new/);
  assert.match(prompt, /No filler/);
  assert.match(prompt, /key_points add new facts and must NOT copy or reword the body sentences/);
  const retry = buildPrompt({ item: gopro, text: 'x', retryErrors: ['repetition: the first summary sentence repeats the headline'] });
  assert.match(retry, /first sentence adds a NEW fact/);
  assert.equal(config.promptVersion, 'sum-v6');
});
