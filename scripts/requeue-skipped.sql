-- Requeue items the report-card step skipped. NOT applied by anyone but Drew. Written for M9 workstream 1 (R-254:
-- about 316 items in 30 days were marked skipped by report_card_revise_failed and, before the retry change, never retried).
--
-- What it does: sets ingest.items back to status 'new' (and clears the note, so the retry counter restarts at 0) for items
--   * status = 'skipped' and status_note like 'report_card_%',
--   * fetched_at within the last 14 days,
--   * with no card (blurb_id is null and no core.blurb_sources row points at the item).
-- 'new' items are picked up by the next ingest run only while the source still lists them (a feed window such as the
-- Fed's 7 days); older ones stay 'new' and are harmless. 'duplicate_story' items are not touched on purpose.
-- Each run changes at most 100 rows. Repeat step 2 until it reports 0 rows.
--
-- How to run, one step at a time:
--   1. DRY RUN (the only active statement in this file, so it is read-only):
--        npx supabase db query --remote --read-only -f scripts/requeue-skipped.sql
--   2. APPLY: remove the leading "-- " from the step 2 statement (or paste it into the Supabase SQL editor), then
--        npx supabase db query --remote --yes -f scripts/requeue-skipped.sql      (put the comment marks back afterwards)
-- It uses items_status_fetched_idx from supabase/migrations/20261129000000_supply_ops.sql; without that migration it is a
-- scan of ingest.items (a few thousand rows).
-- Offline check: the requeue step in supabase/tests/run-pglite.mjs runs both statements on the migrated schema.

-- ---- step 1: DRY RUN. How many rows would move, by reason, with a sample ---------------------------------------------
-- name: requeue_dry_run
select i.status_note as reason, count(*)::int as items, min(i.fetched_at)::date as oldest, max(i.fetched_at)::date as newest
  from ingest.items i
 where i.status = 'skipped'
   and i.status_note like 'report_card\_%' escape '\'
   and i.fetched_at > now() - interval '14 days'
   and i.blurb_id is null
   and not exists (select 1 from core.blurb_sources s where s.item_id = i.id)
 group by 1
 order by 2 desc;

-- ---- step 2: APPLY, at most 100 rows per run (commented out so a dry run cannot write) ------------------------------
-- name: requeue_apply
-- update ingest.items
--    set status = 'new', status_note = 'requeued'
--  where id in (
--    select i.id
--      from ingest.items i
--     where i.status = 'skipped'
--       and i.status_note like 'report_card\_%' escape '\'
--       and i.fetched_at > now() - interval '14 days'
--       and i.blurb_id is null
--       and not exists (select 1 from core.blurb_sources s where s.item_id = i.id)
--     order by i.fetched_at desc
--     limit 100
--  )
-- returning id;
