# workers/watchdog

A Cloudflare Worker that runs once an hour (cron `17 * * * *`) and watches Element's cloud pipeline.
No public surface (HTTP requests get 404). Cloudflare Free allows 5 cron triggers per account; this uses one.

## What one run does

1. **Keep-alive and read:** calls `api.feed_status()` and `api.ops_status(token)` through PostgREST with the
   publishable key. These are real API requests (24 a day), which is what keeps a free Supabase project from
   pausing. There is no service-role key in the Worker.
2. **Re-trigger:** if `feed_status().delayed` is true (no clean run and no card in 3 hours) and this is the first run
   of a 6-hour block (UTC hours 0, 6, 12, 18), it POSTs `ingest-source` for 4 sources one after another (a window
   that rotates through macro, fed, bea, fedreg, sec, wiki, cpsc, usgs, nasa), with `CRON_SECRET` as the bearer
   token. No stored state is needed.
3. **Alert** through GitHub issues, then **ping** Healthchecks.io.

## Problems it reports (label `wd:<kind>`)

| Kind | Condition |
|---|---|
| `stale` | no error-free run (brief-summary excluded) and no card in 3 h |
| `quiet` | no card in 24 h (48 h from Saturday 00:00 to Monday 12:00 UTC). Alert only: news can be quiet |
| `jobs` | the number of `element-%` pg_cron jobs is not 10 |
| `cron` | failed cron runs or non-2xx function replies in the last 24 h |
| `hung` | a run open for over 10 minutes, or a run marked `killed` in the last 24 h |
| `model` | a run used the fallback model (`stats.model_missing`) |
| `ai` | Gemini or Groq at 80 percent of today's cap, or at the cap 3 days in a row |
| `db` | database over 400 MB (free tier 500 MB) |
| `supabase` | `feed_status` or `ops_status` did not answer (paused project, wrong key or token) |

One open issue per label. A new problem opens an issue (GitHub emails the owner), an open one gets at most one comment a
day (checked on GitHub, so the Worker keeps no state), and a recovered one gets a note and is closed. A kind the run
could not judge (Supabase down) is never closed. Issue text holds only counts, timestamps, source names and short error
classes, cut to 200 characters with keys, uuids and long opaque strings removed (`sanitize` in `src/logic.ts`).
The repo must be **private** (issues in a public repo are public).

If GitHub answers 4xx (for example an expired token) the Worker sends `/fail` to the Healthchecks.io check, which emails
Drew. If the Worker stops running at all, the check misses its hourly ping and emails too.

## Files

| File | What it is |
|---|---|
| `src/index.ts` | The cron handler `scheduled()` and `runWatchdog(env, now, fetch)` (injectable, tested) |
| `src/logic.ts` | Pure functions: `evaluate` (problems), `pickSources`, `retriggerDue`, `quietThresholdHours`, `sanitize` |
| `src/alerts.ts` | `syncAlerts`: GitHub issue create / comment / close |
| `test/watchdog.test.ts` | Mocked-fetch tests (stale, no duplicates, recovery, 401, paused project, payload clean-up) |
| `wrangler.toml` | Name, cron, non-secret vars (`SUPABASE_URL`, `ALERT_REPO`) |

## Settings and secrets

| Name | Kind | Value |
|---|---|---|
| `SUPABASE_URL`, `ALERT_REPO` | var in `wrangler.toml` | project URL; `owner/element-ops` |
| `SUPABASE_PUBLISHABLE_KEY` | secret | the project's publishable (anon) key |
| `WATCHDOG_TOKEN` | secret | same value as the Vault secret `element_watchdog_token` |
| `CRON_SECRET` | secret | same value as the Edge Function secret `CRON_SECRET` (24+ characters) |
| `GITHUB_TOKEN` | secret | fine-grained token, Issues read and write, only the `element-ops` repo |
| `HEALTHCHECK_URL` | secret | the check's ping URL from Healthchecks.io |

Set each secret with `npx wrangler secret put <NAME>` in this folder (type the value there; never put it in a file).
Thresholds (3 h, 24/48 h, 80 percent, 400 MB, expected 10 jobs) are constants at the top of `src/logic.ts`.

## Commands

```
npm --prefix workers/watchdog test        # offline tests (Node 22+)
npx tsc --noEmit -p workers/watchdog/tsconfig.json
cd workers/watchdog && npx wrangler deploy
```
