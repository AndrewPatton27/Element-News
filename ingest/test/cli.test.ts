import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { fixtureFetcher, parseArgs } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { createDryRunPublisher } from '../src/publish.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import { validatePublish } from '../src/validate.ts';
import type { Summarizer } from '../src/types.ts';

test('argument parsing', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, loop: false, only: [], limit: 20, json: false, rewrite: false, backfillMacro: false, weeks: 16 });
  assert.deepEqual(parseArgs(['--dry-run', '--only', 'sec,fed', '--limit', '3', '--json']), { dryRun: true, loop: false, only: ['sec', 'fed'], limit: 3, json: true, rewrite: false, backfillMacro: false, weeks: 16 });
  assert.deepEqual(parseArgs(['--only', 'bea']).only, ['bea']);
  assert.equal(parseArgs(['--loop']).loop, true);
  assert.throws(() => parseArgs(['--only', 'guardian']), /unknown source/);
  assert.throws(() => parseArgs(['--limit', 'x']), /whole number/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

function dryDeps(providers: Summarizer[] = [templateSummarizer]) {
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const requested: string[] = [];
  const fetchText = fixtureFetcher();
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => { requested.push(url); return fetchText(url, kind, ttl); },
    publisher: dry.publisher, providers, counter: memoryCounter(), fredApiKey: 'dry',
    now: new Date('2026-10-17T21:00:00Z'), log: (s) => lines.push(s),
  };
  return { deps, dry, lines, requested };
}

test('dry run end to end: 5 template cards (1 Fed, 2 BEA, 2 USGS), Federal Register, Wikipedia, CPSC and off-list SEC skipped, every card valid', async () => {
  const { deps, dry, lines, requested } = dryDeps();
  const stats = await runOnce(deps);
  assert.equal(stats.published, 5);
  assert.equal(stats.template, 5);
  assert.equal(dry.cards.filter((c) => c.sources[0].name === 'Federal Register').length, 0, 'no template Federal Register cards');
  assert.equal(lines.filter((l) => l.startsWith('skip template_not_allowed')).length, 15);   // 5 Federal Register, 4 Wikipedia (today only), 5 CPSC (new-only cap), 1 NASA (page 1 only)
  assert.equal(lines.filter((l) => l.startsWith('skip low_interest')).length, 3, 'green-alert quakes: 2 on the Mid-Atlantic Ridge, 1 small one in Panama');
  assert.ok(lines.includes('skip routine_5.02: Costco Wholesale Corp 8-K'), 'Costco bonus-criteria 5.02 is routine');
  assert.ok(lines.some((l) => /not candidates: not_watched 1/.test(l)), 'GoPro is not on the watch list');
  assert.ok(lines.some((line) => line.startsWith('sec: watch list 152 of 188 companies resolved')));
  assert.equal(stats.macro, 1);
  assert.equal(stats.failed, 0);
  for (const c of dry.cards) {
    assert.deepEqual(validatePublish(c).errors, [], c.headline);
    assert.equal(c.ai_generated, false);
  }
  assert.deepEqual(dry.cards.filter((c) => c.category !== 'science').map((c) => c.headline).sort(), [
    'Gross domestic product, 2nd quarter 2026 (third estimate)',
    "Minutes of the Board's discount rate meetings on August 17, September 9, and September…",
    'U.S. international trade in goods and services, August 2026',
  ]);
  // every request went to an allowlisted government host (data.sec.gov: per-company filing lists)
  for (const u of requested) {
    assert.match(new URL(u).hostname, /^(www\.sec\.gov|data\.sec\.gov|www\.federalreserve\.gov|api\.stlouisfed\.org|apps\.bea\.gov|www\.federalregister\.gov|en\.wikipedia\.org|www\.saferproducts\.gov|earthquake\.usgs\.gov|www\.nasa\.gov)$/, u);
  }
  assert.ok(lines.some((l) => l.includes('DGS10 5.09%')));
});

test('--only and --limit', async () => {
  const a = dryDeps();
  const s = await runOnce(a.deps, { only: ['bea'], limit: 1 });
  assert.equal(s.published, 1);
  assert.equal(s.macro, 0);
  assert.ok(a.lines.includes('limit reached'));
});

test('a second run over the same feed publishes nothing new', async () => {
  const a = dryDeps();
  await runOnce(a.deps, { only: ['bea'] });
  const again = await runOnce(a.deps, { only: ['bea'] });
  assert.equal(again.published, 0);
  assert.equal(again.duplicate, 2);
});

test('with an AI provider the pipeline publishes AI cards that passed validation (Apple 2.02 from the per-company list)', async () => {
  const ai: Summarizer = {
    name: 'gemini', usesAi: true,
    async summarize(i) {
      const c = i.item.company ?? 'The Fed';
      return { headline: `${c} shares new results`, body: i.item.company ? 'Revenue was $102.5 billion for the quarter.' : null, category: i.item.category, event_type: i.item.event_type, tickers: i.item.tickers.map((t) => t.symbol), everyday_relevance: 5 };
    },
  };
  const a = dryDeps([ai, templateSummarizer]);
  a.deps.now = new Date('2026-08-05T12:00:00Z');        // REAL Apple 8-K (Item 2.02) filed 2026-07-30
  const s = await runOnce(a.deps, { only: ['sec'] });
  assert.equal(s.ai, 1);
  assert.equal(s.published, 1);
  const [c] = a.dry.cards;
  assert.equal(c.headline, 'Apple Inc. shares new results');
  assert.deepEqual(c.tickers.map((t) => t.symbol), ['AAPL']);
  assert.equal(c.sources[0].url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/0000320193-26-000018-index.htm');
  assert.ok(a.dry.cards.every((x) => x.ai_generated && x.prompt_version === config.promptVersion));
  assert.ok(a.lines.some((l) => l.startsWith('published [gemini] Apple Inc. shares new results') && l.includes('relevance 5')));
});
