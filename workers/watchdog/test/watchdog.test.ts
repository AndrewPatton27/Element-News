// Watchdog Worker tests (offline, mocked fetch). Run: npm --prefix workers/watchdog test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWatchdog, type Env } from '../src/index.ts';
import { evaluate, isMarketHourEt, parseFloor, pickSources, quietThresholdHours, retriggerDue, sanitize, SOURCES, type FeedStatus, type OpsStatus } from '../src/logic.ts';

const ENV: Env = {
  SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_testkey1234567890',
  WATCHDOG_TOKEN: 'wd-token-0123456789abcdef', CRON_SECRET: 'cron-secret-0123456789abcdef0123',
  GITHUB_TOKEN: 'github_pat_TESTTOKEN0123456789', ALERT_REPO: 'me/element-ops', HEALTHCHECK_URL: 'https://hc-ping.com/' + ['11111111', '2222', '3333', '4444', '555555555555'].join('-'),
};
const T0 = new Date('2026-11-10T12:17:00Z');   // a Tuesday, 12:17 UTC: a re-trigger hour

const okOps = (over: Partial<OpsStatus> = {}): OpsStatus => ({
  jobs: 30, cron_failures_24h: 0, http_non2xx_24h: 0, hung_open: 0, killed_24h: 0, model_missing: 0,
  ai: [{ provider: 'gemini', used: 100, cap: 500 }, { provider: 'groq', used: 10, cap: 74 }], db_size_mb: 120, ...over,
});
const okFeed = (over: Partial<FeedStatus> = {}): FeedStatus => ({
  last_published_at: new Date(T0.getTime() - 2 * 3_600_000).toISOString(), last_ok_run_at: new Date(T0.getTime() - 30 * 60_000).toISOString(), delayed: false, ...over,
});

interface Issue { at: number; number: number; title: string; body: string; labels: string[]; state: 'open' | 'closed'; comments: { body: string; at: number }[] }

/** In-memory Supabase + GitHub + Healthchecks. `now` moves between runs. */
function world(o: { feed?: FeedStatus | (() => FeedStatus); ops?: OpsStatus | (() => OpsStatus); githubStatus?: number; supabaseDown?: boolean } = {}) {
  const issues: Issue[] = [];
  const seen: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
  const pings: string[] = [];
  const fnCalls: Array<{ source: string; auth: string }> = [];
  let now = T0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    seen.push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string> });
    const u = new URL(url);
    if (u.host === 'abc.supabase.co') {
      if (o.supabaseDown) return json({ message: 'paused' }, 503);
      if (u.pathname.endsWith('/rpc/feed_status')) return json(typeof o.feed === 'function' ? o.feed() : (o.feed ?? okFeed()));
      if (u.pathname.endsWith('/rpc/ops_status')) {
        assert.equal(JSON.parse(body).p_token, ENV.WATCHDOG_TOKEN);
        return json(typeof o.ops === 'function' ? o.ops() : (o.ops ?? okOps()));
      }
      if (u.pathname.endsWith('/functions/v1/ingest-source')) { fnCalls.push({ source: JSON.parse(body).source, auth: (init.headers as Record<string, string>).Authorization! }); return json({ ok: true }); }
    }
    if (u.host === 'hc-ping.com') { pings.push(u.pathname.endsWith('/fail') ? 'fail' : 'ok'); return new Response('OK'); }
    if (u.host === 'api.github.com') {
      if (o.githubStatus) return json({ message: 'Bad credentials' }, o.githubStatus);
      const path = u.pathname.replace('/repos/me/element-ops', '');
      if (path === '/issues' && method === 'GET') {
        const label = u.searchParams.get('labels')!;
        return json(issues.filter((i) => i.state === 'open' && i.labels.includes(label)).slice(0, 1).map((i) => ({ number: i.number, created_at: new Date(i.at).toISOString() })));
      }
      if (path === '/issues' && method === 'POST') {
        const b = JSON.parse(body);
        issues.push({ at: now.getTime(), number: issues.length + 1, title: b.title, body: b.body, labels: b.labels, state: 'open', comments: [] });
        return json({ number: issues.length }, 201);
      }
      let m = /^\/issues\/(\d+)\/comments$/.exec(path);
      if (m && method === 'GET') {
        const since = Date.parse(u.searchParams.get('since')!);
        return json(issues[Number(m[1]) - 1]!.comments.filter((c) => c.at >= since));
      }
      if (m && method === 'POST') { issues[Number(m[1]) - 1]!.comments.push({ body: JSON.parse(body).body, at: now.getTime() }); return json({}, 201); }
      m = /^\/issues\/(\d+)$/.exec(path);
      if (m && method === 'PATCH') { issues[Number(m[1]) - 1]!.state = JSON.parse(body).state; return json({}); }
    }
    return json({ message: 'no route' }, 404);
  };
  return { issues, seen, pings, fnCalls, fetchImpl, run: (at: Date = now) => { now = at; return runWatchdog(ENV, at, fetchImpl); }, setNow: (d: Date) => { now = d; } };
}

test('healthy: no issues, no re-trigger, success ping; keep-alive calls made with the publishable key only', async () => {
  const w = world();
  const r = await w.run();
  assert.deepEqual(r.problems, []);
  assert.equal(w.issues.length, 0);
  assert.equal(w.fnCalls.length, 0);
  assert.deepEqual(w.pings, ['ok']);
  const rpcCalls = w.seen.filter((s) => s.url.includes('/rest/v1/rpc/'));
  assert.deepEqual(rpcCalls.map((c) => c.url.split('/').pop()), ['feed_status', 'ops_status']);
  assert.ok(rpcCalls.every((c) => c.headers.apikey === ENV.SUPABASE_PUBLISHABLE_KEY && !c.headers.Authorization));
});

test('stale: one issue, 4 re-triggers with CRON_SECRET; next hour no duplicate and no re-trigger; recovery comments and closes', async () => {
  let feed = okFeed({ delayed: true, last_ok_run_at: new Date(T0.getTime() - 5 * 3_600_000).toISOString() });
  const w = world({ feed: () => feed });
  const r1 = await w.run(T0);
  assert.deepEqual(r1.problems, ['stale']);
  assert.equal(w.issues.length, 1);
  assert.deepEqual(w.issues[0]!.labels, ['wd:stale']);
  assert.equal(w.fnCalls.length, 4);
  assert.ok(w.fnCalls.every((c) => c.auth === `Bearer ${ENV.CRON_SECRET}`));
  assert.equal(new Set(w.fnCalls.map((c) => c.source)).size, 4);
  assert.deepEqual(r1.retriggerStatus, [200, 200, 200, 200]);

  // 13:17: still stale. Not a re-trigger hour, issue already open, comment only once a day.
  const r2 = await w.run(new Date(T0.getTime() + 3_600_000));
  assert.equal(w.issues.length, 1, 'no duplicate issue');
  assert.equal(w.fnCalls.length, 4, 'no second re-trigger within 6 h');
  assert.equal(w.issues[0]!.comments.length, 0, 'no comment within a day of the issue');
  assert.deepEqual(r2.problems, ['stale']);

  // 25 h later: still stale -> one comment (and at most one)
  const day2 = new Date(T0.getTime() + 25 * 3_600_000);
  await w.run(day2);
  assert.equal(w.issues[0]!.comments.length, 1, 'one reminder after a day');
  await w.run(new Date(day2.getTime() + 3_600_000));
  assert.equal(w.issues[0]!.comments.length, 1, 'but only one');

  // recovery
  feed = okFeed();
  await w.run(new Date(T0.getTime() + 27 * 3_600_000));
  assert.equal(w.issues[0]!.state, 'closed');
  assert.match(w.issues[0]!.comments.at(-1)!.body, /Recovered/);
  assert.equal(w.pings.every((p) => p === 'ok'), true);
});

test('comment cadence: an open issue gets one comment per day, not one per hour', async () => {
  const w = world({ feed: okFeed({ delayed: true, last_published_at: null }) });   // no card time: only the stale alert applies
  await w.run(T0);                                                 // opens the issue
  const hour = (n: number) => new Date(T0.getTime() + n * 3_600_000);
  for (let n = 1; n <= 23; n++) await w.run(hour(n));
  const before = w.issues[0]!.comments.length;
  for (let n = 24; n <= 47; n++) await w.run(hour(n));
  assert.equal(w.issues.length, 1);
  assert.ok(w.issues[0]!.comments.length - before <= 1, `comments over the next day: ${w.issues[0]!.comments.length - before}`);
  assert.ok(w.issues[0]!.comments.length >= 1);
});

test('GitHub 401 (PAT expired): no crash, the dead-man check gets /fail', async () => {
  const w = world({ feed: okFeed({ delayed: true }), githubStatus: 401 });
  const r = await w.run();
  assert.equal(r.githubStatus, 401);
  assert.deepEqual(w.pings, ['fail']);
  assert.equal(r.pinged, 'fail');
});

test('Supabase down (paused): a supabase issue only; other issues are not closed; no re-trigger', async () => {
  const w = world();
  w.issues.push({ at: T0.getTime(), number: 1, title: 'x', body: '', labels: ['wd:model'], state: 'open', comments: [] });
  const down = world({ supabaseDown: true });
  down.issues.push(...w.issues);
  const r = await down.run();
  assert.deepEqual(r.problems, ['supabase']);
  assert.equal(down.issues.find((i) => i.labels.includes('wd:model'))!.state, 'open', 'an unjudged kind stays open');
  assert.equal(down.issues.filter((i) => i.labels.includes('wd:supabase')).length, 1);
  assert.equal(down.fnCalls.length, 0);
});

test('ops problems map to kinds: jobs, cron, hung, model, ai (80% and 3 days at cap), db, quiet', () => {
  const k = (feed: FeedStatus, ops: OpsStatus, at = T0) => evaluate(feed, ops, at).map((p) => p.kind);
  assert.deepEqual(k(okFeed(), okOps({ jobs: 9 })), ['jobs']);
  assert.deepEqual(k(okFeed(), okOps({ cron_failures_24h: 2 })), ['cron']);
  assert.deepEqual(k(okFeed(), okOps({ http_non2xx_24h: 1 })), ['cron']);
  assert.deepEqual(k(okFeed(), okOps({ hung_open: 1 })), ['hung']);
  assert.deepEqual(k(okFeed(), okOps({ killed_24h: 1 })), ['hung']);
  assert.deepEqual(k(okFeed(), okOps({ model_missing: 3 })), ['model']);
  assert.deepEqual(k(okFeed(), okOps({ ai: [{ provider: 'gemini', used: 400, cap: 500 }] })), ['ai']);
  assert.deepEqual(k(okFeed(), okOps({ ai: [{ provider: 'groq', used: 10, cap: 74, at_cap_3_days: true }] })), ['ai']);
  assert.deepEqual(k(okFeed(), okOps({ ai: [{ provider: 'gemini', used: 399, cap: 500 }] })), []);
  assert.deepEqual(k(okFeed(), okOps({ db_size_mb: 450 })), ['db']);
  assert.deepEqual(k(okFeed(), okOps({ jobs: null, cron_failures_24h: null, http_non2xx_24h: null })), []);
  const old = (h: number) => okFeed({ last_published_at: new Date(T0.getTime() - h * 3_600_000).toISOString() });
  assert.deepEqual(k(old(25), okOps()), ['quiet']);
  assert.deepEqual(k(old(23), okOps()), []);
  // weekend: 48 h window (Saturday 2026-11-14 12:00 UTC)
  const sat = new Date('2026-11-14T12:00:00Z');
  assert.equal(quietThresholdHours(sat), 48);
  assert.deepEqual(evaluate(okFeed({ last_published_at: new Date(sat.getTime() - 30 * 3_600_000).toISOString() }), okOps(), sat).map((p) => p.kind), []);
  assert.equal(quietThresholdHours(new Date('2026-11-16T11:00:00Z')), 48, 'Monday morning is still the weekend window');
  assert.equal(quietThresholdHours(new Date('2026-11-16T13:00:00Z')), 24);
});

test('re-trigger: only in hours 0, 6, 12, 18; four different sources that rotate between blocks', () => {
  assert.equal(retriggerDue(new Date('2026-11-10T12:17:00Z')), true);
  assert.equal(retriggerDue(new Date('2026-11-10T13:17:00Z')), false);
  const a = pickSources(new Date('2026-11-10T12:17:00Z'));
  const b = pickSources(new Date('2026-11-10T18:17:00Z'));
  assert.equal(new Set(a).size, 4);
  assert.notDeepEqual(a, b);
  const seen = new Set<string>();
  for (let h = 0; h < 24 * 3; h += 6) for (const s of pickSources(new Date(Date.UTC(2026, 10, 10, h)))) seen.add(s);
  assert.equal(seen.size, SOURCES.length, 'every source gets a turn');
});

test('payloads: no key, token, uuid or long opaque string in anything sent to GitHub or Healthchecks', async () => {
  const leaky = okOps({ ai: [{ provider: 'gemini sb_secret_abcdef123456 eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl 123e4567-e89b-12d3-a456-426614174000', used: 450, cap: 500 }] });
  const w = world({ ops: leaky, feed: okFeed({ delayed: true }) });
  await w.run();
  const sent = w.seen.filter((s) => s.url.includes('api.github.com') || s.url.includes('hc-ping.com')).map((s) => s.body).join('\n');
  assert.ok(sent.length > 0);
  for (const bad of [/sb_secret_/, /eyJ/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /github_pat_/, /[A-Za-z0-9_\-+/=]{32,}/, new RegExp(ENV.CRON_SECRET), new RegExp(ENV.WATCHDOG_TOKEN)]) {
    assert.doesNotMatch(sent, bad);
  }
  // secrets only travel in headers to their own hosts
  const gh = w.seen.filter((s) => s.url.includes('api.github.com'));
  assert.ok(gh.every((s) => s.headers.Authorization === `Bearer ${ENV.GITHUB_TOKEN}`));
  assert.ok(w.seen.filter((s) => !s.url.includes('api.github.com')).every((s) => !JSON.stringify(s.headers).includes(ENV.GITHUB_TOKEN)));
});

test('sanitize: cuts to 200 characters, one line, redacts keys and ids', () => {
  assert.equal(sanitize('word '.repeat(100)).length, 200);
  assert.equal(sanitize('x'.repeat(500)), '[redacted]');
  assert.equal(sanitize('line1\nline2'), 'line1 line2');
  assert.match(sanitize('key ghp_abcdefghijklmnop'), /\[redacted\]/);
  assert.match(sanitize('user 123e4567-e89b-12d3-a456-426614174000'), /\[id\]/);
  assert.equal(sanitize(null), '');
});

test('the Worker has no HTTP surface: fetch answers 404', async () => {
  const mod = (await import('../src/index.ts')).default;
  assert.equal((await mod.fetch()).status, 404);
});

test('no HEALTHCHECK_URL: runs, alerts through GitHub, and never calls a ping service', async () => {
  const w = world();
  const { HEALTHCHECK_URL: _unused, ...envNoPing } = ENV;
  const r = await runWatchdog(envNoPing as typeof ENV, T0, w.fetchImpl);
  assert.equal(r.pinged, 'none');
  assert.equal(w.pings.length, 0);
  assert.equal(w.seen.some((s) => s.url.includes('hc-ping.com')), false);
});

// ---- supply floor (M9 workstream 1) ----
test('supply floor: below the 24 h floor is a problem, at the floor is fine, a missing count (older database) is skipped, 0 turns it off', () => {
  const k = (ops: OpsStatus, floors?: { cards24h: number; cardsMarketHour: number }) => evaluate(okFeed(), ops, T0, undefined, floors).map((p) => p.kind);
  assert.deepEqual(k(okOps({ cards_24h: 9, cards_1h: 0 })), ['supply']);
  assert.deepEqual(k(okOps({ cards_24h: 10, cards_1h: 0 })), []);
  assert.deepEqual(k(okOps()), [], 'ops_status without cards_24h: no alert');
  assert.deepEqual(k(okOps({ cards_24h: null })), []);
  assert.deepEqual(k(okOps({ cards_24h: 0 }), { cards24h: 0, cardsMarketHour: 0 }), []);
  assert.deepEqual(k(okOps({ cards_24h: 3 }), { cards24h: 5, cardsMarketHour: 0 }), ['supply']);
  const p = evaluate(okFeed(), okOps({ cards_24h: 4 }), T0)[0]!;
  assert.match(p.title, /4 cards in 24 hours/);
  assert.match(p.detail, /supply-readout/);
});

test('supply floor: the market-hour floor is off by default, and when on it counts only in market hours (ET, DST aware)', () => {
  const on = { cards24h: 10, cardsMarketHour: 1 };
  const ops = okOps({ cards_24h: 20, cards_1h: 0 });
  assert.deepEqual(evaluate(okFeed(), ops, T0).map((p) => p.kind), [], 'default 0: off');
  assert.deepEqual(evaluate(okFeed(), ops, T0, undefined, on).map((p) => p.kind), [], 'Tue 12:17 UTC is 07:17 ET: not a market hour');
  const mkt = new Date('2026-11-10T15:17:00Z');   // Tue 10:17 ET
  assert.deepEqual(evaluate(okFeed({ last_published_at: new Date(mkt.getTime() - 3_600_000).toISOString(), last_ok_run_at: new Date(mkt.getTime() - 600_000).toISOString() }), ops, mkt, undefined, on).map((p) => p.kind), ['supply']);
  assert.deepEqual(evaluate(okFeed({ last_published_at: new Date(mkt.getTime() - 3_600_000).toISOString(), last_ok_run_at: new Date(mkt.getTime() - 600_000).toISOString() }), okOps({ cards_24h: 20, cards_1h: 1 }), mkt, undefined, on).map((p) => p.kind), []);
});

test('isMarketHourEt: weekdays 10:00-16:59 ET only; DST both sides; weekend never', () => {
  assert.equal(isMarketHourEt(new Date('2026-11-10T15:17:00Z')), true);    // Tue 10:17 EST
  assert.equal(isMarketHourEt(new Date('2026-11-10T14:17:00Z')), false);   // Tue 09:17 EST
  assert.equal(isMarketHourEt(new Date('2026-11-10T21:59:00Z')), true);    // Tue 16:59 EST
  assert.equal(isMarketHourEt(new Date('2026-11-10T22:00:00Z')), false);   // Tue 17:00 EST
  assert.equal(isMarketHourEt(new Date('2026-07-15T14:17:00Z')), true);    // Wed 10:17 EDT
  assert.equal(isMarketHourEt(new Date('2026-07-15T13:17:00Z')), false);   // Wed 09:17 EDT
  assert.equal(isMarketHourEt(new Date('2026-11-14T16:17:00Z')), false);   // Saturday
  assert.equal(isMarketHourEt(new Date('2026-11-15T16:17:00Z')), false);   // Sunday
});

test('parseFloor: whole numbers only, else the default', () => {
  assert.equal(parseFloor('12', 10), 12);
  assert.equal(parseFloor(' 0 ', 10), 0);
  assert.equal(parseFloor(7, 10), 7);
  for (const bad of [undefined, '', 'abc', '-3', '1.5', '99999', null, -1, 2.5]) assert.equal(parseFloor(bad, 10), 10, String(bad));
});

test('supply alert end to end: opens one issue, still one RPC pair per run, closes when supply recovers; Worker var overrides the floor', async () => {
  let cards = 4;
  const w = world({ ops: () => okOps({ cards_24h: cards, cards_1h: 0 }) });
  const r = await w.run();
  assert.deepEqual(r.problems, ['supply']);
  assert.equal(w.issues.length, 1);
  assert.deepEqual(w.issues[0]!.labels, ['wd:supply']);
  assert.match(w.issues[0]!.title, /Card supply low: 4 cards/);
  const rpcs = w.seen.filter((x) => x.url.includes('/rest/v1/rpc/')).map((x) => x.url.split('/').pop());
  assert.deepEqual(rpcs, ['feed_status', 'ops_status'], 'no extra Supabase query for the supply check');
  cards = 14;
  const later = new Date(T0.getTime() + 3_600_000);
  const r2 = await w.run(later);
  assert.deepEqual(r2.problems, []);
  assert.equal(w.issues[0]!.state, 'closed');
  // the var raises the floor: 14 cards is now low
  const env2: Env = { ...ENV, SUPPLY_FLOOR_CARDS_24H: '20' };
  const w2 = world({ ops: () => okOps({ cards_24h: 14, cards_1h: 0 }) });
  const r3 = await runWatchdog(env2, T0, w2.fetchImpl);
  assert.deepEqual(r3.problems, ['supply']);
});
