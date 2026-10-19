# supabase/functions

Supabase Edge Functions (Deno) that run Element's scheduled work in the cloud instead of on a laptop.
pg_cron calls them through pg_net (`supabase/migrations/20261019050000_cron_schedule.sql`). They reuse the
ingest code in `ingest/src` unchanged; everything the cloud needs on top (database AI counter, time budget,
run log, caller check) is in `_shared/`.

Free-tier limits per call: 2 s CPU, 150 s wall clock, 256 MB memory. Waiting for the network does not
count as CPU.

## Functions

| Function | What it does | Body (JSON) | Schedule |
|---|---|---|---|
| `brief-summary` | The AI summary at the top of the daily and weekly Brief, once per period (`ingest/src/briefSummary.ts`): reads `api.daily_brief` / `api.weekly_brief`, skips a period that already has its summary, Gemini then Groq then a template, each AI draft validated (numbers in the brief, copy limit, no advice words, length), writes with `api.put_brief_summary`. | `{"kind":"daily"\|"weekly"\|"both"}` (default both), optional `"force":true`, `"dry_run":true` (writes nothing), `"no_ai":true` | 10:30 UTC daily |
| `ingest-source` | ONE ingest source per call: `macro`, `fed`, `bea`, `fedreg`, `sec`, `wiki`, `cpsc`, `usgs` or `nasa`. Runs `runOnce({ only: [source] })` from `ingest/src/pipeline.ts`: allowlisted fetchers and parsers, topic filter, license gate, Gemini then Groq then template with the validator, the report-card scorer when `REPORT_CARD_PROTOCOL=1`, publishing through the service-role RPCs. | `{"source":"fed"}`, optional `"work_cap":1-20` (default 5), `"finish":true` (afterwards refresh Trending and purge old ML rows) | each source once an hour, 6 minutes apart |

Each call writes one row to `ingest.run_log` (`api.log_run`) and returns the same summary as JSON:
`source, ok, started_at, finished_at, duration_ms, items_new, published, skipped, failed, ai_calls,
deferred, stopped_by ('done'|'time'|'work_cap'|'error'), error, stats, ai_denied, log_tail` (the last 40 log
lines; never keys or source text).

### Limits inside one call (`_shared/budget.ts`, `_shared/usage.ts`)

- **Work cap:** at most `work_cap` (5) new items per call. Items over the cap are not recorded, so the next
  call picks them up.
- **Time budget:** no new item starts after 100 s; no AI call starts if its pacing wait plus the 20 s
  request timeout would end after 140 s (the chain then falls back to the next provider or the template,
  as after a 429); no network request starts after 140 s.
- **AI caps across runs:** every real AI call first takes one unit from `core.ai_usage` with the atomic
  `api.ai_usage_take(provider, cap)` (Gemini 500/day, Groq 74/day, from `ingest/src/config.ts`; UTC days).
  At the cap, or if the counter cannot be read, no AI call is made. The Groq report-card scorer counts
  against Groq too. Gemini pacing (5 s) and Groq pacing (30 s) apply within a call.
- **Caller check:** the `Authorization: Bearer` token must equal the project's service-role key
  (`SUPABASE_SERVICE_ROLE_KEY`); anything else gets HTTP 401.

## Files

| File | What it is |
|---|---|
| `brief-summary/index.ts`, `ingest-source/index.ts` | Deno entry points (`Deno.serve`): caller check, options, call the handler. |
| `brief-summary/handler.ts`, `ingest-source/handler.ts` | The logic, with every dependency injectable (tested in Node). |
| `_shared/ingest.ts` | The only file that imports `ingest/src` (relative paths). |
| `_shared/usage.ts` | Database AI counter (`api.ai_usage_take` / `api.ai_usage_get`) and the provider wrappers. |
| `_shared/budget.ts` | Time budget, work cap (publisher wrapper), fetch guard. |
| `_shared/runSummary.ts` | Run summary JSON and the `api.log_run` payload. |
| `_shared/env.ts` | Environment, caller check, request options. |
| `_shared/rpc.ts` | Service-role PostgREST client (through the ingest allowlist). |
| `**/*.test.ts` | Offline Node tests (no Deno, no network, no keys). |
| `package.json`, `tsconfig.json` | Mark the folder as ES modules for the Node tests and type check. No npm dependencies. |

## Environment

Supabase injects `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` into every Edge
Function. Secret names starting with `SUPABASE_` cannot be set by hand, and they do not need to be.

Custom secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):

| Name | Needed by | Without it |
|---|---|---|
| `GEMINI_API_KEY` | both | Gemini is skipped (Groq, then the template) |
| `GROQ_API_KEY` | both | Groq is skipped; the report-card scorer is off |
| `FRED_API_KEY` | `ingest-source` macro | macro numbers are skipped |
| `SEC_USER_AGENT` | `ingest-source` sec and wiki (`"Element <contact email>"`) | those sources fail with a clear error |
| `REPORT_CARD_PROTOCOL` | `ingest-source`, optional | `1` = Groq scores each AI card before publishing (as in `ingest/run-ingest.cmd`) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `MAIL_POSTAL_LINE` | later (brief email), not used yet | |

```
supabase secrets set --project-ref mzfpelilxpbpcgskppxu GEMINI_API_KEY=... GROQ_API_KEY=... FRED_API_KEY=... SEC_USER_AGENT="Element you@example.com" REPORT_CARD_PROTOCOL=1
```

Type the values in the terminal only; never put them in a file in the repo.

## Commands

```
npm run test:functions                                   # offline tests (Node 22+)
npx tsc --noEmit -p supabase/functions/tsconfig.json     # type check (functions + the ingest code they import)
```

### Deploy (Supabase CLI, from the repo root)

```
supabase functions deploy brief-summary --project-ref mzfpelilxpbpcgskppxu
supabase functions deploy ingest-source --project-ref mzfpelilxpbpcgskppxu
```

The functions import `ingest/src` by relative path. If the deploy reports that it cannot read files
outside `supabase/functions`, copy `ingest/src` (without `fixtures/`) and `contract/types.ts` into
`supabase/functions/_vendor/` keeping the same relative layout, and change the paths in
`_shared/ingest.ts` only.

Run one call by hand (key typed in the terminal, not saved):

```
curl -X POST https://mzfpelilxpbpcgskppxu.supabase.co/functions/v1/ingest-source -H "Authorization: Bearer <service_role key>" -H "Content-Type: application/json" -d "{\"source\":\"usgs\"}"
curl -X POST https://mzfpelilxpbpcgskppxu.supabase.co/functions/v1/brief-summary -H "Authorization: Bearer <service_role key>" -H "Content-Type: application/json" -d "{\"kind\":\"daily\",\"dry_run\":true}"
```

### Schedule

Apply, in order, `20261019040000_ai_usage.sql`, `20261019041000_run_log.sql`, then create the two Vault
secrets described at the top of `20261019050000_cron_schedule.sql` (`element_functions_url`,
`element_service_key`) and apply that file. Read results with
`select * from ingest.run_log order by started_at desc limit 20;`.

## Not tested offline

Deno itself, the deploy bundler (relative imports outside `supabase/functions`), the real CPU and wall time
per call (the SEC source parses about 170 company filing lists and is the most likely to approach 2 s CPU),
pg_cron, pg_net and Vault on Supabase.
