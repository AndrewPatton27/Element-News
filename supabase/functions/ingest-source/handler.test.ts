// Offline tests for the ingest-source handler: the real pipeline on the ingest fixtures (no network,
// no keys), an in-memory publisher, the memory usage store and a fake run-log RPC.
// Run: npm run test:functions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleIngestSource, parseIngestOptions, DEFAULT_WORK_CAP, defaultWorkCapFor } from './handler.ts';
import { createTimeBudget } from '../_shared/budget.ts';
import { memoryUsageStore } from '../_shared/usage.ts';
import { describeFunctionEnv, readFunctionEnv } from '../_shared/env.ts';
import { readFileSync } from 'node:fs';
import { createDryRunPublisher, templateSummarizer, type Summarizer } from '../_shared/ingest.ts';
import { DRY_NOW, fixtureFetcher } from '../../../ingest/src/main.ts';

const env = readFunctionEnv((k) => ({
  SUPABASE_URL: 'https://mzfpelilxpbpcgskppxu.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJ-test-service-role-key', SEC_USER_AGENT: 'Element test@test.org',
} as Record<string, string>)[k]);

function setup(o: { tick?: number; providers?: Summarizer[]; usage?: Record<string, number> } = {}) {
  let t = 0;
  const now = () => t;
  const dry = createDryRunPublisher();
  const pub = { ...dry.publisher, upsertItem: async (x: Parameters<typeof dry.publisher.upsertItem>[0]) => { t += o.tick ?? 0; return dry.publisher.upsertItem(x); } };
  const logged: unknown[] = [];
  const rpc = async <T>(name: string, body: unknown): Promise<T> => { if (name === 'log_run') logged.push(body); return 1 as T; };
  const store = memoryUsageStore(o.usage);
  return {
    dry, logged, store,
    deps: {
      env, fetchText: fixtureFetcher(), publisher: pub, providers: o.providers ?? [templateSummarizer], rpc, usageStore: store,
      budget: createTimeBudget({ now }), now, clock: () => DRY_NOW,
    },
  };
}

test('options: sec gets the higher default work cap (config.workCapBySource); an explicit work_cap still wins; others stay at the default', () => {
  assert.equal(defaultWorkCapFor('sec'), 10);
  assert.equal(parseIngestOptions({ source: 'sec' }).workCap, 10);
  assert.equal(parseIngestOptions({ source: 'sec', work_cap: 4 }).workCap, 4);
  assert.equal(parseIngestOptions({ source: 'cpsc' }).workCap, DEFAULT_WORK_CAP);
  assert.ok(defaultWorkCapFor('sec') <= 20);
});

test('options: source must be known; work_cap 1-20, default 5', () => {
  assert.deepEqual(parseIngestOptions({ source: 'fed' }), { source: 'fed', workCap: DEFAULT_WORK_CAP, finish: false });
  assert.equal(parseIngestOptions({ source: 'nasa', work_cap: '3', finish: 'true' }).workCap, 3);
  for (const s of ['treasury', 'fedspeech', 'secpress', 'bls', 'beadata']) assert.equal(parseIngestOptions({ source: s }).source, s);   // finance sources (2026-11-08)
  assert.throws(() => parseIngestOptions({ source: 'guardian' }), /source must be one of/);
  assert.throws(() => parseIngestOptions({}), /source must be one of/);
  assert.throws(() => parseIngestOptions({ source: 'sec', work_cap: 0 }), /work_cap/);
  assert.throws(() => parseIngestOptions({ source: 'sec', work_cap: 21 }), /work_cap/);
});

test('fed from fixtures: template cards published, one run-log row with the counts', async () => {
  const s = setup();
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'fed' }));
  assert.equal(run.ok, true, run.error ?? '');
  assert.equal(run.source, 'fed');
  assert.ok(run.published >= 1, `published ${run.published}`);
  assert.equal(run.published, s.dry.cards.length);
  assert.ok(run.items_new <= DEFAULT_WORK_CAP);
  assert.equal(run.ai_calls, 0);
  assert.equal(s.logged.length, 1);
  const row = (s.logged[0] as { p: Record<string, unknown> }).p;
  assert.equal(row.source, 'fed');
  assert.equal(row.published, run.published);
  assert.ok(!JSON.stringify(row).includes('eyJ-test-service-role-key'), 'no key in the run log');
});

test('work cap: at most N new items per call; the rest are left unrecorded for the next run', async () => {
  const s = setup();
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'cpsc', work_cap: 2 }));
  assert.equal(run.items_new, 2);
  assert.equal(s.dry.items.length, 2, 'only two items recorded');
  // The pipeline's own run limit (limit = work cap) or the guard stops it, whichever comes first.
  assert.ok(['done', 'work_cap'].includes(run.stopped_by));
});

test('time budget: no new item is started after the soft deadline', async () => {
  const s = setup({ tick: 60_000 });             // every recorded item "takes" 60 s
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'cpsc', work_cap: 20 }));
  assert.equal(s.dry.items.length, 2, 'items started at 0 s and 60 s only');
  assert.ok(run.deferred > 0);
  assert.equal(run.stopped_by, 'time');
  assert.ok(run.duration_ms <= 160_000);
});

test('database cap reached: the AI provider is never called, template cards still allowed for Fed', async () => {
  let calls = 0;
  const gemini: Summarizer = { name: 'gemini', usesAi: true, model: 'g', dailyCap: 500, minIntervalMs: 0, summarize: async () => { calls++; throw new Error('no'); } };
  const s = setup({ providers: [gemini, templateSummarizer], usage: { gemini: 500 } });
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'fed', work_cap: 2 }));
  assert.equal(calls, 0);
  assert.equal(run.ai_calls, 0);
  assert.equal(s.store.counts.gemini, 500);
  assert.ok(run.log_tail.some((l) => /\[template\]/.test(l)));
});

test('AI calls are counted in the database store per real call', async () => {
  let calls = 0;
  const gemini: Summarizer = { name: 'gemini', usesAi: true, model: 'g', dailyCap: 500, minIntervalMs: 0, summarize: async () => { calls++; throw Object.assign(new Error('provider down'), { name: 'ProviderError' }); } };
  const s = setup({ providers: [gemini, templateSummarizer] });
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'fed', work_cap: 2 }));
  assert.equal(run.ai_calls, calls);
  assert.equal(s.store.counts.gemini ?? 0, calls);
});

test('a source error is reported, not thrown, and still logged', async () => {
  const s = setup();
  const deps = { ...s.deps, fetchText: undefined, env: { ...env, secUserAgent: null } };
  const run = await handleIngestSource(deps, parseIngestOptions({ source: 'sec' }));
  assert.equal(run.ok, false);
  assert.match(run.error ?? '', /SEC_USER_AGENT/);
  assert.equal(s.logged.length, 1);
});

test('finish: refreshes Trending and purges ML rows after the source', async () => {
  const s = setup();
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'usgs', finish: true }));
  assert.equal(s.dry.trending.refreshes, 1);
  assert.equal(s.dry.trending.mlPurges, 1);
  assert.ok(run.log_tail.some((l) => l.startsWith('trending refreshed')));
});

test('candidate selection stays off in the cloud, so the deadline guard sees every item start', async () => {
  const s = setup({ tick: 60_000 });
  const run = await handleIngestSource(s.deps, parseIngestOptions({ source: 'bea', work_cap: 20 }));
  assert.ok(!run.log_tail.some((l) => l.startsWith('selection:')), 'no selection log lines');
  assert.equal(run.stopped_by, 'time');
});

// ---- NewsData.io link-out source (OFF by default; needs NEWSDATA_API_KEY and NEWSDATA_ENABLED=1) -------------------

test('options: newsdata_market and newsdata_latest are known sources', () => {
  for (const s of ['newsdata_market', 'newsdata_latest']) assert.equal(parseIngestOptions({ source: s, work_cap: 10 }).source, s);
});

test('newsdata: no key or switch off = no request, no credit used, no card; the run still logs', async () => {
  for (const e of [env, { ...env, newsdataApiKey: 'pub_k', newsdataEnabled: false }, { ...env, newsdataApiKey: null, newsdataEnabled: true }]) {
    const s = setup();
    let fetched = 0;
    const run = await handleIngestSource({ ...s.deps, env: e, fetchText: async () => { fetched++; return '{}'; } }, parseIngestOptions({ source: 'newsdata_market', work_cap: 10 }));
    assert.equal(run.ok, true, run.error ?? '');
    assert.equal(fetched, 0);
    assert.equal(s.dry.cards.length, 0);
    assert.equal(s.store.counts.newsdata ?? 0, 0);
    assert.equal(s.logged.length, 1);
  }
});

test('newsdata on: one database credit per call, credits are not counted as AI calls, key never in the log; D-296: with no AI summarizer no link_out card is published', async () => {
  const body = readFileSync(new URL('../../../ingest/test/fixtures/newsdata-market.json', import.meta.url), 'utf8');
  const e = { ...env, newsdataApiKey: 'pub_SECRETKEY123456', newsdataEnabled: true };
  const s = setup();
  const run = await handleIngestSource({ ...s.deps, env: e, fetchText: async () => body, clock: () => new Date('2026-11-11T08:00:00Z') }, parseIngestOptions({ source: 'newsdata_market', work_cap: 10 }));
  assert.equal(run.ok, true, run.error ?? '');
  assert.equal(s.store.counts.newsdata, 1);
  assert.equal(run.ai_calls, 0);
  // D-296: a link-out card needs an AI summary from the publisher page; this run has no AI provider, so nothing is published
  assert.equal(s.dry.cards.length, 0);
  assert.ok(!JSON.stringify([s.logged, run, s.dry.cards]).includes('SECRETKEY'));
});

test('newsdata credit cap 144: at the cap the database refuses, so no request is made', async () => {
  const e = { ...env, newsdataApiKey: 'pub_SECRETKEY123456', newsdataEnabled: true };
  const s = setup({ usage: { newsdata: 144 } });
  s.store.counts.newsdata = 144;
  const caps = { newsdata: { cap: 144, reserve: 0 } };
  const store = memoryUsageStore({ newsdata: 144 }, caps);
  let fetched = 0;
  await handleIngestSource({ ...s.deps, env: e, usageStore: store, fetchText: async () => { fetched++; return '{}'; } }, parseIngestOptions({ source: 'newsdata_latest' }));
  assert.equal(fetched, 0);
  assert.equal(store.counts.newsdata, 144);
});

test('env: NEWSDATA_API_KEY and NEWSDATA_ENABLED are read; default is off and keys never print', () => {
  const base = (k: string) => ({ SUPABASE_URL: 'https://mzfpelilxpbpcgskppxu.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJ-test-service-role-key', NEWSDATA_API_KEY: 'pub_SECRETKEY123456', NEWSDATA_ENABLED: '1' } as Record<string, string>)[k];
  const on = readFunctionEnv(base);
  assert.equal(on.newsdataApiKey, 'pub_SECRETKEY123456');
  assert.equal(on.newsdataEnabled, true);
  assert.equal(readFunctionEnv((k) => (k === 'NEWSDATA_ENABLED' ? undefined : base(k))).newsdataEnabled, null, 'unset = the code default (on)');
  assert.equal(readFunctionEnv((k) => (k === 'NEWSDATA_ENABLED' ? '0' : base(k))).newsdataEnabled, false, '0 switches it off')
  assert.equal(env.newsdataApiKey, null);
  assert.ok(!describeFunctionEnv(on).includes('SECRETKEY'));
});
