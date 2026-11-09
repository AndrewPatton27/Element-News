# Cloud cutover runbook

Moves ingestion from the laptop (Windows tasks `ElementIngest`, `ElementBriefSummary`) to the Supabase Edge Functions scheduled by pg_cron. Nothing here is applied by the repo; each step is run by hand. Project ref used below: `mzfpelilxpbpcgskppxu` (replace if different). Type secret values in the terminal or dashboard only; never put them in a file.

Keep the laptop tasks running for the whole procedure until the comparison passes (section 5).

## 0. Before you start

- `supabase login` once; run all commands from the repo root. Check what is already applied: `select * from supabase_migrations.schema_migrations order by version;` if the CLI tracks it, otherwise look for the objects (`select to_regclass('core.ai_caps');`).
- Already applied in the cloud (per the project notes): migrations up to `20261019050000_cron_schedule.sql`, the two Vault secrets `element_functions_url` and `element_service_key`, and the 10 cron jobs. Confirm with `select jobname, schedule from cron.job order by jobname;`.
- FRED check for the finance migration: open each series page for DGS3MO, DGS5, DGS30, EFFR, DFEDTARU, DFEDTARL and confirm the notes carry no "Copyright" line. Delete a row from `20261111000000_finance_sources_cron.sql` (and from `macroSeries` in `ingest/src/config.ts`) if one does.

## 1. Apply pending migrations, in this order

Paste each file in the SQL editor (or `supabase db push`). Each is re-runnable. Stop on the first error.

| Step | File | Why this position |
|---|---|---|
| 1 | `migrations/20261109000000_ranking_v2.sql` | Now present on the release branch: apply it (ships OFF, `foryou_ml_mode` stays 0). |
| 2 | `migrations/20261110000000_watchdog.sql` | **Must come before the functions are redeployed.** It drops the 2-argument `api.ai_usage_take(text, int)` and creates the 3-argument `api.ai_usage_take(text, int, boolean)`, adds `core.ai_caps`, `api.run_start`, the new `api.log_run`, `api.feed_status`, `api.ops_status`. The new function code calls these; the old code calls the old signature. Needs `ai_usage` and `run_log` migrations first (applied). |
| 3 | `migrations/20261111000000_finance_sources_cron.sql` | Widens the `ingest.run_log.source` check to `treasury`, `fedspeech`, `secpress`, adds the series, and schedules three cron jobs. Needs `20261017010000_more_series.sql` (the `in_numbers` column) and the cron migration. Its jobs call functions that do not know the new sources until step 5 deploys, so deploy right after (a failed early call is only a logged error). |
| 4 | `migrations/20261112000000_ranking_v3.sql` | Needs step 1 (reuses its `core.card_features` and tag tables). Ships OFF: `foryou_ml_mode` stays 0, so nothing about the feed changes. Mode 3 (v3 live) is a separate decision after the release is verified. Also recreates the v2 feed wrapper with a working statement-timeout fallback. |
| 5 | `migrations/20261113000000_seen_exclusion.sql` | Needs step 4 (copies the v5/v6/v7 and Trending/Latest bodies on top of it, so it must come last). **Goes live as soon as it runs**: signed-in readers stop seeing cards they already viewed on Trending, Latest and For you (`seen_exclude_mode` = 1). To ship it dark, run `update core.rank_params set value = 0 where key = 'seen_exclude_mode';` right after. Creates the index `user_events_view_idx` (a short lock on `core.user_events`; fine at this size). The web app change (device-side list for guests, the "all caught up" pill) must be deployed with or after it; an older app simply ignores the new `seen_from` field. Check: `supabase/tests/seen_exclusion_check.sql`. Rollback: set `seen_exclude_mode` to 0 (the old behaviour, no redeploy). |
| 6 | `migrations/20261114000000_search_v5.sql` | Replaces only `api.search` (same signature). Live as soon as it runs; an older app needs no change. Check: `supabase/tests/search_v5_check.sql`. |
| 7 | `migrations/20261115000000_companies.sql` | Company directory, card tags (`core.card_companies`, backfills the last 365 days), `api.search_companies`, `api.company_cards`, `api.companies_directory`, `api.card_companies`. Apply before deploying the app that shows company rows, chips and pages. Check: `supabase/tests/companies_check.sql`. |
| 8 | `migrations/20261115000100_search_company_boost.sql` | Needs steps 6 and 7: recreates `api.search` from v5 plus the company-cards-first tier. Must come after both. Check: `supabase/tests/search_company_boost_check.sql`. Rollback: re-run step 6's file. |
| 9 | `migrations/20261116000000_macro_focus.sql` | Run after step 5, and after the search (20261114000000) and companies (20261115000000) migrations if those are applied: it wraps whatever `core.feed_top` / `core.feed_for_you_v5/v6/v7` / `core.seen_tail` are installed. **Goes live as soon as it runs**: the new weights and score recompute, non-material recalls out of Trending / Latest / For you (verdicts for existing recalls come from the card text, backfilled in the same run), and at most 1 recall or science card in any 10. The ingest functions must be redeployed for new recalls to get a verdict (`api.set_card_material`); until then a new recall has no verdict and stays out of the feeds (Safety chip only). Re-run this file after any later migration that recreates one of the wrapped functions. Check: `select api.macro_share();` (block 9 of `tests/cutover_compare.sql`; target top 10 >= 0.8, top 50 >= 0.85). Rollback without redeploy: `update core.rank_params set value = 1 where key = 'micro_category:safety';` (gate off) and `... value = 10 where key = 'micro_max_per_10';` (cap off). Weights: set them back in `core.rank_event_weights`, then `select core.refresh_all_ranks();`. |
| 10 | `migrations/20261117000000_v3_extra_cold.sql` | Needs step 4. Sets `v3_step_extra_cold` to 1 (Drew's decision: the extra topic step also for cold readers). Changes nothing readers see while `foryou_ml_mode` stays 0 (v3 OFF); it does not touch the mode. Check: `supabase/tests/ranking_v3_check.sql`. Rollback: `update core.rank_params set value = 0 where key = 'v3_step_extra_cold';`. |

Checks after the steps:

```sql
select proname, pronargs from pg_proc where proname in ('ai_usage_take','run_start','log_run','feed_status','ops_status');  -- ai_usage_take: 3 args only
select * from core.ai_caps;                                                   -- gemini 500/10, groq 74/5
select jobname, schedule from cron.job where jobname like 'element-%' order by jobname;   -- 13 jobs after step 3
```

## 2. Vault secrets (SQL editor, run once)

Already created: `element_functions_url`, `element_service_key` (the service-role key or the same value as `CRON_SECRET`). New:

```sql
select vault.create_secret('<long random string, 24+ chars>', 'element_watchdog_token');
```

The same value goes into the watchdog Worker as `WATCHDOG_TOKEN` (`workers/watchdog/watchdog.md`). Verify without printing it: `select count(*) from vault.decrypted_secrets where name = 'element_watchdog_token';` returns 1.

## 3. Function secrets (set by name)

```
supabase secrets set --project-ref mzfpelilxpbpcgskppxu SEC_USER_AGENT="Element <real contact email>"
supabase secrets set --project-ref mzfpelilxpbpcgskppxu CRON_SECRET=<24+ random chars, same value as the Worker's CRON_SECRET>
supabase secrets set --project-ref mzfpelilxpbpcgskppxu GEMINI_API_KEY=... GROQ_API_KEY=... FRED_API_KEY=...
supabase secrets set --project-ref mzfpelilxpbpcgskppxu REPORT_CARD_PROTOCOL=1
supabase secrets list --project-ref mzfpelilxpbpcgskppxu     # names only
```

- `SEC_USER_AGENT` must look like `Element name@email`. A missing or malformed value makes `sec` and `wiki` fail every run ("SEC_USER_AGENT is not set"); this is the known cloud failure to fix first.
- `REPORT_CARD_PROTOCOL` is a decision. The laptop runs with `1` (Groq scores each AI card before publishing), so `1` gives parity. Cost: the scorer spends from the shared Groq cap (74/day) and the cap can run out in about two runs; once it does, AI cards are skipped (`report_card_unscored`). Decide before the comparison: `1` with the code change that moves the scorer off Groq, or `1` and accept the starvation, or leave unset (no scoring, more cards, less checking). Record the decision; comparing runs with different settings proves nothing.
- `CRON_SECRET` is not a JWT, so deploy with `--no-verify-jwt` (next step).

## 4. Deploy the functions

```
supabase functions deploy ingest-source --no-verify-jwt --project-ref mzfpelilxpbpcgskppxu
supabase functions deploy brief-summary --no-verify-jwt --project-ref mzfpelilxpbpcgskppxu
```

If the bundler cannot read files outside `supabase/functions`, follow the `_vendor` note in `functions/functions.md`.

Smoke test, one source at a time (read `error` and `stopped_by`; HTTP 546 means the CPU limit was hit):

```
curl -i -X POST https://mzfpelilxpbpcgskppxu.supabase.co/functions/v1/ingest-source -H "Authorization: Bearer <CRON_SECRET or service key>" -H "Content-Type: application/json" -d "{\"source\":\"sec\"}"
```

Repeat for `wiki`, `fed`, `treasury`, `fedspeech`, `secpress`. Then confirm a row appears: `select source, ok_runs from (select source, count(*) filter (where error is null) ok_runs from ingest.run_log group by source) t;` or just run block 2 of `tests/cutover_compare.sql`. Run the watchdog check: `select api.feed_status();`.

## 5. 24-hour side-by-side

Run laptop and cloud together for 24 hours. Do not disable anything. Cloud runs write `ingest.run_log`; laptop runs write `ingest/logs/run.log` (read its run lines). Both publish into the same `core.blurbs`, so duplicates between them are caught by the same-URL dedupe and show up in the report.

At the end, run `supabase/tests/cutover_compare.sql` in the SQL editor (read-only; blocks 1-8), and read the laptop log for the same window (published, skipped, ai totals per run).

Pass criteria, all required:

1. `sec` and `wiki` are `ok_runs = runs` every hour (block 2), no HTTP 546 / WORKER_LIMIT in any smoke test or `cron.job_run_details` (`select jobname, status, return_message from cron.job_run_details order by start_time desc limit 50;`).
2. Cloud cards published are at least 80% of what the laptop log shows for the same 24 hours (block 3 sum versus laptop `published`).
3. No duplicates: blocks 5a, 5b and 5c return no rows.
4. No hung or killed runs (block 6) beyond explained one-offs.
5. AI use (block 4) stays under the caps and the Groq cap is not exhausted before the evening; `core.ai_usage` agrees with the laptop `ai` totals plus cloud `ai_calls`.
6. Every source that publishes on the laptop has a recent row in block 7 (no stale source).
7. `ops_status` shows no hung runs and no `model_missing`.

Fail on any item: fix, then restart the 24 hours.

## 6. Rollback

Fastest to slowest; the laptop tasks are still enabled until step 7 so feed output continues anyway.

1. Stop the cloud schedule, keeping all data:
   ```sql
   select cron.unschedule(jobname) from cron.job where jobname like 'element-%';
   ```
   (Or one job: `select cron.unschedule('element-ingest-sec');`.) Re-create them by re-applying `20261019050000_cron_schedule.sql` and `20261111000000_finance_sources_cron.sql`.
2. Stop the Edge Functions from acting without a caller: `supabase functions delete ingest-source --project-ref mzfpelilxpbpcgskppxu` (same for `brief-summary`). Redeploy later with the commands in section 4.
3. Restore the AI counter if a bad deploy burned it: `update core.ai_usage set calls = 0 where day = (now() at time zone 'utc')::date;` (or lower a cap: `update core.ai_caps set cap = 40 where provider = 'groq';`).
4. Migrations are not rolled back (all are additive or re-runnable, the old 2-argument `ai_usage_take` stays dropped). The laptop `ingest/` code calls neither it nor the new functions, so it is unaffected. If you must restore the old function: `create or replace function api.ai_usage_take(p_provider text, p_cap int) ...` from `20261019040000_ai_usage.sql`, then redeploy the old function code.

## 7. Final laptop shutdown (only after section 5 passes)

In an elevated PowerShell, or Task Scheduler (Task Scheduler Library):

```
schtasks /Query /TN ElementIngest /V /FO LIST
schtasks /Change /TN ElementIngest /DISABLE
schtasks /Change /TN ElementBriefSummary /DISABLE
schtasks /Query /TN ElementIngest /FO LIST | findstr Status
```

Status must read `Disabled` for both. Disable, do not delete, for a week: re-enable with `schtasks /Change /TN ElementIngest /ENABLE`. Leave `run-ingest.cmd` in place. Watch the watchdog (`api.feed_status`, GitHub issues) for 48 hours; if it alerts and the cause is not obvious, re-enable the tasks first, investigate second.
