-- Supply readout (M9 workstream 1). READ-ONLY: select statements only. Run it with
--   node scripts/supply-readout.mjs                 (runs each query below through `supabase db query --remote --read-only`)
-- or paste one query at a time into the Supabase SQL editor. The script splits this file on the "-- name:" lines.
-- Days are US Eastern (America/New_York); market hours are Mon-Fri 09:00-15:59 ET (older queries); the cadence goal queries use the drip window, Mon-Fri 06:00-19:59 ET.
-- "Live" = status 'published' and not superseded. Checked offline on the migrated schema by
-- the readout step of supabase/tests/run-pglite.mjs (npm run test:sql, PGlite), so every query parses and runs.
--
-- Indexes used (supabase/migrations/20261129000000_supply_ops.sql adds the first and the others):
--   core.blurbs  blurbs_published_at_idx (published_at desc) where status = 'published'   for every cards-per-time query
--   ingest.items items_fetched_at_idx (fetched_at desc)                                    for the items-by-status query
--   core.ai_usage primary key (day, provider)                                              for AI usage vs caps
-- Before that migration is applied the same queries run, as a sequential scan of core.blurbs (a few thousand rows).

-- name: cards_per_day_by_source
-- Cards published per ET day for 30 days, by the source of the card's primary link (ingest.items.source when the
-- card came from an item; 'macro' for data cards, which have no item).
select (b.published_at at time zone 'America/New_York')::date as et_day,
       coalesce(i.source, case b.kind when 'data' then 'macro' else 'other' end) as source,
       count(*)::int as cards
  from core.blurbs b
  left join lateral (
    select s.item_id from core.blurb_sources s where s.blurb_id = b.id order by s.is_primary desc, s.position, s.id limit 1
  ) ps on true
  left join ingest.items i on i.id = ps.item_id
 where b.status = 'published' and b.published_at > now() - interval '30 days'
 group by 1, 2
 order by 1 desc, 3 desc;

-- name: cards_per_day_by_category
select (b.published_at at time zone 'America/New_York')::date as et_day, b.category, count(*)::int as cards
  from core.blurbs b
 where b.status = 'published' and b.published_at > now() - interval '30 days'
 group by 1, 2
 order by 1 desc, 3 desc;

-- name: daily_totals_and_median
-- One row per ET day (zero-card days included) and, on the last row, the 30-day median and the proposed
-- target (2 x median, decision D-114).
with days as (
  select d::date as et_day
    from generate_series(((now() at time zone 'America/New_York')::date - 29)::timestamp,
                         (now() at time zone 'America/New_York')::date::timestamp, interval '1 day') d
), per as (
  select days.et_day, count(b.id)::int as cards
    from days
    left join core.blurbs b on b.status = 'published' and b.published_at > now() - interval '31 days'
                           and (b.published_at at time zone 'America/New_York')::date = days.et_day
   group by days.et_day
)
select to_char(et_day, 'YYYY-MM-DD') as et_day, cards, null::numeric as median_30d, null::numeric as target_2x
  from per
union all
select 'MEDIAN', null, percentile_cont(0.5) within group (order by cards)::numeric,
       2 * percentile_cont(0.5) within group (order by cards)::numeric
  from per
 order by 1 desc;

-- name: market_hour_gaps_14d
-- Market hours (Mon-Fri 09:00-15:59 ET) of the last 14 days with their card count; zero rows are the gaps.
with hrs as (
  select h as hour_et
    from generate_series(date_trunc('hour', (now() at time zone 'America/New_York') - interval '14 days'),
                         date_trunc('hour', now() at time zone 'America/New_York'), interval '1 hour') h
   where extract(isodow from h) between 1 and 5 and extract(hour from h) between 9 and 15
)
select to_char(hrs.hour_et, 'YYYY-MM-DD HH24:00') as hour_et, count(b.id)::int as cards
  from hrs
  left join core.blurbs b on b.status = 'published' and b.published_at > now() - interval '15 days'
                         and date_trunc('hour', b.published_at at time zone 'America/New_York') = hrs.hour_et
 group by hrs.hour_et
 order by hrs.hour_et desc;

-- name: cards_by_et_hour_of_day_30d
-- Which hours of the day cards arrive in (all days, 30 days).
select extract(hour from b.published_at at time zone 'America/New_York')::int as hour_et, count(*)::int as cards
  from core.blurbs b
 where b.status = 'published' and b.published_at > now() - interval '30 days'
 group by 1
 order by 1;

-- name: live_cards_by_topic
-- Live cards per category (the feed topics) now: total, last 24 h, last 7 days.
select c.slug as category,
       count(b.id)::int as live_cards,
       count(b.id) filter (where b.published_at > now() - interval '24 hours')::int as last_24h,
       count(b.id) filter (where b.published_at > now() - interval '7 days')::int as last_7d
  from core.categories c
  left join core.blurbs b on b.category = c.slug and b.status = 'published' and b.superseded_by is null
 group by c.slug, c.sort_order
 order by c.sort_order;

-- name: items_by_status
-- Collected items of the last 30 days by source, status and reason (status_note with digits and the retry counter
-- folded away). Items marked skipped are never retried by the pipeline (scripts/requeue-skipped.sql is the manual tool).
select i.source, i.status,
       coalesce(nullif(regexp_replace(regexp_replace(left(i.status_note, 60), '[0-9]+', 'N', 'g'), '\(.*$', ''), ''), '(none)') as status_note,
       count(*)::int as items
  from ingest.items i
 where i.fetched_at > now() - interval '30 days'
 group by 1, 2, 3
 order by items desc, 1, 2;

-- name: ai_usage_vs_caps
-- Provider calls per UTC day for 7 days against the daily cap (core.ai_caps; reserve is held back for the Brief).
select u.day::text as utc_day, u.provider, u.calls, c.cap, c.reserve,
       round(100.0 * u.calls / nullif(c.cap, 0))::int as pct_of_cap
  from core.ai_usage u
  left join core.ai_caps c on c.provider = u.provider
 where u.day >= (now() at time zone 'utc')::date - 6
 order by u.day desc, u.provider;

-- name: gemini_vs_groq_share_30d
-- Which writer made the live cards of the last 30 days (core.blurbs.model: Gemini model ids start with 'gemini',
-- Groq ids look like 'openai/gpt-oss-120b'; no model = template or data card).
select case when b.model is null then 'template_or_data'
            when b.model ilike 'gemini%' then 'gemini'
            else 'groq_or_other' end as writer,
       count(*)::int as cards,
       round(100.0 * count(*) / sum(count(*)) over ())::int as pct
  from core.blurbs b
 where b.status = 'published' and b.published_at > now() - interval '30 days'
 group by 1
 order by 2 desc;

-- name: pool_size
-- Live pool by age: what each feed can draw from.
select count(*) filter (where published_at > now() - interval '24 hours')::int as live_24h,
       count(*) filter (where published_at > now() - interval '7 days')::int as live_7d,
       count(*) filter (where published_at > now() - interval '30 days')::int as live_30d,
       count(*)::int as live_total
  from core.blurbs
 where status = 'published' and superseded_by is null;

-- name: stuck_new_items
-- Items still 'new' that an hourly run touched more than 2 days after they were first listed, i.e. retried every run without ever
-- closing (the Best Buy 2.02 case of R-300: 4 AI calls per hour for weeks). After the M9c fix this should be 0 for new rows:
-- a rejected-draft item is retried 3 times and then skipped. Source, count, oldest published_at, newest touch.
select i.source, count(*)::int as items, min(i.published_at)::date as oldest_published, max(i.fetched_at) as last_touched
  from ingest.items i
 where i.status = 'new' and i.fetched_at > now() - interval '3 days' and i.published_at < now() - interval '2 days'
 group by 1
 order by items desc;

-- name: slot_coverage_14d
-- THE GOAL MEASURE (cadence, D-270): share of 15-minute slots in the drip window (Mon-Fri 06:00-19:59 ET, 56 a day) with at
-- least one card that went live (published_at; a released queued card counts at its release time). Per ET day and ALL.
-- Target: 100 (a new card every 15 minutes). Today (R-520) it is a few percent.
with slots as (
  select s as slot_et
    from generate_series(date_trunc('day', (now() at time zone 'America/New_York') - interval '14 days') + interval '6 hours',
                         (now() at time zone 'America/New_York') - interval '15 minutes', interval '15 minutes') s
   where extract(isodow from s) between 1 and 5 and extract(hour from s) between 6 and 19
), hit as (
  select distinct date_trunc('hour', b.published_at at time zone 'America/New_York')
         + floor(extract(minute from b.published_at at time zone 'America/New_York') / 15) * interval '15 minutes' as slot_et
    from core.blurbs b
   where b.status = 'published' and b.published_at > now() - interval '15 days'
)
select coalesce(to_char(s.slot_et, 'YYYY-MM-DD'), 'ALL') as day_et,
       count(*)::int as slots,
       count(h.slot_et)::int as slots_with_a_card,
       round(100.0 * count(h.slot_et) / nullif(count(*), 0), 1) as pct_covered
  from slots s left join hit h on h.slot_et = s.slot_et
 group by rollup (to_char(s.slot_et, 'YYYY-MM-DD'))
 order by 1 desc;

-- name: longest_gap_per_day_14d
-- Longest time between two consecutive live cards, per ET day of the later card: over the whole day, and only for gaps that end
-- inside the drip window (Mon-Fri 06:00-19:59 ET). gaps_over_60 counts those window gaps longer than 60 minutes.
with c as (
  select b.published_at, lag(b.published_at) over (order by b.published_at) as prev
    from core.blurbs b where b.status = 'published' and b.published_at > now() - interval '15 days'
), g as (
  select (published_at at time zone 'America/New_York')::date as day_et,
         extract(epoch from (published_at - prev)) / 60 as gap_min,
         extract(isodow from published_at at time zone 'America/New_York') between 1 and 5
           and extract(hour from published_at at time zone 'America/New_York') between 6 and 19 as in_window
    from c where prev is not null and published_at > now() - interval '14 days'
)
select to_char(day_et, 'YYYY-MM-DD') as day_et, count(*)::int as cards,
       round(max(gap_min))::int as longest_gap_min,
       round(max(gap_min) filter (where in_window))::int as longest_window_gap_min,
       count(*) filter (where in_window and gap_min > 60)::int as gaps_over_60
  from g group by day_et order by day_et desc;

-- name: queued_cards
-- The release queue (core.drip_config): cards held for the next 15-minute slot. Oldest first.
select b.kind, count(*)::int as queued, min(b.queued_at) as oldest_queued_at, max(b.importance) as top_importance
  from core.blurbs b where b.status = 'queued' group by b.kind order by 1;

-- name: cards_by_kind_14d
-- Where the live cards come from: link_out (NewsData.io), data (agency numbers) and summary (AI or template from filings).
select b.kind, (b.published_at at time zone 'America/New_York')::date as day_et, count(*)::int as cards
  from core.blurbs b where b.status = 'published' and b.published_at > now() - interval '14 days'
 group by 1, 2 order by 2 desc, 1;
