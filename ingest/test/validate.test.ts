import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSummarizable, extractNumbers, longestCopiedRun, NotSummarizableError, parseDraft,
  validateDraft, validatePublish, type Draft,
} from '../src/validate.ts';

// A short synthetic 8-K style source text (fictional company).
const FILING = `Item 2.02 Results of Operations and Financial Condition.
On October 16, 2026, Northwind Corp issued a press release announcing results for the
third quarter ended September 30, 2026. Revenue was $4.1 billion, an increase of 12%
compared with the prior-year quarter. The company raised its full-year revenue outlook
citing stronger demand from logistics customers across North America and Europe. Ticker NWND.`;

const good: Draft = {
  headline: 'Northwind Corp revenue rises 12% to $4.1 billion, outlook raised',
  body: 'Northwind Corp said third-quarter revenue grew 12% from a year earlier to $4.1 billion. It lifted its full-year forecast, pointing to demand from logistics customers.',
  category: 'earnings',
  event_type: 'earnings',
  tickers: ['NWND'],
};

const src = { text: FILING, licenseClass: 'company_filing', tickers: ['NWND'] };

test('a faithful draft passes', () => {
  const r = validateDraft(good, src);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('validator rejects an invented number', () => {
  const r = validateDraft({ ...good, body: 'Revenue grew 12% to $4.1 billion and profit doubled to $900 million.' }, src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /numbers not in source: 900/);
  console.log('  validator output (invented number):', r.errors.join('; '));
});

test('validator rejects advice language', () => {
  const r = validateDraft({ ...good, body: 'Revenue grew 12%. Investors should consider adding shares; analysts see a price target upside.' }, src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /advice language: should, price target/);
  console.log('  validator output (advice):', r.errors.join('; '));
});

// ---- safety-card advice relaxation (CPSC recalls) -------------------------------------------------
// A recall card's real category is 'safety' (set in code; carried on source.category). Plain
// safety instructions that use "should" are allowed there, but investment advice never is.
const recallSrc = {
  text: 'Acme is recalling about 10,000 space heaters because they can overheat and catch fire. '
    + 'Consumers should stop using the product and contact the company for a full refund.',
  licenseClass: 'public_domain',
  category: 'safety',
};
// The AI draft category is always one of the 9 business slugs; the safety signal is source.category.
const recallDraft: Draft = {
  headline: 'Acme recalls space heaters that can catch fire',
  body: 'Acme is recalling about 10,000 space heaters that can overheat and catch fire. Consumers should stop using them and contact the company for a refund.',
  category: 'tech',
  event_type: null,
  tickers: [],
};

test('"should" in a safety card is allowed', () => {
  const r = validateDraft(recallDraft, recallSrc);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('buy/sell advice in a safety card is still rejected', () => {
  const r = validateDraft(
    { ...recallDraft, body: 'Acme is recalling space heaters. Buy and sell the shares before the news spreads.' },
    recallSrc,
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /advice language:.*\bbuy\b/);
  assert.match(r.errors.join('; '), /\bsell\b/);
  console.log('  validator output (safety card, investment advice):', r.errors.join('; '));
});

test('"should" in a non-safety card is still rejected', () => {
  // same wording, but the source carries no safety category (a normal filing)
  const r = validateDraft({ ...recallDraft, category: 'tech' }, { ...recallSrc, category: 'tech' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /advice language: should/);
});

test('validator rejects a ticker that is not in the source', () => {
  const r = validateDraft({ ...good, tickers: ['NWND', 'ZZZQ'] }, src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /ticker not in source: ZZZQ/);
});

test('copy limit: more than 10 consecutive words from a filing is rejected', () => {
  // 14 words: the tokenizer splits "full-year" into two
  const copied = 'The company raised its full-year revenue outlook citing stronger demand from logistics customers.';
  const r = validateDraft({ ...good, body: copied }, src);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /copies 14 consecutive words from the source \(limit 10\)/);
  console.log('  validator output (copy limit):', r.errors.join('; '));
});

test('copy limit: an 8-K item title quoted verbatim does not count', () => {
  const run = longestCopiedRun(
    'Filed under Results of Operations and Financial Condition today',
    FILING,
    ['Results of Operations and Financial Condition'],
  );
  assert.ok(run <= 2, `run was ${run}`);
});

test('copy limit for public-domain Fed text: 25 words pass, 26 fail', () => {
  const fedWords = Array.from({ length: 40 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i < 26 ? '' : 'x'}`);
  const fedText = fedWords.join(' ');
  const fed = { text: fedText, licenseClass: 'public_domain' };
  const d25 = { ...good, headline: 'Fed statement', tickers: [], category: 'policy', event_type: 'fed', body: fedWords.slice(0, 25).join(' ') };
  const d26 = { ...d25, body: fedWords.slice(0, 26).join(' ') };
  assert.equal(longestCopiedRun(d25.body, fedText), 25);
  assert.equal(validateDraft(d25, fed).ok, true, validateDraft(d25, fed).errors.join('; '));
  const r26 = validateDraft(d26, fed);
  assert.equal(r26.ok, false);
  assert.match(r26.errors.join('; '), /copies 26 consecutive words .*limit 25/);
});

test('numbers inside a copied run do not count toward the limit', () => {
  // 10 counted words + 2 numbers = allowed for a filing
  const t = 'alpha beta 12 gamma delta epsilon 4.1 zeta eta theta iota kappa';
  assert.equal(longestCopiedRun(t, t), 10);
});

test('form names are not treated as numbers', () => {
  assert.deepEqual(extractNumbers('Northwind filed an 8-K and a 10-Q; revenue was $4,100 million'), ['4100']);
});

test('bad JSON and wrong shapes are rejected', () => {
  assert.deepEqual(parseDraft('{"headline": "x"').errors, ['output is not valid JSON']);
  assert.ok(parseDraft('[1,2]').errors.length > 0);
  const long = parseDraft(JSON.stringify({ ...good, headline: 'x'.repeat(91) }));
  assert.match(long.errors.join(), /headline longer than 90/);
  const wordy = parseDraft(JSON.stringify({ ...good, body: Array(61).fill('word').join(' ') }));
  assert.match(wordy.errors.join(), /body longer than 60 words/);
  const cat = parseDraft(JSON.stringify({ ...good, category: 'crypto' }));
  assert.match(cat.errors.join(), /category/);
  assert.deepEqual(parseDraft(JSON.stringify(good)).errors, []);
});

test('only public-domain and filing text may reach the AI', () => {
  assert.doesNotThrow(() => assertSummarizable('public_domain'));
  assert.doesNotThrow(() => assertSummarizable('company_filing'));
  for (const lc of ['link_out', 'dev_only', 'guardian_noncomm', 'iex_hist', '']) {
    assert.throws(() => assertSummarizable(lc), NotSummarizableError, lc);
  }
});

test('publish check: missing source link, dev_only and link_out are rejected', () => {
  assert.match(validatePublish({ kind: 'summary', ai_generated: true, sources: [] }).errors.join(), /at least one source/);
  const dev = validatePublish({ kind: 'summary', ai_generated: false, sources: [{ name: 'X', kind: 'news', url: 'https://x.test/a', license_class: 'dev_only' }] });
  assert.match(dev.errors.join(), /dev_only/);
  const http = validatePublish({ kind: 'summary', ai_generated: false, sources: [{ name: 'SEC', kind: 'filing', url: 'http://www.sec.gov/a', license_class: 'company_filing' }] });
  assert.match(http.errors.join(), /https/);
  const lo = validatePublish({ kind: 'link_out', ai_generated: false, sources: [{ name: 'P', kind: 'news', url: 'https://p.test/a', license_class: 'link_out' }] });
  assert.match(lo.errors.join(), /link_out/);
  const ok = validatePublish({ kind: 'summary', ai_generated: true, sources: [{ name: 'SEC', kind: 'filing', url: 'https://www.sec.gov/a', license_class: 'company_filing' }] });
  assert.deepEqual(ok.errors, []);
});
