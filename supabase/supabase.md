# supabase

The Postgres database behind Element (Supabase free tier). The SQL files here are the only source of truth for the schema. The ingest script (`ingest/`) writes through service-role RPCs. It runs on a laptop today; the cloud version (Edge Functions `brief-summary` and `ingest-source`, scheduled by pg_cron) is in `functions/` (see `functions/functions.md`), written but not deployed.

## Schemas

| Schema | Exposed? | What is in it |
|---|---|---|
| `ingest` | no | raw collected items (`ingest.items`) |
| `core` | no | published cards and their sources, macro numbers, ranking settings, app config, categories, user prefs and events; `core.story_links` stores update/angle/related pairs (RLS enabled, no client policies) |
| `api` | **yes, the only one** | views and functions the app and the ingest script call |

Row-level security is on for every table. The app never reads `core` or `ingest` directly; everything goes through `api`.

## Migrations (`migrations/`, run in this order)

| File | What it does |
|---|---|
| `20261017000000_init.sql` | Schemas, tables, constraints, row-level security and privileges. Ranking (`core.refresh_rank`: importance × recency, half-life 8 h). `api.feed` (modes `top`/`latest`, keyset paging), `api.numbers_to_know`, `api.app_config`, `api.categories`. Service-role-only RPCs `api.upsert_item`, `api.set_item_status`, `api.publish_blurb` (at least 1 source, per-ticker cap, URL dedupe), `api.upsert_macro`. Seed data: categories, ranking weights, macro series, app config with the disclaimer and the FRED notice. |
| `20261017010000_more_series.sql` | Six more FRED series (gas price, jobless claims, retail sales, housing starts, payrolls, GDP growth) and an `in_numbers` flag that picks the series shown in the numbers panel. |
| `20261017020000_broad_topics.sql` | Categories World, Science & Space and Recalls & Safety; plainer names (Government, Money, Business); the `cc_by_sa` license class and its notice; weights for the new event types; `api.categories` lists only categories that have published cards. |
| `20261017030000_accounts.sql` | Signed-in users: `core.user_prefs`, `core.user_events` (row-level security, owner-only policies) and functions for the `authenticated` role only: `api.get_prefs`, `api.set_prefs`, `api.track`, `api.feed_for_you` (personal ranking), `api.delete_my_data`. |
| `20261017040000_account_delete.sql` | `api.delete_account()`: a signed-in user deletes their own login; their prefs and events go with it. |
| `20261017050000_detail_revise.sql` | In-depth summary (`core.blurbs.detail`) returned by the feeds; service-role RPCs for rewriting older cards in place. |
| `20261017060000_signals.sql` | Reading signals for For you: event kinds `open_detail` and `dwell` (with `dwell_ms`), `api.track(p_blurb, p_kind, p_ms)` (2-key calls still work), signal weights in `core.rank_params`, learned topic affinity per user, and a "seen" penalty for cards already read. |
| `20261017070000_trending_foryou.sql` | Trending (`api.feed` mode `top`: rank plus a capped engagement boost from counts of distinct readers, `core.trend_generations` / `core.trend_boosts`, service-role `api.refresh_trending`), For you v2 (follows, learned affinity that fades over time, exploration, seen penalties), `api.my_categories`, hidden sources (`core.source_keys`, `api.sources()`, `hidden_sources` in `api.set_prefs` / `api.get_prefs`), and one card shape for every feed (`core.cards_json`). |
| `20261017071000_diversity_patch.sql` | Keeps Trending and For you varied: replaces `core.diversify` (no 3rd card in a row from one category, no repeated story type, ticker or source cluster next to each other, at most 2 per source in any 5), with carry-over of held-back cards in the cursor. Recreates `api.feed` and `api.feed_for_you`. |
| `20261017080000_collab.sql` | For you v3: personal affinity per topic, card type and source (shrunk toward zero when there are few signals), "readers who engaged with X also engaged with Y" tables built from aggregate counts of at least 3 different readers (no user ids), a smoothed engagement rate in Trending boosts (extends `core.refresh_trending`), crowd topic hints for users with few signals, and a recreated `api.feed_for_you`. `api.feed` is not recreated. Checked by `tests/collab_check.sql`. |
| `20261017090000_web_side_column.sql` | Web right column: `api.top_stories()` (5 best cards of the last 7 days by rank plus Trending boost, skipping repeats of the same headline, company ticker or data series) and `api.number_trends()` (10-yr Treasury, CPI, unemployment, WTI crude: display value, weekly change text, 12-point history). Read-only RPCs, no user data. NOT yet applied. |
| `20261018000000_brief_search_follow.sql` | Search with full-text and short-query fallback, related cards, relevance-ranked Following with reasons, daily and weekly briefs. Read-only RPCs; requires the 090000 web column migration. NOT applied. |
| `20261018020000_search_v2.sql` | Search v2: `api.search` (same signature and shape) finds cards matching ANY query word (max 6, stopwords dropped) by english stem/prefix, a curated synonym (`core.search_synonyms`, 10 groups), a typo (`core.search_typo_ok`: pg_trgm similarity >= 0.4 if pg_trgm is installed, else edit distance <= 1, <= 2 from 8 letters; words of 5+ letters) or exact ticker/series id, across headline, body, detail, tickers, source names, category, event type and macro series. Ordered by the Trending key (rank_score + trend boost) + log2(1.3) half-lives per extra matched word + the small signed-in boost; ties importance, newest, id. Cursor `key|id|asof|gen|importance|sort_at`. Scans at most 2000 cards. Tries `create extension pg_trgm` (skipped with a notice if unavailable). NOT applied. |
  | `20261018050000_search_v3.sql` | Search v3 replaces only `api.search`: best per-term quality (exact 1.0, stem/prefix 0.8, synonym 0.6, typo 0.5, exact whole-word metadata 0.25), drops total quality below 0.5, excludes broad `energy`/`safety` synonym bridges and disambiguates Fed from Federal Aviation/Register. Trending score is multiplied by `0.5 + quality / term_count`, with the existing multi-term and personal boosts; cursor, one-story dedupe, 2000 cap, signature/shape, grants and security are retained. |
| `20261018030000_brief_depth.sql` | Brief depth: `api.daily_brief` / `api.weekly_brief` (same shape, fields only added) return a section for every topic with cards (max 8, most important first); top 3 topics 6 stories daily / 8 weekly, ranks 4-5 three, ranks 6-8 two; each section adds `slug`, `rank`, `total` (for "See all N"). Daily window 24 h, 48 h if under 12 cards, 72 h if under 12 in 48 h. Adds private helpers `core.brief_supply`, `core.brief_build`. NOT applied. |
| `20261018040000_brief_email.sql` | Private email subscriptions, suppression/rate-limit rows and daily/weekly summaries. Public double-opt-in, manage and unsubscribe RPCs; service-role-only summary and mail queue RPCs. Adds `summary` and a separate `markets` block to daily/weekly Brief JSON and removes market categories from topic sections. Offline fixture: `tests/brief_email_check.sql`. NOT applied. |
| `20261018060000_story_links.sql` | Private `core.story_links` pairs (update/angle/related), service-role-only `api.set_story_link`, linked stories ahead of overlap matches in `api.related_cards`, and linked update/angle boosts plus follow reasons in `api.following_feed`. `tests/story_links_check.sql` covers ordering, reason labels, anon denial and idempotency. Not applied. |
| `20261019010000_ml_shadow.sql` | ML shadow logging, signed-in readers only, shipped OFF (`foryou_ml_mode` = `trending_ml_mode` = 0; only modes 0 and 1 exist, any other value acts as 1). Private `core.ml_pages` (card ids and server order per For you / Trending page, max 60 cards, 60 pages per reader per hour), `core.ml_shadow`, `core.ml_runs`, `core.ml_appeal` (RLS on, no policies). `core.feed_top` and `core.feed_for_you_v5` are unchanged copies of the latest `api.feed` / `api.feed_for_you` bodies; `api.feed` and `api.feed_for_you` are now thin volatile wrappers with the same signatures, grants and items, which add trailing cursor fields (For you `...|carry|ml_run|page_no|mode`, Trending `...|carry|page_no|mode`; old cursors still work) and, when a mode is on, log the page and return `page_id` (a failed log never breaks the feed; guests are never logged). `api.following_feed` falls back to `core.feed_top`. `api.track(p_blurb, p_kind, p_ms, p_page, p_slot, p_surface)` stores a view's page, displayed slot and surface only while a mode is on. `api.delete_my_data` / `api.delete_account` also remove page records (same return shapes). Service-role `api.ml_export` (paged, 5,000 rows max, `next` key), `api.ml_begin_run`, `api.ml_write_shadow`, `api.ml_write_appeal`, `api.ml_finish_run`, `api.ml_purge` (pages after `ml_log_retention_days` 21, runs beyond `ml_keep_runs` 3, events only when `ml_purge_events_days` > 0, which ships at 0; sets both modes to 0 when the database is over `ml_db_stop_mb` 400). Checked by `tests/ml_shadow_check.sql`. |
| `20261019040000_ai_usage.sql` | Private `core.ai_usage(day, provider, calls)` (UTC days) and service-role `api.ai_usage_take(p_provider, p_cap)` (atomic +1 only while under the cap; true/false) and `api.ai_usage_get(p_day)` (`{provider: calls}`), so the Gemini and Groq daily caps hold across Edge Function runs. Rows older than 60 days are removed. Checked by `tests/ai_usage_run_log_check.sql`. NOT applied. |
| `20261019041000_run_log.sql` | Private `ingest.run_log` (one row per Edge Function call: source, times, items_new, published, skipped, failed, ai_calls, error, detail JSON) and service-role `api.log_run(p jsonb)`; rows older than 30 days are removed. NOT applied. |
| `20261019050000_cron_schedule.sql` | Enables `pg_cron` and `pg_net`; private `core.invoke_function(name, body)` reads the function URL and the service key from Vault (`element_functions_url`, `element_service_key`, created by hand; never in SQL files) and POSTs to the function; schedules `brief-summary` at 10:30 UTC and each ingest source hourly at :03/:09/:15/:21/:27/:39/:45/:51/:57. Unschedules by name first (re-runnable). Does not run in PGlite (no pg_cron/pg_net); offline harnesses must skip it. NOT applied. |

Every migration is written to be re-runnable (`if not exists`, `create or replace`, `on conflict`).

## Tests (`tests/`)

| File | What it checks | Expected last line |
|---|---|---|
| `ranking_check.sql` | Ranking order, paging, hidden cards, publish rules (part 1); anon privileges (part 2); optional curl check (part 3). Run part 1 and part 2 separately. | `ERROR: ALL CHECKS PASSED (test data rolled back on purpose)` |
| `accounts_check.sql` | Anon cannot call the account functions; user A cannot see or change user B's data; For you boosts followed topics, drops hidden topics and disliked cards, pages without repeats; delete my data. | `ERROR: ALL ACCOUNT CHECKS PASSED (test data rolled back on purpose)` |
| `account_delete_check.sql` | Anon cannot delete; a user can delete only their own login; their data goes with it; other users are untouched. | `ERROR: ALL ACCOUNT DELETE CHECKS PASSED (test data rolled back on purpose)` |
| `signals_check.sql` | Dwell minimum, dedupe and keep-the-longest; quick skips lower a topic, opening the detail raises it; per-card and per-topic caps; the "seen" penalty; old 2-key `track` calls still work; anon denied. | `ERROR: ALL SIGNAL CHECKS PASSED (test data rolled back on purpose)` |
| `trending_check.sql` | Trending boost and Latest order, hidden topics, For you v2 (needs the two test users, like the account tests). | `ERROR: ALL TRENDING CHECKS PASSED (test data rolled back on purpose)` |
| `collab_check.sql` | Crowd tables are private; no crowd = same order as before; card links and topic hints need at least 3 different readers; a new user gets crowd-informed picks; a like pulls up a card other readers also liked; importance still wins; For you pages never repeat across a refresh; old calls and card keys unchanged; deleted data leaves the aggregates. Needs the two test users; creates six more test users inside the block (rolled back). | `ERROR: ALL COLLAB CHECKS PASSED (test data rolled back on purpose)` |
| `web_column_check.sql` | `api.top_stories` (max 5, 7 days, no repeats) and `api.number_trends` (12 points oldest first, change text, monthly series). | `ERROR: ALL WEB COLUMN CHECKS PASSED (test data rolled back on purpose)` |
| `brief_search_follow_check.sql` | Search ticker fallback and paging, related ticker matches, Following reasons and empty-list fallback, brief shapes and limits, RPC grants. | `ERROR: ALL BRIEF SEARCH FOLLOW CHECKS PASSED (test rows rolled back on purpose)` |
| `search_v2_check.sql` | Search v2: 'fed rate' finds Fed and rate cards in Trending order with the extra-word bonus; typo, prefix, stem, synonym, ticker, series id, detail and source-name matches; hidden/source-less cards never; empty, 1-char, stopword-only and no-match queries; paging without repeats; a trend boost reorders; grants; timing over 400 extra cards (in the pass message). | `ERROR: ALL SEARCH V2 CHECKS PASSED (typo mode ..., ... ms) (test rows rolled back on purpose)` |
  | `search_v3_check.sql` | Quality gates retain Fed/rate and typo matches, block Federal Register prefix false positives, and verify metadata whole-word matching and cursor paging. | `ERROR: ALL SEARCH V3 CHECKS PASSED (test rows rolled back on purpose)` |
| `brief_depth_check.sql` | 10 topics with 9..1 cards: 8 sections, rank/total/slug, 6/6/6/3/3/2/2/2 daily and 8/8/7/3/3/2/2/2 weekly, best-card topic order, 3 headlines from 3 topics, 24/48/72 h widening, empty window, grants and security definer. | `ERROR: ALL BRIEF DEPTH CHECKS PASSED (test rows rolled back on purpose) sections=[...]` |
| `brief_email_check.sql` | Address validation, constant pending response, confirmation/update/unsubscribe and suppression, local send-hour queue, private table/service RPC access, and additive Brief JSON shape. | `ERROR: ALL BRIEF EMAIL CHECKS PASSED (test rows rolled back on purpose)` |
| `story_links_check.sql` | Linked updates/angles rank ahead of plain related cards in Following and related results; exact follow reasons; anon cannot execute `set_story_link`; repeat save updates one row idempotently. | `ERROR: ALL STORY LINK CHECKS PASSED (test rows rolled back on purpose)` |
| `ml_shadow_check.sql` | Modes ship at 0; ML tables and RPCs closed to anon/authenticated (42501); wrappers return exactly the core output in modes 0, 1 and 2; one page row per signed-in page, none for guests, Latest or topic pages; new and old cursors; a failing log insert still returns the page; 60-page cap and 60-card limit; `api.track` positions only in mode >= 1; paged export; shadow/appeal writes; purge after 21 days, runs beyond 3, events only when switched on; storage stop rule; deletion. | `ERROR: ALL ML_SHADOW CHECKS PASSED (test data rolled back on purpose)` |
| `ai_usage_run_log_check.sql` | AI usage take stops exactly at the cap (cap 0 refuses), today's counts, old-row purge, bad input; run-log insert, defaults, 30-day purge, unknown source and negative counts refused; service role only, RLS on, security definer with empty search_path. | `ERROR: ALL AI_USAGE RUN_LOG CHECKS PASSED (test rows rolled back on purpose)` |

Each test ends with a deliberate error so that all test rows are rolled back. The account tests need two test users, `element-test-a@example.com` and `element-test-b@example.com` (Authentication → Users → Add user, "Auto Confirm User"); delete them afterwards. They simulate a signed-in user by switching to the `authenticated` role and setting `request.jwt.claims`, which is what `auth.uid()` reads.

## Maintenance (`maintenance/`)

One-off data fixes for a live project, not migrations (`maintenance/hide_offtopic_2026-10-17.sql`, described in `maintenance/maintenance.md`).

## Setting up a new project (paste order)

1. Create a Supabase project. In **Project Settings → Data API → Exposed schemas**, set `api` only.
2. In the SQL editor, paste and run each migration in the order above. Each should report "Success. No rows returned".
3. Run `tests/ranking_check.sql` (part 1, then part 2).
4. Create the two test users, run `tests/accounts_check.sql`, `tests/account_delete_check.sql`, `tests/signals_check.sql`, `tests/trending_check.sql` and `tests/collab_check.sql` and `tests/web_column_check.sql` (no test users needed), then delete the test users.
5. Set the dashboard-only settings below.

## Settings that live only in the dashboard

These are not in SQL; set them by hand in every project.

| Where | Setting |
|---|---|
| Project Settings → Data API | Exposed schemas: `api` only |
| Project Settings → API Keys | The app uses the **publishable** key only. The secret (service-role) key is only for the ingest script's `.env` and never goes in app code. |
| Authentication → Sign In / Providers → Email | Email provider on; "Confirm email" (off for the demo, on with custom SMTP later); minimum password length 8 |
| Authentication → URL Configuration | Site URL and Redirect URLs (the local dev URL and the deployed web URL), used by password-reset links |
| Authentication → Rate Limits | Supabase defaults |

Tunable ranking and account values (half-life, weights, For you boosts, tracking limits) are rows in `core.rank_params` and `core.rank_event_weights`; change them with `update`.
