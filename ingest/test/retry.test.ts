// Report-card failures leave an item retryable (status 'new', counter in status_note) and skip it only after
// config.reportCard.maxRetries failures. Offline: fixtures, fake writer, fake scorer, a publisher that remembers item status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher, type Publisher } from '../src/publish.ts';
import { decideReportCardRetry, reportCardFailures } from '../src/retry.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { Summarizer } from '../src/types.ts';

test('the cap is 3 and the counter note is bounded', () => {
  assert.equal(config.reportCard.maxRetries, 3);
  assert.equal(reportCardFailures(null), 0);
  assert.equal(reportCardFailures('low_relevance (2)'), 0);
  assert.equal(reportCardFailures('report_card_retry:2:report_card_abandon'), 2);
  let note: string | null = null;
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = decideReportCardRetry(note, 'report_card_revise_failed');
    seen.push(`${d.status}:${d.note}`);
    note = d.note;
    if (d.status === 'skipped') break;
  }
  assert.deepEqual(seen, ['new:report_card_retry:1:report_card_revise_failed', 'new:report_card_retry:2:report_card_revise_failed', 'skipped:report_card_revise_failed']);
  assert.ok(seen.every((x) => x.length < 80), 'the note never grows');
  assert.equal(decideReportCardRetry('report_card_retry:999:x', 'c').status, 'skipped');
  assert.equal(decideReportCardRetry('report_card_retry:1:x', 'c', 5).status, 'new');
});

const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const abandonAll = { async generate(prompt: string) {
  const cards = prompt.slice(prompt.lastIndexOf('CARDS '), prompt.lastIndexOf('RECENT '));
  const id = /"id":"([^"]+)"/.exec(cards)![1]!;
  return JSON.stringify({ scores: [{ id, topic_fit: false, matched_topic: 'x', scores: { headline: 2, summary: 2, trust: 2, importance: 2 }, relation: 'NEW', related_id: null, reason: 'off topic', recommendations: [] }] });
} };

function world() {
  const dry = createDryRunPublisher();
  const state = new Map<string, { id: string; status: string; note: string | null }>();
  const writes: string[] = [];
  const publisher: Publisher = {
    ...dry.publisher,
    async upsertItem(item) {
      let r = state.get(item.url);
      const is_new = !r;
      if (!r) { r = { id: `it-${state.size + 1}`, status: 'new', note: null }; state.set(item.url, r); }
      return { id: r.id, is_new, status: r.status, status_note: r.note };
    },
    async setItemStatus(id, status, note) {
      writes.push(`${status}:${note}`);
      for (const r of state.values()) if (r.id === id) { r.status = status; r.note = note; }
    },
    async auditCards() { return []; },
  };
  let n = 0;
  const writer: Summarizer = {
    name: 'gemini', usesAi: true, model: 'fake-writer',
    async summarize() { return { headline: `A short plain news card ${NAMES[n++ % NAMES.length]}`, body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 }; },
  };
  let scored = 0;
  const scorer = { async generate(p: string) { scored++; return abandonAll.generate(p); } };
  const deps: Deps = { fetchText: fixtureFetcher(), publisher, providers: [writer], counter: memoryCounter(), fredApiKey: null, now: DRY_NOW, log: () => {}, reportCard: { enabled: true, scorer } };
  return { deps, dry, state, writes, scored: () => scored };
}

test('ABANDON keeps the item retryable twice, then skips it for good on failure 3; a skipped item is not tried again', async () => {
  const w = world();
  await runOnce(w.deps, { only: ['cpsc'], limit: 5 });
  const first = [...w.state.values()];
  assert.ok(first.length >= 1);
  assert.ok(first.every((r) => r.status === 'new' && r.note === 'report_card_retry:1:report_card_abandon'), JSON.stringify(first));
  await runOnce(w.deps, { only: ['cpsc'], limit: 5 });
  assert.ok([...w.state.values()].every((r) => r.status === 'new' && r.note === 'report_card_retry:2:report_card_abandon'), 'second run retried the same items');
  await runOnce(w.deps, { only: ['cpsc'], limit: 5 });
  assert.ok([...w.state.values()].every((r) => r.status === 'skipped' && r.note === 'report_card_abandon'), 'third failure is final');
  const finals = new Map([...w.state].map(([u, r]) => [u, { ...r }]));
  const before = w.scored(), had = w.state.size;
  await runOnce(w.deps, { only: ['cpsc'], limit: 5 });
  for (const [u, r] of finals) assert.deepEqual(w.state.get(u), r, 'a skipped item is left alone');
  assert.equal(w.scored() - before, w.state.size - had, 'only newly seen items were scored; skipped ones cost nothing');
  assert.equal(w.dry.cards.length, 0);
});
