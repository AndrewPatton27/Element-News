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
3. **Alert** through GitHub issues. (An optional Healthchecks.io ping runs only if `HEALTHCHECK_URL` is set; Drew chose not to use it.)

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

Alerts are GitHub issues only. If GitHub answers 4xx (for example an expired token) no alert can be sent; the Worker
logs it, and the app's "updates delayed" banner still works because it comes from `api.feed_status()`, not the Worker.
Check the token's expiry date when you create it and put a reminder in your calendar. With `HEALTHCHECK_URL` set, a
Healthchecks.io check would also email when the Worker stops (not enabled).

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
| `WATCHDOG_TOKEN` | secret | same value as the Vault secret `element_watchdog_token` (at least 32 characters; ops_status refuses shorter) |
| `CRON_SECRET` | secret | same value as the Edge Function secret `CRON_SECRET` (24+ characters) |
| `GITHUB_TOKEN` | secret | fine-grained token, Issues read and write, only the `element-ops` repo |
| `HEALTHCHECK_URL` | optional secret | not used; leave unset and the ping is skipped |

Set each secret with `npx wrangler secret put <NAME>` in this folder (type the value there; never put it in a file).
Thresholds (3 h, 24/48 h, 80 percent, 400 MB, expected 30 jobs (M9c3 adds beige, trade, regpress and annual on top of the count below; the older text said 24: 15 before M9 plus bls, beadata, eia, auctions, fomc, blscal, mts and the two purge jobs; the original 15 were: 10 ingest and brief jobs plus fedspeech, secpress, treasury and the two ranking checks; change it whenever a cron job is added or removed) are constants at the top of `src/logic.ts`.

## Supply floor

Kind `supply` (label `wd:supply`): fewer cards published in the last 24 hours than `supply_floor_cards_24h` (default 10, twice the 30-day median of 5 a day). An optional per-hour floor, `supply_floor_cards_market_hour` (default 0 = off), is checked only Monday to Friday 10:00-16:59 ET. Both counts (`cards_24h`, `cards_1h`) come from the same `api.ops_status` call as every other check (migration `20261129000000_supply_ops.sql`), so the Worker still makes two Supabase requests an hour and the database makes one pass over the `published_at` index. If the database does not have the migration yet the counts are missing and the check is skipped. Override the floors with the Worker vars `SUPPLY_FLOOR_CARDS_24H` and `SUPPLY_FLOOR_CARDS_MARKET_HOUR` (whole numbers; 0 turns a check off). The alert text points to `node scripts/supply-readout.mjs`. `EXPECTED_JOBS` and the cron schedule are unchanged. The `wd:supply` label must exist in the alert repo like the others.

## Commands

```
npm --prefix workers/watchdog test        # offline tests (Node 22+)
npx tsc --noEmit -p workers/watchdog/tsconfig.json
cd workers/watchdog && npx wrangler deploy
```
