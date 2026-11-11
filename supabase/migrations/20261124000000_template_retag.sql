-- M9 workstream 9 / 2 (templates): retag live cards and retire the per-maturity yield cards. NOT applied. Idempotent.
--
--  1. Data cards (kind = 'data') that are not Economy or Energy move to Economy (E-04, F2): the yield and fed funds
--     cards were tagged Business / Policy, so "Hide Business topics" hid them and Business likes were mislearned.
--  2. Federal Register FAA airworthiness orders move to Recalls & Safety (F2, C16): they are aircraft safety orders,
--     not a government-policy topic. Matched by source (a 'Federal Register' link on the card) and an aircraft headline.
--  3. The per-maturity Treasury yield cards (DGS2, DGS3MO, DGS5, DGS10, DGS30) are hidden: the ingest now publishes
--     one daily 'YIELDCURVE:<date>' card instead (core.supersede_series keeps only the newest of it live). Hiding uses
--     status 'hidden' like core.supersede_series. DEPLOY ORDER: deploy the ingest-source function first, then apply
--     this file, otherwise the old code publishes a fresh per-maturity card on its next run.
--  4. The Numbers ticker label for DFF reads "Fed funds (effective)" so it is not mistaken for the Fed's target range
--     (E-05); the card text states the target range next to it.
--
-- Bounded and safe to run twice: each statement touches at most 5000 rows chosen by a keyed sub-select and only rows
-- that still need the change, so a second run changes 0 rows. If a statement reports exactly 5000 rows, run this
-- file again until every count is below 5000. updated_at is left alone on purpose (it would show an "Updated" tag).
-- Index use: the candidate scans filter on kind / category / status and read core.blurbs sequentially (the table holds
-- a few thousand cards, so a full scan is cheaper than a new index; the 5000 limit caps the writes); the FAA join uses
-- blurb_sources_blurb_idx (blurb_id).
--
-- AFTER APPLYING (Drew runs this, it is not part of the migration because it loops over every card and takes a while):
--   select core.refresh_all_ranks();
-- Settings: none (a one-off data fix).

-- The work lives in a function so the SQL test can run the same statements; the last line of this file calls it.
create or replace function core.retag_templates_m9(p_limit int default 5000)
returns table (data_to_economy int, faa_to_safety int, yield_cards_hidden int)
language plpgsql security definer set search_path = '' as $$
declare a int; b int; c int; lim int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
begin
  -- 1. data cards -> Economy (Energy stays Energy: oil and gas prices)
  update core.blurbs x set category = 'economy'
   where x.id in (select id from core.blurbs
                   where kind = 'data' and status in ('published', 'hidden') and category not in ('economy', 'energy')
                   order by id limit lim);
  get diagnostics a = row_count;

  -- 2. FAA airworthiness orders -> Recalls & Safety
  update core.blurbs x set category = 'safety'
   where x.id in (select c.id from core.blurbs c
                   where c.kind = 'summary' and c.status in ('published', 'hidden') and c.category <> 'safety'
                     and c.headline ~* '(airworth|aircraft|airplane|\mFAA\M|\mflight)'
                     and exists (select 1 from core.blurb_sources s where s.blurb_id = c.id and s.name = 'Federal Register')
                   order by c.id limit lim);
  get diagnostics b = row_count;

  -- 3. per-maturity yield cards are replaced by the daily yield-curve card
  update core.blurbs x set status = 'hidden'
   where x.id in (select id from core.blurbs
                   where kind = 'data' and status = 'published'
                     and split_part(dedupe_key, ':', 1) in ('DGS2', 'DGS3MO', 'DGS5', 'DGS10', 'DGS30')
                   order by id limit lim);
  get diagnostics c = row_count;

  -- 4. ticker label
  update core.macro_series set label = 'Fed funds (effective)' where series_id = 'DFF' and label <> 'Fed funds (effective)';
  return query select a, b, c;
end $$;
revoke all on function core.retag_templates_m9(int) from public, anon, authenticated;
grant execute on function core.retag_templates_m9(int) to service_role;

-- Prints the three counts. A count equal to 5000 means "run this file again".
select * from core.retag_templates_m9();
