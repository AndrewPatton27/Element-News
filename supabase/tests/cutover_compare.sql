-- Cloud cutover comparison report. READ-ONLY: select statements only, no writes, safe to re-run.
-- Run in the Supabase SQL editor (as the postgres role) after the watchdog migration
-- (20261110000000_watchdog.sql) is applied. Each numbered block is one query: select a block and run it,
-- or run the file and open each result tab. Window: the last 24 hours (change the interval in one place per block).
-- Needs ingest.run_log, core.ai_usage and core.ai_caps. See supabase/CUTOVER.md for the pass criteria.
-- Offline check: it parses and runs in PGlite with the migrations applied (empty tables return no rows).

-- 1. Cards published per hour per source (every card, whoever published it: cloud or laptop).
--    Source is the ingest item's source; macro/data cards have no item, so they show as 'data_card'.
select date_trunc('hour', b.published_at) as hour,
       coalesce(i.source, case when b.kind = 'data' then 'data_card' else 'unknown' end) as source,
       count(*) as cards
  from core.blurbs b
  left join ingest.items i on i.blurb_id = b.id
 where b.status = 'published' and b.published_at > now() - interval '24 hours'
 group by 1, 2
 order by 1 desc, 2;

-- 2. Cloud runs per source (ingest.run_log is written only by the Edge Functions): runs, errors, items, cards,
--    skips, AI calls, longest run, and how each run stopped. Pass: sec and wiki have ok_runs = runs.
select source,
       count(*) as runs,
       count(*) filter (where finished_at is not null and error is null) as ok_runs,
       count(*) filter (where error is not null) as error_runs,
       sum(items_new) as items_new,
       sum(published) as published,
       sum(skipped) as skipped,
       sum(failed) as failed,
       sum(ai_calls) as ai_calls,
       round(max(extract(epoch from (finished_at - started_at)))::numeric, 1) as longest_s,
       count(*) filter (where detail ->> 'stopped_by' = 'work_cap') as stopped_work_cap,
       count(*) filter (where detail ->> 'stopped_by' = 'time') as stopped_time
  from ingest.run_log
 where started_at > now() - interval '24 hours'
 group by source
 order by source;

-- 3. Cloud published per hour per source (from run_log: what the functions say they published).
select date_trunc('hour', started_at) as hour, source, sum(published) as published, count(*) as runs
  from ingest.run_log
 where started_at > now() - interval '24 hours'
 group by 1, 2
 order by 1 desc, 2;

-- 4. AI use today and the last 3 days against the caps (caps live in core.ai_caps after the watchdog migration).
select u.day, u.provider, u.calls, c.cap, c.reserve,
       case when c.cap > 0 then round(100.0 * u.calls / c.cap) end as pct_of_cap,
       (c.cap is not null and u.calls >= c.cap) as at_cap
  from core.ai_usage u
  left join core.ai_caps c on c.provider = u.provider
 where u.day >= (now() at time zone 'utc')::date - 2
 order by u.day desc, u.provider;

-- 5. Duplicates. Pass: this returns no rows.
--    5a. one source URL behind more than one published card
select s.url, count(distinct s.blurb_id) as cards, array_agg(distinct s.blurb_id) as blurb_ids
  from core.blurb_sources s
  join core.blurbs b on b.id = s.blurb_id and b.status = 'published'
 where b.published_at > now() - interval '7 days'
 group by s.url
having count(distinct s.blurb_id) > 1;

--    5b. the same headline published more than once in the last 24 hours
select lower(b.headline) as headline, count(*) as cards, min(b.published_at) as first_at, max(b.published_at) as last_at
  from core.blurbs b
 where b.status = 'published' and b.published_at > now() - interval '24 hours'
 group by lower(b.headline)
having count(*) > 1;

--    5c. a ticker with more cards than the cap (3 per 24 hours)
select t ->> 'symbol' as ticker, count(*) as cards
  from core.blurbs b, jsonb_array_elements(b.tickers) t
 where b.status = 'published' and b.kind = 'summary' and b.published_at > now() - interval '24 hours'
 group by 1
having count(*) > 3
 order by 2 desc;

-- 6. Hung or killed runs. Hung = still open after 10 minutes (the next log_run marks it killed).
--    Pass: no rows, or only rows that are explained.
select id, source, started_at, finished_at, error,
       case when finished_at is null then 'hung_open' else 'killed' end as state
  from ingest.run_log
 where started_at > now() - interval '24 hours'
   and ((finished_at is null and started_at < now() - interval '10 minutes') or error like 'killed:%')
 order by started_at desc;

-- 7. Last published time per source, and overall (a source that stopped is a stale row here).
select coalesce(i.source, case when b.kind = 'data' then 'data_card' else 'unknown' end) as source,
       max(b.published_at) as last_published_at,
       round(extract(epoch from (now() - max(b.published_at))) / 3600, 1) as hours_ago
  from core.blurbs b
  left join ingest.items i on i.blurb_id = b.id
 where b.status = 'published'
 group by 1
union all
select '(all)', max(published_at), round(extract(epoch from (now() - max(published_at))) / 3600, 1)
  from core.blurbs where status = 'published'
 order by hours_ago desc nulls last;

-- 8. Cloud run errors, newest first (messages only; no keys or source text are stored).
select started_at, source, left(error, 200) as error
  from ingest.run_log
 where started_at > now() - interval '24 hours' and error is not null and error not like 'killed:%'
 order by started_at desc
 limit 30;

-- 9. Macro/finance focus (needs 20261116000000_macro_focus.sql; skip this block before it is applied).
--    Pass: trending.top10.macro_share >= 0.8 and trending.top50.macro_share >= 0.85; micro <= 1 per 10.
--    gated_14d = recalls in the last 14 days and how many of them are left out of the feeds (not material).
select api.macro_share() as macro_share;

--    9b. recall verdicts by reason (material and left out), last 14 days
select m.material, unnest(m.reasons) as reason, count(*) as cards
  from core.card_material m
  join core.blurbs b on b.id = m.blurb_id
 where b.status = 'published' and b.sort_at > now() - interval '14 days'
 group by 1, 2
 order by 1 desc, 3 desc;
