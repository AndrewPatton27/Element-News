// Candidate selection (config.selection): the run's budget goes to the best candidates across all sources,
// not to whichever source runs first. Offline: fixture feeds, fake summarizer, no network, no keys.
import './helpers/fixtureWindows.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { DRY_NOW, fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps, type SourceName } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { baseScore, pickNext, softCap } from '../src/selection.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import type { RawItem, Summarizer } from '../src/types.ts';

/**
 * Fixture feeds with the dates arranged for the scenario: Federal Register rules are routine and a week old
 * (published 10-11..10-12), Wikipedia stories are all from today (Oct 17). Fetcher is otherwise the dry-run one.
 */
function scenarioFetcher(): Deps['fetchText'] {
  const base = fixtureFetcher();
  return async (url, kind, ttl) => {
    const t = await base(url, kind, ttl);
    if (url.includes('federalregister.gov')) return t.replace(/"publication_date":\s*"2026-10-1[3-7]"/g, '"publication_date":"2026-10-12"');
    if (url.includes('wikipedia.org')) return t.replace(/<!--Oct \d\d-->/g, '<!--Oct 17-->');
    return t;
  };
}

/** Run `only` sources with a budget; returns the source of every AI call, in call order. */
async function run(only: SourceName[], limit: number, selection?: boolean) {
  const calls: string[] = [];
  const ai: Summarizer = {
    name: 'gemini', usesAi: true, model: 'm',
    async summarize(i) {
      calls.push(i.item.source);
      return { headline: 'A short plain news card', body: null, category: 'policy', event_type: null, tickers: [], everyday_relevance: 4 };
    },
  };
  const lines: string[] = [];
  const dry = createDryRunPublisher();
  const deps: Deps = {
    fetchText: scenarioFetcher(), publisher: dry.publisher, providers: [ai], counter: memoryCounter(), fredApiKey: null,
    now: DRY_NOW, log: (l) => lines.push(l), selection: { enabled: selection },
  };
  const stats = await runOnce(deps, { only, limit });
  return { calls, lines, stats };
}
const count = (calls: string[], s: string) => calls.filter((c) => c === s).length;

test('config: selection is on by default with weights, soft cap share and a half-life', () => {
  assert.equal(config.selection.enabled, true);
  assert.ok(config.selection.softCapShare > 0 && config.selection.softCapShare < 1);
  assert.ok(config.selection.weights.importance > 0 && config.selection.freshnessHalfLifeHours > 0);
});

test('a big story from a late source beats routine filings from an early one (budget 3)', async () => {
  const on = await run(['fedreg', 'wiki'], 3);
  assert.equal(on.calls.length, 3);
  assert.equal(on.calls[0], 'wiki_itn', 'the highest-scored candidate is spent first');
  assert.ok(count(on.calls, 'wiki_itn') >= 2, `wiki got ${count(on.calls, 'wiki_itn')} of 3`);
});

test('flag off restores the old order: the early source uses the budget first', async () => {
  const off = await run(['fedreg', 'wiki'], 3, false);
  assert.deepEqual(off.calls, ['fedreg', 'fedreg', 'fedreg']);
  assert.ok(!off.lines.some((l) => l.startsWith('selection:')));
});

test('no source exceeds its soft cap while others still have candidates', async () => {
  const limit = 5;
  const cap = softCap(limit);
  assert.equal(cap, 2);
  const r = await run(['fedreg', 'wiki', 'cpsc'], limit);
  assert.equal(r.calls.length, limit);
  for (const s of new Set(r.calls)) assert.ok(count(r.calls, s) <= cap, `${s} took ${count(r.calls, s)}`);
  assert.equal(new Set(r.calls).size, 3, 'all three sources share the budget');
});

test('leftover budget is reused: when the capped sources run out of candidates the cap is lifted', async () => {
  const all = await run(['fedreg', 'wiki'], 100);
  const total = all.calls.length;
  assert.ok(total >= 6, 'fixtures give enough candidates');
  const limit = total;     // cap = 40% of this, but one source holds more than that many candidates
  const r = await run(['fedreg', 'wiki'], limit);
  assert.equal(r.calls.length, limit, 'the whole budget is spent');
  assert.ok(Math.max(count(r.calls, 'fedreg'), count(r.calls, 'wiki_itn')) > softCap(limit), 'one source went past the cap once the other had nothing left');
});

test('pickNext: scores decide, the diversity penalty and the cap spread picks, ties keep the earlier candidate', () => {
  const cfg = config.selection;
  const c = [{ source: 'a', score: 3 }, { source: 'b', score: 3 }, { source: 'b', score: 5 }];
  assert.equal(pickNext(c, new Map(), 5), 2);
  assert.equal(pickNext(c.slice(0, 2), new Map(), 5), 0, 'tie: earlier first');
  assert.equal(pickNext(c, new Map([['b', 5]]), 5), 0, 'b is at its cap while a has candidates');
  assert.equal(pickNext([{ source: 'b', score: 1 }], new Map([['b', 9]]), 5), 0, 'cap lifted when nothing else is left');
  assert.equal(pickNext([], new Map(), 5), -1);
  assert.ok(cfg.weights.diversity > 0);
});

test('baseScore: a recall or Fed release outranks a routine document; older items score lower', () => {
  const mk = (event_type: string | null, kind: RawItem['source_kind'], hoursAgo: number): RawItem => ({
    source: 'fedreg', external_id: 'x', url: 'https://x.test/', title: 'Rule', published_at: new Date(DRY_NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    license_class: 'public_domain', category: 'policy', event_type, tickers: [], source_name: 'S', source_kind: kind, doc_label: 'd', summary_text: 't',
  });
  assert.ok(baseScore(mk('fed', 'government', 1), DRY_NOW) > baseScore(mk(null, 'government', 1), DRY_NOW));
  assert.ok(baseScore(mk(null, 'government', 1), DRY_NOW) > baseScore(mk(null, 'government', 72), DRY_NOW));
});
