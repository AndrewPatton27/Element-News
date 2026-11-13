// D-296 retro pass: export link-out cards with page text, replay Haiku drafts through the normal checks, apply with revise_blurb.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDrafts, checkDrafts, exportCards, listFillable, type DraftFile } from '../src/linkoutFill.ts';
import type { Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { RevisableCard } from '../src/types.ts';

const paras = [
  'Federal Reserve officials left the benchmark interest rate unchanged on Wednesday, saying inflation has eased toward their target while hiring remains solid across most of the country.',
  'Chair remarks stressed that policymakers will watch incoming data on prices and wages before deciding whether any further change is warranted at upcoming meetings of the committee.',
  'Mortgage lenders and car dealers said borrowing costs for households are likely to stay near current levels for now, which keeps monthly payments for new loans roughly where they were.',
  'Economists surveyed ahead of the decision had expected no change, and bond markets barely moved after the statement was released to the public in the afternoon.',
];
const html = `<html><body><article>${paras.map((p) => `<p>${p}</p>`).join('')}</article></body></html>`;
const card = (id: string, over: Partial<RevisableCard> = {}): RevisableCard => ({
  id, kind: 'link_out', headline: 'Fed holds rates steady as inflation cools', body: null, category: 'economy', event_type: null, ai_generated: false,
  prompt_version: null, tickers: [], macro: [], attribution: 'via NewsData.io', as_of: '2026-11-11T08:00:00Z', sort_at: '2026-11-11T08:00:00Z', dedupe_key: `https://p.example.com/${id}`,
  sources: [{ name: 'Example Times', kind: 'news', doc_label: null, url: `https://p.example.com/${id}`, published_at: '2026-11-11T08:00:00Z', license_class: 'link_out', attribution: 'via NewsData.io', is_primary: true }],
  item: null, ...over,
});
function setup(cards: RevisableCard[], page: (u: string) => string | Error = () => html) {
  const dry = createDryRunPublisher(cards);
  const lines: string[] = [];
  const deps: Deps = {
    fetchText: async (u, kind) => { assert.equal(kind, 'publisher'); if (u.endsWith('/robots.txt')) throw new Error('HTTP 404'); const r = page(u); if (r instanceof Error) throw r; return r; },
    publisher: dry.publisher, providers: [], counter: memoryCounter(), fredApiKey: null, now: new Date('2026-11-12T00:00:00Z'), log: (l) => lines.push(l),
  };
  return { dry, deps, lines };
}
const good = 'The Federal Reserve left interest rates unchanged and said inflation has eased. Officials will wait for more data before changing course.';
const DETAIL = {
  paragraphs: ['Policymakers said they will watch incoming price and wage data before deciding on any further change.', 'Lenders and car dealers expect borrowing costs for households to stay near current levels for now.'],
  key_points: ['Officials kept the benchmark rate unchanged on Wednesday', 'Inflation has eased toward the target', 'Bond markets barely moved after the statement'],
};
const draftOf = (id: string, body: string, detail: typeof DETAIL | null = DETAIL): DraftFile => ({ id, draft: { headline: 'ignored', body, category: 'economy', event_type: null, tickers: [], everyday_relevance: 4, detail } });

test('list: only published link_out cards without a body; summary cards and already-filled cards are left alone', async () => {
  const s = setup([card('a'), card('b', { body: 'Already has one.' }), card('c', { kind: 'summary' as never })]);
  assert.deepEqual((await listFillable(s.deps)).map((c) => c.id), ['a']);
});

test('export: page text and a sum-v7 prompt per card; cards with no usable page are left headline-only', async () => {
  const s = setup([card('a'), card('b')], (u) => (u.endsWith('/b') ? '<html><body><p>Subscribe to read.</p></body></html>' : html));
  const r = await exportCards(s.deps);
  assert.deepEqual(r.cards.map((c) => c.id), ['a']);
  assert.equal(r.noText, 1);
  assert.match(r.cards[0].text, /interest rate unchanged/);
  assert.match(r.cards[0].prompt, /SOURCE TEXT/i);
});

test('check: a good draft passes; advice, invented figures, missing key points and an unknown id are rejected', async () => {
  const s = setup([card('a'), card('b'), card('c'), card('d')]);
  const { cards } = await exportCards(s.deps);
  const res = await checkDrafts(cards, [
    draftOf('a', good),
    draftOf('b', 'Buy this stock now, it will double.'),
    draftOf('c', 'The Federal Reserve cut rates by 75 basis points and inflation fell to 1.2%.'),
    draftOf('d', good, null),   // D-297: no key points, no card
    draftOf('zzz', good),
  ]);
  assert.deepEqual(res.map((r) => r.ok), [true, false, false, false, false]);
  assert.equal(res[0].payload?.action, 'revise');
  assert.equal((res[0].payload as { model: string }).model, 'claude-haiku-5-5');
  assert.equal((res[0].payload as { headline: string }).headline, 'Fed holds rates steady as inflation cools');   // verbatim, not the draft's
});

test('apply: dry run writes nothing; --apply revises the passing drafts and hides every other card without a summary', async () => {
  const s = setup([card('a'), card('b'), card('c')]);
  const { cards, allIds } = await exportCards(s.deps);
  const res = await checkDrafts(cards, [draftOf('a', good), draftOf('b', 'Buy this stock now, it will double.')]);   // c has no draft at all
  assert.equal(allIds.length, 3);
  assert.deepEqual(await applyDrafts(s.deps, res, { apply: false, allIds }), { revised: 1, hidden: 2, notFound: 0, skipped: 1 });
  assert.equal(s.dry.revisions.length, 0);
  assert.deepEqual(await applyDrafts(s.deps, res, { apply: true, allIds }), { revised: 1, hidden: 2, notFound: 0, skipped: 1 });
  assert.equal(s.dry.revisions.length, 3);
  const [rev, ...hid] = s.dry.revisions;
  assert.ok(rev.action === 'revise' && rev.id === 'a' && rev.ai_generated && rev.body === good && rev.headline === 'Fed holds rates steady as inflation cools');
  assert.deepEqual(hid.map((h) => [h.action, h.id]).sort(), [['hide', 'b'], ['hide', 'c']]);
});

test('export without allIds on apply never hides anything (revise-only mode)', async () => {
  const s = setup([card('a'), card('b')]);
  const { cards } = await exportCards(s.deps);
  const res = await checkDrafts(cards, [draftOf('a', good)]);
  assert.deepEqual(await applyDrafts(s.deps, res, { apply: true }), { revised: 1, hidden: 0, notFound: 0, skipped: 0 });
});
