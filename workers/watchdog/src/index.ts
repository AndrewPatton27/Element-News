// Element watchdog: a Cloudflare Worker on a cron trigger (17 * * * *, once an hour).
// 1. Keep-alive + read: api.feed_status() and api.ops_status(token) over PostgREST with the PUBLISHABLE key
//    (real API requests also keep the free Supabase project from pausing). No service-role key in the Worker.
// 2. Re-trigger: when the pipeline is stale, POST ingest-source for 4 rotating sources, one after another,
//    in the first run of each 6-hour block, with CRON_SECRET.
// 3. Alert through GitHub issues in a private repo (alerts.ts), then (only if HEALTHCHECK_URL is set) ping a dead-man check
//    (it emails if this Worker stops, or if GitHub refuses the token, e.g. an expired PAT).
// All secrets come from the environment (wrangler secret put); nothing is written in code.
// Inputs: Env (below). Outputs: a JSON summary in the Worker log (counts and kinds only).

import { syncAlerts, type Fetcher } from './alerts.ts';
import { ALL_KINDS, DEFAULT_SUPPLY_FLOORS, evaluate, parseFloor, pickSources, retriggerDue, sanitize, type FeedStatus, type Kind, type OpsStatus } from './logic.ts';

export interface Env {
  SUPABASE_URL: string;                 // var: https://<ref>.supabase.co
  SUPABASE_PUBLISHABLE_KEY: string;     // secret (public key, but kept out of the repo)
  WATCHDOG_TOKEN: string;               // secret: same value as Vault element_watchdog_token
  CRON_SECRET: string;                  // secret: same value as the Edge Function secret CRON_SECRET
  GITHUB_TOKEN: string;                 // secret: fine-grained PAT, Issues read/write on the one private repo
  ALERT_REPO: string;                   // var: "owner/element-ops" (private)
  SUPPLY_FLOOR_CARDS_24H?: string;      // optional var: cards in 24 h below this opens a 'supply' alert (default 10, 0 = off)
  SUPPLY_FLOOR_CARDS_MARKET_HOUR?: string;   // optional var: cards in the last hour below this during market hours (default 0 = off)
  HEALTHCHECK_URL?: string;             // optional secret (https://hc-ping.com/<uuid>); when unset the ping is skipped
}

export interface RunReport {
  problems: Kind[]; retriggered: string[]; retriggerStatus: number[]; githubStatus: number | null; pinged: 'ok' | 'fail' | 'none';
}

async function rpc<T>(env: Env, f: Fetcher, name: string, body: unknown): Promise<T> {
  const r = await f(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', 'Content-Profile': 'api', 'Accept-Profile': 'api' },
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function ping(env: Env, f: Fetcher, fail: boolean, note: string): Promise<'ok' | 'fail' | 'none'> {
  if (!env.HEALTHCHECK_URL) return 'none';
  try {
    await f(fail ? `${env.HEALTHCHECK_URL.replace(/\/+$/, '')}/fail` : env.HEALTHCHECK_URL, {
      method: 'POST', body: sanitize(note, 200), signal: AbortSignal.timeout(10_000),
    });
  } catch { /* Healthchecks itself is down: nothing else to do */ }
  return fail ? 'fail' : 'ok';
}

/** One watchdog run. `f` is injectable for tests. Never throws. */
export async function runWatchdog(env: Env, now: Date, f: Fetcher = (u, i) => fetch(u, i)): Promise<RunReport> {
  const report: RunReport = { problems: [], retriggered: [], retriggerStatus: [], githubStatus: null, pinged: 'none' };
  let feed: FeedStatus | null = null, ops: OpsStatus | null = null, err = '';
  try { feed = await rpc<FeedStatus>(env, f, 'feed_status', {}); } catch (e) { err = (e as Error).message; }
  try { ops = await rpc<OpsStatus>(env, f, 'ops_status', { p_token: env.WATCHDOG_TOKEN }); } catch (e) { err ||= (e as Error).message; }

  const floors = {
    cards24h: parseFloor(env.SUPPLY_FLOOR_CARDS_24H, DEFAULT_SUPPLY_FLOORS.cards24h),
    cardsMarketHour: parseFloor(env.SUPPLY_FLOOR_CARDS_MARKET_HOUR, DEFAULT_SUPPLY_FLOORS.cardsMarketHour),
  };
  const problems = evaluate(feed, ops, now, err, floors);
  report.problems = problems.map((p) => p.kind);

  // Re-trigger a stale pipeline (only when Supabase answered, otherwise the functions cannot work either).
  if (feed?.delayed && retriggerDue(now)) {
    for (const source of pickSources(now)) {
      try {
        const r = await f(`${env.SUPABASE_URL}/functions/v1/ingest-source`, {
          method: 'POST', body: JSON.stringify({ source }), signal: AbortSignal.timeout(160_000),
          headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'Content-Type': 'application/json' },
        });
        report.retriggerStatus.push(r.status);
      } catch { report.retriggerStatus.push(0); }
      report.retriggered.push(source);
    }
  }

  // A failed Supabase call can only judge itself; kinds that needed the missing data stay untouched.
  const checked: Kind[] = ALL_KINDS.filter((k) => {
    if (k === 'supabase') return true;
    if (k === 'stale' || k === 'quiet') return feed !== null;
    return ops !== null;
  });
  let alertFailed = false, note = `ok problems=${report.problems.join(',') || 'none'}`;
  try {
    const a = await syncAlerts({ repo: env.ALERT_REPO, token: env.GITHUB_TOKEN, fetch: f, now }, problems, checked);
    report.githubStatus = a.githubStatus;
    if (a.githubStatus !== null && a.githubStatus >= 400) { alertFailed = true; note = `GitHub answered ${a.githubStatus}`; }
  } catch (e) {
    alertFailed = true; note = `GitHub call failed: ${sanitize((e as Error).message, 80)}`;
  }
  report.pinged = await ping(env, f, alertFailed, note);
  return report;
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runWatchdog(env, new Date()).then((r) => console.log(JSON.stringify(r))));
  },
  // No public surface: anything over HTTP gets a 404.
  async fetch(): Promise<Response> { return new Response('not found', { status: 404 }); },
};
