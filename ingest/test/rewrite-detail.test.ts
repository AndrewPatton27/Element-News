// --rewrite (redo older cards in place) and the in-depth detail (D-37).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { templateDetail } from '../src/detail.ts';
import { DRY_NOW, fixtureFetcher, parseArgs } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { currentVersions, runRewrite } from '../src/rewrite.ts';
import { buildDataCard, buildObservation } from '../src/sources/macro.ts';
import { parseUsgsGeoJson, usgsToItem } from '../src/sources/usgs.ts';
import { memoryCounter, summarizeWithChain } from '../src/summarizer/chain.ts';
import { buildPrompt, RESPONSE_SCHEMA } from '../src/summarizer/gemini.ts';
import { GROQ_JSON_SCHEMA } from '../src/summarizer/groq.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import type { RawItem, RevisableCard, Summarizer, SummaryDraft } from '../src/types.ts';
import { checkDetailShape, validateDetail } from '../src/validate.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const CARDS = (JSON.parse(fx('rewrite-cards.json')) as { cards: RevisableCard[] }).cards;   // SYNTHETIC
const byId = (n: number) => CARDS.find((c) => c.id.endsWith(String(n).padStart(12, '0')))!;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const DETAIL = {
  paragraphs: ['The Federal Reserve posted a statement after its meeting.', 'The Fed is the U.S. central bank. It sets key interest rates.'],
  key_points: ['The Fed posted a statement', 'The Fed is the central bank', 'Full text is linked'],
};

function rewriteDeps(cards: RevisableCard[], providers: Summarizer[], fetchOverride?: (url: string) => string | null) {
  const dry = createDryRunPublisher(cards);
  const lines: string[] = [];
  const requests: { url: string; kind: string }[] = [];
  const base = fixtureFetcher();
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => {
      requests.push({ url, kind });
      const o = fetchOverride?.(url);
      return o ?? base(url, kind, ttl);
    },
    publisher: dry.publisher, providers, counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: (s) => lines.push(s),
  };
  return { deps, dry, lines, requests };
}

const ai = (draft: Partial<SummaryDraft>, calls: string[] = []): Summarizer => ({
  name: 'gemini', usesAi: true, model: 'gemini-test',
  async summarize(i) {
    calls.push(i.text);
    return { headline: 'The Fed shares a new statement', body: 'The Federal Reserve posted a statement.', category: 'policy', event_type: 'fed', tickers: [], everyday_relevance: 4, detail: DETAIL, ...draft } as SummaryDraft;
  },
});

// ---- selection ---------------------------------------------------------------------------

test('--rewrite: CLI flag; current versions are sum-v6 and tpl-v5; only older cards are selected', async () => {
  assert.equal(parseArgs(['--rewrite', '--limit', '5']).rewrite, true);
  assert.deepEqual(currentVersions(), ['sum-v6', 'tpl-v5']);
  const fresh = [{ ...byId(1), id: 'a', prompt_version: 'sum-v6' }, { ...byId(3), id: 'b', prompt_version: 'tpl-v5' }];
  const r = rewriteDeps([...fresh, byId(3)], [templateSummarizer]);
  const s = await runRewrite(r.deps, { limit: 10 });
  assert.equal(s.selected, 1, 'only the old data card');
  assert.deepEqual(r.dry.revisions.map((x) => x.id), [byId(3).id]);
  const lim = rewriteDeps(CARDS, [templateSummarizer]);
  assert.equal((await runRewrite(lim.deps, { limit: 2 })).selected, 2, '--limit caps the cards');
});

// ---- in-place update -------------------------------------------------------------------------

test('AI card: same licensed text (allowlisted page fetch), same chain; updated in place with detail, sum-v6', async () => {
  const calls: string[] = [];
  const r = rewriteDeps([byId(1)], [ai({}, calls), templateSummarizer]);
  const s = await runRewrite(r.deps);
  assert.equal(s.revised, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('Federal Reserve issues FOMC statement'), 'feed title + page text');
  assert.deepEqual(r.requests.map((x) => `${x.kind} ${new URL(x.url).hostname}`), ['page www.federalreserve.gov']);
  const [p] = r.dry.revisions;
  assert.equal(p.action, 'revise');
  if (p.action !== 'revise') return;
  assert.equal(p.id, byId(1).id, 'same card id');
  assert.equal(p.headline, 'The Fed shares a new statement');
  assert.equal(p.ai_generated, true);
  assert.equal(p.prompt_version, 'sum-v6');
  assert.deepEqual(p.detail, DETAIL);
  assert.ok(!('sort_at' in p) && !('category' in p), 'order and category are never sent');
});

test('template and data cards: regenerated with the plain templates (no AI) plus a factual detail', async () => {
  let aiCalls = 0;
  const spy: Summarizer = { name: 'gemini', usesAi: true, async summarize() { aiCalls++; throw new Error('no'); } };
  const fedTemplate = { ...byId(1), id: 'fed-template', ai_generated: false, prompt_version: null };
  const r = rewriteDeps([fedTemplate, byId(3)], [spy, templateSummarizer]);
  const s = await runRewrite(r.deps);
  assert.equal(aiCalls, 0);
  assert.equal(s.revised, 2);
  const [sec, data] = r.dry.revisions;
  assert.ok(sec.action === 'revise' && data.action === 'revise');
  if (sec.action !== 'revise' || data.action !== 'revise') return;
  assert.equal(sec.headline, 'Federal Reserve issues FOMC statement');
  assert.equal(sec.prompt_version, 'tpl-v5');
  assert.match(sec.detail!.paragraphs[1], /central bank/);
  assert.equal(data.body, 'The 10-year Treasury yield, a rate that many mortgage and loan rates follow, was 5.10% on Oct 16, up 0.06 points from the prior day.');
  assert.match(data.detail!.paragraphs[0], /up 0\.06 points from the prior day, when it was 5\.04%/);
  for (const d of [sec.detail!, data.detail!]) assert.deepEqual(checkDetailShape(d), []);
});

test('earnings template card (Apple 2.02, no figures) is hidden by --rewrite, not kept', async () => {
  const r = rewriteDeps([byId(2)], [templateSummarizer]);
  const s = await runRewrite(r.deps);
  assert.equal(s.hidden, 1);
  assert.equal(s.revised, 0);
  assert.deepEqual(r.dry.revisions, [{ id: byId(2).id, action: 'hide', note: 'no_figures' }]);
});
// ---- failure handling --------------------------------------------------------------------------

test('a draft that fails validation twice keeps the old card unchanged (no revise call)', async () => {
  const r = rewriteDeps([byId(1)], [ai({ body: 'Rates rose 9.9% today.' }), templateSummarizer]);
  const s = await runRewrite(r.deps);
  assert.equal(s.kept, 1);
  assert.equal(r.dry.revisions.length, 0);
  assert.ok(r.lines.some((l) => l.startsWith('kept (no valid AI draft; old card unchanged)') && /numbers not in source: 9\.9/.test(l)));
});

test('relevance below 3 hides the card instead of rewriting it', async () => {
  const r = rewriteDeps([byId(1)], [ai({ everyday_relevance: 2 }), templateSummarizer]);
  const s = await runRewrite(r.deps);
  assert.equal(s.hidden, 1);
  assert.deepEqual(r.dry.revisions, [{ id: byId(1).id, action: 'hide', note: 'low_relevance (2)' }]);
});

test('a source that cannot be re-read fails safely (old card unchanged); unsupported sources are kept', async () => {
  const r = rewriteDeps([byId(4), { ...byId(1), id: 'w', item: { ...byId(1).item!, source: 'wiki_itn' } }], [ai({})]);
  const s = await runRewrite(r.deps);
  assert.equal(s.failed, 1, 'Federal Register document fetch failed');
  assert.equal(s.kept, 1, 'wiki card not supported');
  assert.equal(r.dry.revisions.length, 0);
  assert.ok(r.requests.some((x) => x.url.startsWith('https://www.federalregister.gov/api/v1/documents/2026-20000.json?') && x.kind === 'api'));
});

test('only the detail fails -> the card is rewritten with detail null', async () => {
  const bad = { paragraphs: ['The Fed raised rates by 7 points.', 'It met on a Tuesday.'], key_points: ['a', 'b', 'c'] };
  const r = rewriteDeps([byId(1)], [ai({ detail: bad })]);
  await runRewrite(r.deps);
  const [p] = r.dry.revisions;
  assert.ok(p.action === 'revise' && p.detail === null);
  assert.ok(r.lines.some((l) => l.includes('no detail')));
});

// ---- detail rules ---------------------------------------------------------------------------------

test('detail shape: 2-4 paragraphs, <= 180 words, 3-5 key points of <= 15 words', () => {
  assert.deepEqual(checkDetailShape(DETAIL), []);
  assert.match(checkDetailShape({ ...DETAIL, paragraphs: ['one'] }).join(), /2-4 paragraphs/);
  assert.match(checkDetailShape({ ...DETAIL, paragraphs: ['word '.repeat(100), 'word '.repeat(90)] }).join(), /longer than 180 words/);
  assert.match(checkDetailShape({ ...DETAIL, key_points: ['a', 'b', 'c', 'd', 'e', 'f'] }).join(), /3-5 key points/);
  assert.match(checkDetailShape({ ...DETAIL, key_points: ['a', 'b', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'] }).join(), /key point longer than 15 words/);
  assert.match(checkDetailShape(null).join(), /not an object/);
});

test('detail validation: advice words, numbers not in source, copy limit per license (Wikipedia 10)', () => {
  const src = { text: 'The Houthis launch a series of attacks on Saudi Arabian airports, including King Khalid International Airport.', licenseClass: 'cc_by_sa' };
  const ok = { paragraphs: ['Houthi fighters attacked airports in Saudi Arabia.', 'One target was King Khalid International Airport.'], key_points: ['Attacks on Saudi airports', 'Houthis carried them out', 'A major airport was hit'] };
  assert.deepEqual(validateDetail(ok, src).errors, []);
  assert.match(validateDetail({ ...ok, key_points: ['You should avoid travel', 'b', 'c'] }, src).errors.join(), /advice language: should/);
  assert.match(validateDetail({ ...ok, paragraphs: ['At least 40 people were hurt.', 'x y.'] }, src).errors.join(), /numbers not in source: 40/);
  const copied = { ...ok, paragraphs: ['The Houthis launch a series of attacks on Saudi Arabian airports, including King Khalid.', 'x y.'] };
  assert.match(validateDetail(copied, src).errors.join(), /copies \d+ consecutive words .*limit 10/);
});

test('chain: a valid card with a bad detail keeps the card and drops the detail', async () => {
  const it = { source: 'fed_rss', license_class: 'public_domain', tickers: [], items: [] } as unknown as RawItem;
  const p = ai({ detail: { paragraphs: ['Only one.'], key_points: [] } });
  const r = await summarizeWithChain({ item: it, text: 'The Federal Reserve posted a statement.' }, [p], memoryCounter());
  assert.equal(r.provider, 'gemini');
  assert.equal(r.draft.detail, null);
  assert.ok(r.log.some((l) => /detail dropped \(card kept\)/.test(l)));
});

test('prompt sum-v6 asks for the detail; Gemini and Groq schemas require it', () => {
  assert.equal(config.promptVersion, 'sum-v6');
  const it = { source: 'fed_rss', source_name: 'Federal Reserve Board', doc_label: 'Press release', published_at: '2026-10-17T00:00:00Z', tickers: [], category: 'policy', event_type: 'fed' } as unknown as RawItem;
  const p = buildPrompt({ item: it, text: 'T' });
  assert.match(p, /"detail": a longer, still easy version for readers who tap the card/);
  assert.match(p, /2 to 4 short paragraphs, at most 180 words in total/);
  assert.match(p, /3 to 5 short points, each at most 15 words/);
  assert.match(p, /what it means for regular people ONLY if that follows from the source/);
  assert.ok(RESPONSE_SCHEMA.required.includes('detail'));
  assert.ok(GROQ_JSON_SCHEMA.schema.required.includes('detail'));
  assert.deepEqual(GROQ_JSON_SCHEMA.schema.properties.detail.required, ['paragraphs', 'key_points']);
});

test('new cards: AI detail goes into the publish payload; template and data cards get a factual detail', async () => {
  const dry = createDryRunPublisher();
  const deps: Deps = {
    fetchText: fixtureFetcher(), publisher: dry.publisher, providers: [ai({ headline: 'The Fed posts a statement' }), templateSummarizer],
    counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: () => {},
  };
  await runOnce(deps, { only: ['fed', 'usgs'] });
  const fed = dry.cards.find((c) => c.sources[0].name === 'Federal Reserve Board')!;
  assert.deepEqual(fed.detail, DETAIL);
  const quakes = dry.cards.filter((c) => c.category === 'science');
  assert.equal(quakes.length, 2, 'only the quakes above the publishing threshold');
  for (const q of quakes) {
    assert.deepEqual(checkDetailShape(q.detail), [], q.headline);
    assert.equal(q.prompt_version, 'tpl-v5');
  }
  const it = (usgsToItem(parseUsgsGeoJson(fx('usgs-significant-week.geojson'))[0], DRY_NOW) as { item: RawItem }).item;
  assert.deepEqual(templateDetail(it)!.key_points, ['Magnitude 5.7', 'Location: 48 km WNW of Khuzdar, Pakistan', 'Time: 05:06 UTC on Oct 17', 'USGS alert level: yellow']);
  const obs = buildObservation('UNRATE', [{ date: '2026-08-01', value: 4.1 }, { date: '2026-09-01', value: 4.2 }])!;
  const card = buildDataCard(obs)!;
  assert.deepEqual(checkDetailShape(card.detail), []);
  assert.match(card.detail!.paragraphs.join(' '), /when it was 4\.1%/);
  assert.match(card.detail!.paragraphs[1], /the share of people who want a job but can't find one/);
  assert.ok(card.detail!.key_points.every((k) => words(k) <= 15));
});
