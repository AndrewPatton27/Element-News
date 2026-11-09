// Watchdog hardening in the Edge Function layer (offline): start rows, the 140 s run deadline, reserve
// calls for the Brief, daily-quota 429 -> exhaust, model_missing in the run summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleIngestSource, parseIngestOptions } from '../ingest-source/handler.ts';
import { handleBriefSummary, parseBriefOptions } from '../brief-summary/handler.ts';
import { createTimeBudget, withDeadline, DeadlineError } from './budget.ts';
import { createUsageTracker, memoryUsageStore, textModelWithUsage, withUsage, CapReachedError } from './usage.ts';
import { readFunctionEnv } from './env.ts';
import { buildRunSummary, runLogPayload, startRunLog } from './runSummary.ts';
import { createDryRunPublisher, templateSummarizer, type TextModel } from './ingest.ts';
import { RateLimitedError } from '../../../ingest/src/summarizer/gemini.ts';
import { DRY_NOW, fixtureFetcher } from '../../../ingest/src/main.ts';

const env = readFunctionEnv((k) => ({
  SUPABASE_URL: 'https://mzfpelilxpbpcgskppxu.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJ-test-service-role-key', SEC_USER_AGENT: 'Element test@test.org',
} as Record<string, string>)[k]);

function rpcRecorder(startId: number | 'fail' = 42) {
  const calls: Array<{ name: string; body: any }> = [];
  const rpc = async <T>(name: string, body: unknown): Promise<T> => {
    calls.push({ name, body });
    if (name === 'run_start') { if (startId === 'fail') throw new Error('rpc run_start: HTTP 404'); return startId as T; }
    return 1 as T;
  };
  return { calls, rpc };
}

test('start row: run_start is called first, log_run finishes the same id', async () => {
  const r = rpcRecorder(42);
  const dry = createDryRunPublisher();
  const run = await handleIngestSource({
    env, fetchText: fixtureFetcher(), publisher: dry.publisher, providers: [templateSummarizer], rpc: r.rpc,
    usageStore: memoryUsageStore(), clock: () => DRY_NOW,
  }, parseIngestOptions({ source: 'fed' }));
  assert.equal(run.ok, true, run.error ?? '');
  assert.deepEqual(r.calls.map((c) => c.name), ['run_start', 'log_run']);
  assert.equal(r.calls[0]!.body.p.source, 'fed');
  assert.equal(r.calls[1]!.body.p.id, 42);
});

test('start row failure never stops the run: log_run then inserts a whole row (no id)', async () => {
  const r = rpcRecorder('fail');
  const dry = createDryRunPublisher();
  const run = await handleIngestSource({
    env, fetchText: fixtureFetcher(), publisher: dry.publisher, providers: [templateSummarizer], rpc: r.rpc,
    usageStore: memoryUsageStore(), clock: () => DRY_NOW,
  }, parseIngestOptions({ source: 'fed' }));
  assert.equal(run.ok, true);
  assert.equal(r.calls.at(-1)!.name, 'log_run');
  assert.equal('id' in r.calls.at(-1)!.body.p, false);
  assert.equal(await startRunLog(async () => 'nope', 'fed', 0), null);
});

test('deadline: a fetch that never returns ends the run at the hard deadline with stopped_by "timeout" and a log row', async () => {
  const r = rpcRecorder(7);
  const dry = createDryRunPublisher();
  const t0 = Date.now();
  const run = await handleIngestSource({
    env, fetchText: () => new Promise<string>(() => {}), publisher: dry.publisher, providers: [templateSummarizer], rpc: r.rpc,
    usageStore: memoryUsageStore(), clock: () => DRY_NOW,
    budget: createTimeBudget({ softMs: 20, hardMs: 80 }),          // stands in for 100 s / 140 s
  }, parseIngestOptions({ source: 'fed' }));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(run.ok, false);
  assert.equal(run.stopped_by, 'timeout');
  assert.match(run.error ?? '', /deadline/);
  const last = r.calls.at(-1)!;
  assert.equal(last.name, 'log_run');
  assert.equal(last.body.p.id, 7);
  assert.equal(last.body.p.detail.stopped_by, 'timeout');
});

test('withDeadline: resolves, rejects with the work error, or DeadlineError; the default hard deadline is 140 s', async () => {
  assert.equal(await withDeadline(Promise.resolve(5), 1000), 5);
  await assert.rejects(withDeadline(Promise.reject(new Error('x')), 1000), /x/);
  await assert.rejects(withDeadline(new Promise(() => {}), 30), DeadlineError);
  const b = createTimeBudget();
  assert.equal(b.hardMs, 140_000);
  assert.equal(b.softMs, 100_000);
});

test('reserve: ingest AI calls stop 10 below the Gemini cap, the Brief may use them', async () => {
  const store = memoryUsageStore({ gemini: 489 }, { gemini: { cap: 500, reserve: 10 }, groq: { cap: 74, reserve: 5 } });
  const tracker = await createUsageTracker(store);
  const p = withUsage({ name: 'gemini', usesAi: true, model: 'm', dailyCap: 500, summarize: async () => ({} as never) }, tracker, 500);
  await p.summarize({ item: {} as never, text: '' });                         // 490th call
  await assert.rejects(p.summarize({ item: {} as never, text: '' }), CapReachedError);
  const t2 = await createUsageTracker(store);
  const brief = textModelWithUsage({ name: 'gemini', model: 'm', dailyCap: 500, generate: async () => 'ok' }, t2);
  assert.equal(await brief.generate('x'), 'ok');                              // 491st, from the reserve
  store.counts.gemini = 500;
  await assert.rejects(brief.generate('x'), CapReachedError);
});

test('daily-quota 429 sets today\'s use to the cap; a per-minute 429 does not', async () => {
  const caps = { groq: { cap: 74, reserve: 5 } };
  const store = memoryUsageStore({ groq: 3 }, caps);
  const tracker = await createUsageTracker(store);
  const mk = (daily: boolean) => withUsage({ name: 'groq', usesAi: true, model: 'm', dailyCap: 74, summarize: async () => { throw new RateLimitedError('groq', daily); } }, tracker, 74);
  await assert.rejects(mk(false).summarize({ item: {} as never, text: '' }), RateLimitedError);
  assert.equal(store.counts.groq, 4, 'only the one counted call');
  await assert.rejects(mk(true).summarize({ item: {} as never, text: '' }), RateLimitedError);
  assert.equal(store.counts.groq, 74);
  assert.equal(tracker.counter.used('groq') > 74, true, 'full for the rest of this run too');
  // text models (Brief) do the same
  const store2 = memoryUsageStore({ gemini: 1 }, { gemini: { cap: 500, reserve: 10 } });
  const t2 = await createUsageTracker(store2);
  const m: TextModel = { name: 'gemini', model: 'm', dailyCap: 500, generate: async () => { throw new RateLimitedError('gemini', true); } };
  await assert.rejects(textModelWithUsage(m, t2).generate('x'), RateLimitedError);
  assert.equal(store2.counts.gemini, 500);
});

test('model_missing reaches the run summary and the log payload (ingest and Brief)', async () => {
  const r = rpcRecorder();
  const gone: TextModel = { name: 'gemini', model: 'fallback', modelMissing: true, dailyCap: 500, generate: async () => '' };
  const res = await handleBriefSummary({
    env, rpc: r.rpc, usageStore: memoryUsageStore(), models: [gone],
    fetchBrief: async () => { throw new Error('no brief in this test'); },
  }, parseBriefOptions({ kind: 'daily', no_ai: false }));
  assert.equal(res.run.stats.model_missing, true);
  assert.equal(r.calls[0]!.name, 'run_start');
  const logged = r.calls.at(-1)!.body.p;
  assert.equal(logged.id, 42);
  assert.equal(logged.detail.stats.model_missing, true);

  const clean = buildRunSummary({ source: 'fed', startedAt: 0, finishedAt: 1, aiCalls: 0, log: [] });
  assert.equal('model_missing' in clean.stats, false);
  assert.equal('id' in runLogPayload(clean), false);
  assert.equal(runLogPayload(clean, 9).id, 9);
  assert.equal(buildRunSummary({ source: 'fed', startedAt: 0, finishedAt: 1, aiCalls: 0, log: [], error: 'x', timedOut: true }).stopped_by, 'timeout');
});
