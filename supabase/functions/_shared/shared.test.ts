// Offline tests for the Edge Function helpers (Node, no Deno): usage counter, time budget, run summary, env/auth.
// Run: npm run test:functions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTracker, memoryUsageStore, rpcUsageStore, textModelWithUsage, withUsage, type UsageStore } from './usage.ts';
import { createTimeBudget, guardFetch, guardPublisher } from './budget.ts';
import { buildRunSummary, logTail, runLogPayload } from './runSummary.ts';
import { isAuthorized, readFunctionEnv, readOptions } from './env.ts';
import { createServiceRpc } from './rpc.ts';
import { createDryRunPublisher } from './ingest.ts';
import { summarizeWithChain } from '../../../ingest/src/summarizer/chain.ts';
import type { RawItem, Summarizer } from '../../../ingest/src/types.ts';

const fakeClock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

// ---- usage counter ------------------------------------------------------------------

test('memory store: atomic take stops exactly at the cap', async () => {
  const s = memoryUsageStore({ gemini: 498 });
  assert.equal(await s.take('gemini', 500), true);
  assert.equal(await s.take('gemini', 500), true);
  assert.equal(await s.take('gemini', 500), false);
  assert.equal(s.counts.gemini, 500);
  assert.equal(await s.take('groq', 0), false, 'cap 0 = no calls');
});

test('tracker: snapshot feeds the sync counter; a refused take marks the provider full', async () => {
  const t = await createUsageTracker(memoryUsageStore({ groq: 73 }));
  assert.equal(t.counter.used('groq'), 73);
  await t.take('groq', 74);
  assert.equal(t.taken.groq, 1);
  await assert.rejects(t.take('groq', 74), { name: 'CapReachedError' });
  assert.equal(t.denied.groq, 1);
  assert.ok(t.counter.used('groq') >= 74, 'chain sees the cap as reached after a refusal');
  assert.equal(t.totalTaken(), 1);
});

test('tracker: an unavailable counter refuses every AI call (caps are never guessed)', async () => {
  const broken: UsageStore = { get: async () => { throw new Error('rpc ai_usage_get: HTTP 404'); }, take: async () => true };
  const t = await createUsageTracker(broken);
  assert.match(t.errors[0], /unavailable/);
  assert.ok(t.counter.used('gemini') > 1e9);
  await assert.rejects(t.take('gemini', 500), { name: 'CapReachedError' });
  assert.equal(t.totalTaken(), 0);
});

test('rpc store: calls api.ai_usage_take / ai_usage_get with the right body and service headers', async () => {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response(url.endsWith('/ai_usage_get') ? '{"gemini":3}' : 'true', { status: 200 });
  };
  const rpc = createServiceRpc({ url: 'https://abc.supabase.co', key: 'eyJservicekey-0123456789', fetchImpl });
  const s = rpcUsageStore(rpc);
  assert.deepEqual(await s.get(), { gemini: 3 });
  assert.equal(await s.take('gemini', 500), true);
  assert.equal(calls[1].url, 'https://abc.supabase.co/rest/v1/rpc/ai_usage_take');
  assert.deepEqual(JSON.parse(calls[1].body), { p_provider: 'gemini', p_cap: 500 });
  assert.equal(calls[1].headers['Content-Profile'], 'api');
  assert.equal(calls[1].headers.Authorization, 'Bearer eyJservicekey-0123456789');
});

test('rpc: a non-allowlisted URL is refused before any request', async () => {
  let n = 0;
  const rpc = createServiceRpc({ url: 'http://abc.supabase.co', key: 'x'.repeat(30), fetchImpl: async () => { n++; return new Response('true'); } });
  await assert.rejects(rpc('ai_usage_take', {}), { name: 'AllowlistError' });
  assert.equal(n, 0);
});

const item: RawItem = {
  source: 'fed_rss', external_id: 'x1', url: 'https://www.federalreserve.gov/newsevents/pressreleases/x.htm', title: 'Federal Reserve issues statement',
  summary_text: 'The Federal Reserve kept its policy rate unchanged at 4.25 percent.', published_at: '2026-10-17T18:00:00Z', license_class: 'public_domain',
  tickers: [], event_type: 'fomc', category: 'economy', source_name: 'Federal Reserve', source_kind: 'regulator', doc_label: 'Press release',
} as unknown as RawItem;

test('withUsage + chain: at the database cap the AI is never called and the template is used', async () => {
  let called = 0;
  const ai: Summarizer = { name: 'gemini', usesAi: true, model: 'm', dailyCap: 500, minIntervalMs: 0, summarize: async () => { called++; throw new Error('should not run'); } };
  const t = await createUsageTracker(memoryUsageStore({ gemini: 500 }));
  const r = await summarizeWithChain({ item, text: item.summary_text }, [withUsage(ai, t, 500)], t.counter);
  assert.equal(called, 0);
  assert.equal(r.provider, 'template');
  assert.ok(r.log.some((l) => /daily cap 500 reached/.test(l)));
});

test('withUsage + chain: a race lost in the database (refused take) falls through to the template', async () => {
  let called = 0;
  const ai: Summarizer = { name: 'gemini', usesAi: true, model: 'm', dailyCap: 500, minIntervalMs: 0, summarize: async () => { called++; throw new Error('x'); } };
  const store = memoryUsageStore({ gemini: 10 });
  const t = await createUsageTracker(store);
  store.counts.gemini = 500;                       // another run used the rest after our snapshot
  const r = await summarizeWithChain({ item, text: item.summary_text }, [withUsage(ai, t, 500)], t.counter);
  assert.equal(called, 0);
  assert.equal(r.provider, 'template');
  assert.ok(r.log.some((l) => /CapReachedError/.test(l)));
  assert.equal(store.counts.gemini, 500, 'never above the cap');
});

test('withUsage: a closed time gate reports dailyCap 0 (no pacing wait, no count); the template passes through', async () => {
  const t = await createUsageTracker(memoryUsageStore());
  const ai: Summarizer = { name: 'groq', usesAi: true, dailyCap: 74, minIntervalMs: 30_000, summarize: async () => { throw new Error('x'); }, generate: async () => 'ok' };
  let open = true;
  const w = withUsage(ai, t, 74, () => open);
  assert.equal(w.dailyCap, 74);
  assert.equal(await w.generate!('p'), 'ok');
  assert.equal(t.taken.groq, 1, 'the scorer call is counted against Groq');
  open = false;
  assert.equal(w.dailyCap, 0);
  await assert.rejects(w.generate!('p'), { name: 'TimeBudgetError' });
  const tpl: Summarizer = { name: 'template', usesAi: false, summarize: async () => ({}) as never };
  assert.equal(withUsage(tpl, t, 0), tpl);
});

test('textModelWithUsage: counts each brief-summary call and refuses at the cap', async () => {
  const store = memoryUsageStore({ gemini: 499 });
  const t = await createUsageTracker(store);
  let n = 0;
  const m = textModelWithUsage({ name: 'gemini', model: 'g', dailyCap: 500, generate: async () => { n++; return 'text'; } }, t);
  assert.equal(await m.generate('p'), 'text');
  await assert.rejects(m.generate('p'), { name: 'CapReachedError' });
  assert.equal(n, 1);
  assert.equal(store.counts.gemini, 500);
});

// ---- time budget ----------------------------------------------------------------------

test('time budget: soft deadline stops new items, hard deadline closes AI calls that would not finish', () => {
  const c = fakeClock();
  const b = createTimeBudget({ softMs: 100_000, hardMs: 140_000, callTimeoutMs: 20_000, now: c.now });
  assert.equal(b.canStartItem(), true);
  assert.equal(b.aiAllowed(5_000), true);
  c.advance(99_999);
  assert.equal(b.canStartItem(), true);
  c.advance(1);
  assert.equal(b.canStartItem(), false);
  assert.equal(b.aiAllowed(0), true, '100 + 20 <= 140');
  assert.equal(b.aiAllowed(30_000), false, 'Groq pacing 30 s would end after 140 s');
  c.advance(25_000);
  assert.equal(b.aiAllowed(0), false);
  assert.equal(b.pastHard(), false);
  c.advance(15_000);
  assert.equal(b.pastHard(), true);
});

test('guardPublisher: work cap and deadline defer items without writing them', async () => {
  const c = fakeClock();
  const b = createTimeBudget({ now: c.now });
  const dry = createDryRunPublisher();
  // an item seen before has a closed status (like the database after an earlier run)
  const base = { ...dry.publisher, upsertItem: async (x: RawItem) => { const r = await dry.publisher.upsertItem(x); return r.is_new ? r : { ...r, status: 'published' }; } };
  const g = guardPublisher(base, b, 2);
  const it = (n: number) => ({ ...item, url: `https://www.federalreserve.gov/x${n}.htm` }) as RawItem;
  assert.equal((await g.publisher.upsertItem(it(1))).is_new, true);
  assert.equal((await g.publisher.upsertItem(it(1))).is_new, false, 'already seen: not counted as new work');
  assert.equal((await g.publisher.upsertItem(it(2))).is_new, true);
  const d = await g.publisher.upsertItem(it(3));
  assert.deepEqual([d.is_new, d.status], [false, 'deferred']);
  assert.equal(dry.items.length, 3, 'the deferred item was not written');
  assert.equal(g.counts.stoppedBy, 'work_cap');
  c.advance(100_000);
  await g.publisher.upsertItem(it(4));
  assert.deepEqual([g.counts.itemsNew, g.counts.deferredCap, g.counts.deferredTime, g.counts.stoppedBy], [2, 1, 1, 'time']);
});

test('guardFetch: no request after the hard deadline', async () => {
  const c = fakeClock();
  const b = createTimeBudget({ now: c.now });
  let n = 0;
  const f = guardFetch(async () => { n++; return 'ok'; }, b);
  assert.equal(await f('https://www.sec.gov/a', 'page', 0), 'ok');
  c.advance(140_000);
  await assert.rejects(f('https://www.sec.gov/b', 'page', 0), /time budget/);
  assert.equal(n, 1);
});

// ---- run summary ----------------------------------------------------------------------

test('run summary: counts, deferred items taken out of skipped, log tail capped, run-log payload', () => {
  const log = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(i === 49 ? 400 : 1)}`);
  const s = buildRunSummary({
    source: 'cpsc', startedAt: Date.parse('2026-10-19T10:00:00Z'), finishedAt: Date.parse('2026-10-19T10:01:30Z'),
    stats: { published: 3, skipped: 7, duplicate: 1, ticker_cap: 0, failed: 1, data_cards: 0 },
    guard: { itemsNew: 5, deferredTime: 0, deferredCap: 4, stoppedBy: 'work_cap' },
    aiCalls: 6, aiDenied: { groq: 1 }, log,
  });
  assert.deepEqual(
    [s.ok, s.duration_ms, s.items_new, s.published, s.skipped, s.failed, s.ai_calls, s.deferred, s.stopped_by],
    [true, 90_000, 5, 3, 4, 1, 6, 4, 'work_cap'],
  );
  assert.equal(s.log_tail.length, 40);
  assert.ok(s.log_tail.at(-1)!.length <= 300);
  const p = runLogPayload(s);
  assert.equal(p.source, 'cpsc');
  assert.equal(p.error, null);
  assert.equal((p.detail as { stopped_by: string }).stopped_by, 'work_cap');
  const e = buildRunSummary({ source: 'sec', startedAt: 0, finishedAt: 1, aiCalls: 0, error: 'boom', log: [] });
  assert.deepEqual([e.ok, e.stopped_by, e.error, e.published], [false, 'error', 'boom', 0]);
  assert.deepEqual(logTail(['a', 'b', 'c'], 2), ['b', 'c']);
});

// ---- env and auth ---------------------------------------------------------------------

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://mzfpelilxpbpcgskppxu.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'eyJ-service-role-key-for-tests',
  GEMINI_API_KEY: 'g-key', SEC_USER_AGENT: 'Element test@test.org', REPORT_CARD_PROTOCOL: '1',
};
const get = (k: string) => ENV[k];

test('auth: only the exact service-role bearer token passes', () => {
  assert.equal(isAuthorized('Bearer eyJ-service-role-key-for-tests', get), true);
  assert.equal(isAuthorized('bearer eyJ-service-role-key-for-tests', get), true);
  assert.equal(isAuthorized('Bearer eyJ-service-role-key-for-test', get), false);
  assert.equal(isAuthorized('Bearer eyJ-service-role-key-for-testsX', get), false);
  assert.equal(isAuthorized(null, get), false);
  assert.equal(isAuthorized('Bearer ', get), false);
  assert.equal(isAuthorized('Bearer short', (k) => (k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'short' : undefined)), false, 'no short keys');
});

test('env: injected Supabase values + custom secrets; missing or placeholder values are null', () => {
  const e = readFunctionEnv(get);
  assert.equal(e.supabaseUrl, ENV.SUPABASE_URL);
  assert.equal(e.readKey, ENV.SUPABASE_SERVICE_ROLE_KEY, 'no anon key: reads use the service key');
  assert.deepEqual([e.geminiApiKey, e.groqApiKey, e.fredApiKey, e.reportCard], ['g-key', null, null, true]);
  assert.equal(readFunctionEnv((k) => (k === 'SEC_USER_AGENT' ? 'your-app you@example.com' : ENV[k])).secUserAgent, null);
  assert.throws(() => readFunctionEnv((k) => (k === 'SUPABASE_URL' ? 'http://kong:8000' : ENV[k])), /SUPABASE_URL/);
  assert.throws(() => readFunctionEnv((k) => (k === 'SUPABASE_SERVICE_ROLE_KEY' ? '' : ENV[k])), /SERVICE_ROLE/);
});

test('readOptions: query string and JSON body are merged; bad JSON is ignored', async () => {
  const r = await readOptions(new Request('https://x.supabase.co/functions/v1/ingest-source?source=fed', { method: 'POST', body: '{"work_cap":3}' }));
  assert.deepEqual(r, { source: 'fed', work_cap: 3 });
  const bad = await readOptions(new Request('https://x.supabase.co/f?source=sec', { method: 'POST', body: '{nope' }));
  assert.deepEqual(bad, { source: 'sec' });
});
