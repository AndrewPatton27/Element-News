// Offline tests for the brief-summary handler: fake brief, fake text models, memory usage store, fake RPCs.
// Run: npm run test:functions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleBriefSummary, parseBriefOptions } from './handler.ts';
import { memoryUsageStore } from '../_shared/usage.ts';
import { readFunctionEnv } from '../_shared/env.ts';
import type { BriefInput, TextModel } from '../_shared/ingest.ts';

const env = readFunctionEnv((k) => ({ SUPABASE_URL: 'https://mzfpelilxpbpcgskppxu.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJ-test-service-role-key' } as Record<string, string>)[k]);
const feed = JSON.parse(readFileSync(new URL('../../../contract/fixtures/feed.page1.json', import.meta.url), 'utf8')) as { items: BriefInput['headline_cards'] };
const brief = (summary: BriefInput['summary'] = null): BriefInput => ({
  generated_at: '2026-10-19T10:30:00Z', headline_cards: feed.items.slice(0, 3), sections: [], numbers: [], summary,
} as unknown as BriefInput);
const NOW = Date.parse('2026-10-19T10:30:00Z');

function setup(o: { models?: TextModel[]; usage?: Record<string, number>; existing?: BriefInput['summary'] } = {}) {
  const puts: Array<{ kind: string; forDate: string; model: string }> = [];
  const logged: unknown[] = [];
  const store = memoryUsageStore(o.usage);
  return {
    puts, logged, store,
    deps: {
      env, models: o.models ?? [], usageStore: store, now: () => NOW,
      rpc: async <T>(name: string, body: unknown): Promise<T> => { if (name === 'log_run') logged.push(body); return 1 as T; },
      fetchBrief: async () => brief(o.existing ?? null),
      putSummary: async (kind: string, forDate: string, _t: string, model: string) => { puts.push({ kind, forDate, model }); },
    },
  };
}

test('options: kind daily|weekly|both (default both)', () => {
  assert.deepEqual(parseBriefOptions({}).kinds, ['daily', 'weekly']);
  assert.deepEqual(parseBriefOptions({ kind: 'daily', force: 'true' }), { kinds: ['daily'], force: true, dryRun: false, noAi: false });
  assert.throws(() => parseBriefOptions({ kind: 'monthly' }), /kind/);
});

test('rejected AI drafts: two counted calls, then the template is stored; run log written', async () => {
  let n = 0;
  const gemini: TextModel = { name: 'gemini', model: 'gemini-x', dailyCap: 500, generate: async () => { n++; return 'Too short.'; } };
  const s = setup({ models: [gemini] });
  const r = await handleBriefSummary(s.deps, parseBriefOptions({ kind: 'daily' }));
  assert.equal(r.ok, true);
  assert.equal(n, 2);
  assert.equal(r.ai_calls, 2);
  assert.equal(s.store.counts.gemini, 2);
  assert.deepEqual(s.puts, [{ kind: 'daily', forDate: '2026-10-19', model: 'template' }]);
  assert.equal(r.outcomes[0].status, 'written');
  assert.equal((s.logged[0] as { p: { source: string; published: number } }).p.source, 'brief-summary');
  assert.equal((s.logged[0] as { p: { published: number } }).p.published, 1);
});

test('Gemini at its database cap: not called, Groq is next', async () => {
  let g = 0, q = 0;
  const gemini: TextModel = { name: 'gemini', model: 'g', dailyCap: 500, generate: async () => { g++; return ''; } };
  const groq: TextModel = { name: 'groq', model: 'q', dailyCap: 74, generate: async () => { q++; throw Object.assign(new Error('429'), { name: 'RateLimitedError' }); } };
  const s = setup({ models: [gemini, groq], usage: { gemini: 500 } });
  const r = await handleBriefSummary(s.deps, parseBriefOptions({ kind: 'daily' }));
  assert.deepEqual([g, q], [0, 1]);
  assert.equal(s.store.counts.groq, 1);
  assert.equal(r.outcomes[0].model, 'template');
});

test('once per period: an existing summary for today is skipped (no AI call, nothing written)', async () => {
  let n = 0;
  const gemini: TextModel = { name: 'gemini', model: 'g', dailyCap: 500, generate: async () => { n++; return ''; } };
  const s = setup({ models: [gemini], existing: { text: 'x', generated_at: '2026-10-19T10:00:00Z', model: 'g' } });
  const r = await handleBriefSummary(s.deps, parseBriefOptions({ kind: 'daily' }));
  assert.equal(n, 0);
  assert.equal(s.puts.length, 0);
  assert.equal(r.outcomes[0].status, 'exists');
});

test('dry run: generates but writes neither the summary nor the run log', async () => {
  const s = setup();
  const r = await handleBriefSummary(s.deps, parseBriefOptions({ kind: 'both', dry_run: true }));
  assert.deepEqual(r.outcomes.map((o) => o.status), ['dry_run', 'dry_run']);
  assert.equal(s.puts.length, 0);
  assert.equal(s.logged.length, 0);
});

test('a failing brief read is reported in the result and the run log', async () => {
  const s = setup();
  const r = await handleBriefSummary({ ...s.deps, fetchBrief: async () => { throw new Error('rpc daily_brief: HTTP 500'); } }, parseBriefOptions({ kind: 'daily' }));
  assert.equal(r.ok, false);
  assert.match(r.run.error ?? '', /HTTP 500/);
  assert.equal(s.logged.length, 1);
});
