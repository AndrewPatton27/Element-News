// Robust report-card scoring (2026-10-19): malformed scorer output of every kind, batching, prompt, retry hint, protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { normalizeScore, extractEntries, scoreCards, scoreAll, scoreBatchPrompt, reviewCard, decideFromScores } from '../src/reportCard.ts';
import { retryWaitMs } from '../src/summarizer/groq.ts';
import type { RevisableCard } from '../src/types.ts';

const card = (id: string): RevisableCard => ({ id, kind: 'summary', headline: 'Company expands factory', body: 'It adds jobs.', category: 'markets', event_type: null, ai_generated: true, prompt_version: null, tickers: [], macro: [], attribution: null, as_of: '2026-10-18T00:00:00Z', sort_at: '', dedupe_key: id, sources: [], item: null });
const good = (over: Record<string, unknown> = {}) => ({ topic_fit: true, matched_topic: 'markets', scores: { headline: 2, summary: 2, trust: 2, importance: 2, category: 2, necessary_info: 2, key_points: 2, concise: 2 }, relation: 'NEW', related_id: null, reason: 'fine', recommendations: [], ...over });

test('normalize: the relation in the decision field is ignored; the decision is recomputed from the scores', () => {
  const s = normalizeScore(good({ decision: 'RELATED', relation: undefined, related_id: 'old' }), { knownIds: new Set(['old']) });
  assert.equal(s.relation, 'RELATED');
  assert.equal(s.decision, 'PASS');
  assert.equal(normalizeScore(good({ decision: 'NEW' })).decision, 'PASS');
  assert.equal(normalizeScore(good({ decision: 'PASS', scores: { headline: 0, summary: 2, trust: 2, importance: 2 } })).decision, 'REVISE');
  assert.equal(normalizeScore(good({ decision: 'PASS', scores: { headline: 1, summary: 1, trust: 2, importance: 2 } })).decision, 'REVISE');
  assert.equal(normalizeScore(good({ decision: 'PASS', topic_fit: false })).decision, 'ABANDON');
  assert.equal(decideFromScores(true, 'DUPLICATE', { headline: 2 }), 'ABANDON');
});
test('normalize: coerces booleans, numeric strings, floats, out-of-range numbers, aliases and string recommendations', () => {
  const s = normalizeScore(good({ topic_fit: 'yes', scores: { headline: '2', summary: 1.6, trust: 5, importance: -3, necessary: 2, keypoints: '1' }, recommendations: 'Add the date', relation: ' update ', related_id: 'old' }), { knownIds: new Set(['old']) });
  assert.equal(s.topic_fit, true);
  assert.deepEqual(s.scores, { headline: 2, summary: 2, trust: 2, importance: 0, necessary_info: 2, key_points: 1 });
  assert.deepEqual(s.recommendations, ['Add the date']);
  assert.equal(s.relation, 'UPDATE');
});
test('normalize: a missing topic_fit is inferred, a missing score throws, junk is rejected', () => {
  assert.equal(normalizeScore(good({ topic_fit: undefined })).topic_fit, true);
  assert.equal(normalizeScore(good({ topic_fit: undefined, decision: 'ABANDON' })).decision, 'ABANDON');
  assert.throws(() => normalizeScore(good({ scores: { headline: 2 } })), /missing/);
  assert.throws(() => normalizeScore(good({ scores: { headline: 'x', summary: 2, trust: 2, importance: 2 } })), /headline/);
  for (const bad of [null, undefined, 'text', 42, [], true]) assert.throws(() => normalizeScore(bad));
});
test('normalize: unknown relation becomes NEW; relation to an unknown or own id is dropped; a hallucinated DUPLICATE does not hide a card', () => {
  assert.equal(normalizeScore(good({ relation: 'SIMILAR' })).relation, 'NEW');
  const dup = normalizeScore(good({ relation: 'DUPLICATE', related_id: 'ghost' }), { knownIds: new Set(['real']) });
  assert.equal(dup.relation, 'NEW'); assert.equal(dup.decision, 'PASS'); assert.equal(dup.related_id, null);
  assert.equal(normalizeScore(good({ relation: 'UPDATE', related_id: 'me' }), { knownIds: new Set(['me']), selfId: 'me' }).relation, 'NEW');
  assert.equal(normalizeScore(good({ relation: 'DUPLICATE', related_id: 'real' }), { knownIds: new Set(['real']) }).decision, 'ABANDON');
  assert.deepEqual(normalizeScore(good({ recommendations: [1, null, ' ok ', {}] })).recommendations, ['ok']);
});
test('extractEntries: object with scores, bare array, id-keyed object, single object and positional fallback', () => {
  const e = (id: string) => ({ id, ...good() });
  assert.equal((extractEntries({ scores: [e('b'), e('a')] }, ['a', 'b'])[0] as any).id, 'a');
  assert.equal((extractEntries([e('a'), e('b')], ['a', 'b'])[1] as any).id, 'b');
  assert.equal((extractEntries({ a: good(), b: good() }, ['a', 'b'])[1] as any).topic_fit, true);
  assert.ok(extractEntries(good(), ['a'])[0]);
  assert.ok(extractEntries({ cards: [good(), good()] }, ['a', 'b'])[1]);
  assert.deepEqual(extractEntries({ cards: [e('a')] }, ['a', 'b']), [e('a'), undefined]);
  assert.deepEqual(extractEntries('nope', ['a']), [undefined]);
});

const fake = (...replies: Array<string | Error>) => {
  const prompts: string[] = []; let i = 0;
  return { prompts, generate: async (p: string) => { prompts.push(p); const r = replies[Math.min(i++, replies.length - 1)]!; if (r instanceof Error) throw r; return r; } };
};
const entry = (id: string, over: Record<string, unknown> = {}) => ({ id, ...good(over) });

test('scoreCards: one bad entry does not stop the batch; every kind of malformed output yields errors, never a crash', async () => {
  const cards = [card('a'), card('b'), card('c')];
  const r = await scoreCards(fake(JSON.stringify({ scores: [entry('a'), entry('b', { scores: 'high' }), 'oops'] })), cards);
  assert.equal((r[0] as any).decision, 'PASS');
  assert.ok(r[1] instanceof Error);
  assert.ok(r[2] instanceof Error);
  const outputs = ['', 'not json at all', '[]', '{}', 'null', '"x"', '{"scores":"x"}', '{"scores":[null,null,null]}', '```json\n{"scores":[]}\n```', '{"scores":[{"id":"zzz"}]}', '<html>429</html>'];
  for (const o of outputs) {
    const rr = await scoreCards(fake(o), cards);
    assert.equal(rr.length, 3, o);
    assert.ok(rr.every((x) => x instanceof Error), `all unscored for ${JSON.stringify(o)}`);
  }
  const thrown = await scoreCards(fake(new Error('Groq HTTP 429')), cards);
  assert.ok(thrown.every((x) => x instanceof Error && /429/.test(x.message)));
  const fenced = await scoreCards(fake('```json\n' + JSON.stringify({ scores: [entry('a')] }) + '\n```'), [card('a')]);
  assert.equal((fenced[0] as any).decision, 'PASS');
});
test('scoreAll: batches of 3, a failing batch does not stop the next one', async () => {
  const cards = ['1', '2', '3', '4', '5'].map(card);
  const c = fake(JSON.stringify({ scores: ['1', '2', '3'].map((i) => entry(i)) }), new Error('boom'));
  const r = await scoreAll(c, cards, []);
  assert.equal(c.prompts.length, 2);
  assert.deepEqual(r.map((x) => (x instanceof Error ? 'err' : x.decision)), ['PASS', 'PASS', 'PASS', 'err', 'err']);
  assert.equal(config.reportCard.scoreBatchSize, 3);
});
test('prompt: contains the word JSON, is compact, excludes the batch cards from the comparison list', () => {
  const recent = [{ id: 'a', headline: 'Batch card A' }, { id: 'old1', headline: 'Older story one' }];
  const p = scoreBatchPrompt([card('a')], recent);
  assert.match(p, /json/i);
  const recentPart = p.slice(p.indexOf('RECENT '));
  assert.ok(recentPart.includes('Older story one'));
  assert.ok(!recentPart.includes('Batch card A'));
  assert.ok(p.length < 3500, `prompt is ${p.length} chars`);
});
test('retryWaitMs: honours the header and the "try again in" text, with a margin', () => {
  assert.equal(retryWaitMs({ text: '', retryAfterMs: 4000 }), 5000);
  assert.equal(retryWaitMs({ text: 'Rate limit reached. Please try again in 7.5s. Need more tokens?' }), 8500);
  assert.equal(retryWaitMs({ text: 'try again in 1m30s' }), 91000);
  assert.equal(retryWaitMs({ text: 'nothing' }), config.reportCard.scoreMinIntervalMs);
});

const payload = { headline: 'Company expands factory', body: 'It adds jobs.', category: 'markets' };
const meta = { id: 'n1', ai_generated: true, as_of: '2026-10-18T00:00:00Z', sources: [] as any };
const reply = (over: Record<string, unknown>) => JSON.stringify({ scores: [entry('n1', over)] });
test('reviewCard: PASS publishes; ABANDON and DUPLICATE do not; the scorer sees the card once', async () => {
  const rw = async () => { throw new Error('must not rewrite'); };
  const pass = await reviewCard({ client: fake(reply({})), card: meta, payload, recent: [], rewrite: rw });
  assert.equal(pass.verdict, 'publish'); assert.equal(pass.scoreCalls, 1);
  assert.equal((await reviewCard({ client: fake(reply({ topic_fit: false })), card: meta, payload, recent: [], rewrite: rw })).verdict, 'abandon');
  const dup = await reviewCard({ client: fake(reply({ relation: 'DUPLICATE', related_id: 'old' })), card: meta, payload, recent: [{ id: 'old', headline: 'Old' }], rewrite: rw });
  assert.equal(dup.verdict, 'duplicate');
});
test('reviewCard: REVISE gets exactly one rewrite with the recommendations, then is re-scored', async () => {
  const recsSeen: string[][] = [];
  const c = fake(reply({ scores: { headline: 0, summary: 2, trust: 2, importance: 2 }, recommendations: ['name the company'] }), reply({}));
  const r = await reviewCard({ client: c, card: meta, payload, recent: [], rewrite: async (recs) => { recsSeen.push(recs); return { ...payload, headline: 'Northwind adds 200 factory jobs' }; } });
  assert.equal(r.verdict, 'publish'); assert.equal(r.revised, true); assert.equal(r.scoreCalls, 2);
  assert.deepEqual(recsSeen, [['name the company']]);
  assert.equal(r.payload.headline, 'Northwind adds 200 factory jobs');
  assert.match(c.prompts[1]!, /Northwind adds 200/);
});
test('reviewCard: still REVISE after the one revision, rewrite error, or scorer failure never publishes and never throws', async () => {
  const rev = reply({ scores: { headline: 0, summary: 2, trust: 2, importance: 2 } });
  const still = await reviewCard({ client: fake(rev, rev), card: meta, payload, recent: [], rewrite: async () => payload });
  assert.equal(still.verdict, 'revise_failed'); assert.equal(still.scoreCalls, 2);
  const err = await reviewCard({ client: fake(rev), card: meta, payload, recent: [], rewrite: async () => { throw new Error('validator'); } });
  assert.equal(err.verdict, 'revise_failed'); assert.match(err.error!, /validator/);
  assert.equal((await reviewCard({ client: fake(new Error('Groq HTTP 429')), card: meta, payload, recent: [], rewrite: async () => payload })).verdict, 'unscored');
  assert.equal((await reviewCard({ client: fake('garbage'), card: meta, payload, recent: [], rewrite: async () => payload })).verdict, 'unscored');
  assert.equal((await reviewCard({ client: fake(rev, new Error('429')), card: meta, payload, recent: [], rewrite: async () => payload })).verdict, 'unscored');
});

test('the scorer prompt carries the format and editing check; providers are Gemini, Groq, template only', async () => {
  const p = scoreBatchPrompt([card('a')], []);
  assert.match(p, /FORMAT AND EDITING CHECK/);
  for (const w of ['headline', 'summary', 'category', 'key points']) assert.match(p, new RegExp(w, 'i'));
  const { buildProviders } = await import('../src/summarizer/providers.ts');
  process.env.INGEST_WRITER = 'codex';
  const { providers } = buildProviders({ geminiApiKey: 'g', groqApiKey: 'q' });
  delete process.env.INGEST_WRITER;
  assert.deepEqual(providers.map((x) => x.name), ['gemini', 'groq', 'template']);
});
