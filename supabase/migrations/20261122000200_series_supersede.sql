-- M9 WS9 (Data series): one live card per data series. NOT applied. Idempotent.
-- A data card's series is split_part(dedupe_key, ':', 1) ('<series>:<obs date>', e.g. DGS10:2026-11-06). When a newer
-- reading of the same series is published, the older published readings are hidden (status 'hidden', which every
-- feed, search, company and brief query already honours) and point at the live card in core.blurbs.superseded_by.
-- The newest reading is the one with the latest observation date (the key suffix), then the latest as_of, then id,
-- so a late or re-written older reading cannot replace a newer one (it is superseded on arrival).
-- Why a status change and not a column every query must filter: the audit found ~20 read paths; hiding is safe now
-- and superseded_by keeps the audit trail (and lets a restore find the cards). Restoring a hidden reading to
-- 'published' re-runs the trigger and supersedes it again if a newer one is live.
-- Settings: none (a rule, not a tunable).

alter table core.blurbs add column if not exists superseded_by uuid references core.blurbs (id) on delete set null;
create index if not exists blurbs_superseded_by_idx on core.blurbs (superseded_by) where superseded_by is not null;

-- Keeps only the newest published reading of one series live. Returns how many cards it hid.
create or replace function core.supersede_series(p_series text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if coalesce(p_series, '') = '' then return 0; end if;
  with live as (
    select b.id, row_number() over (order by split_part(b.dedupe_key, ':', 2) desc, b.as_of desc, b.id desc) rn
    from core.blurbs b
    where b.kind = 'data' and b.status = 'published' and split_part(b.dedupe_key, ':', 1) = p_series
  ), top as (select id from live where rn = 1)
  update core.blurbs b set status = 'hidden', superseded_by = (select id from top), updated_at = now()
  from live where live.id = b.id and live.rn > 1;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function core.supersede_series(text) from public, anon, authenticated;
grant execute on function core.supersede_series(text) to service_role;

create or replace function core.blurbs_supersede_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'data' and new.status = 'published' then
    perform core.supersede_series(split_part(new.dedupe_key, ':', 1));
  end if;
  return null;
end $$;
revoke all on function core.blurbs_supersede_trg() from public, anon, authenticated;
drop trigger if exists blurbs_supersede_series on core.blurbs;
create trigger blurbs_supersede_series after insert or update of status on core.blurbs
  for each row when (new.kind = 'data' and new.status = 'published') execute function core.blurbs_supersede_trg();

-- Series that still have more than one live card (core.supersede_series fixes them); used by the test and by ops.
create or replace function core.duplicate_live_series()
returns table (series text, live_cards bigint)
language sql stable set search_path = '' as $$
  select split_part(b.dedupe_key, ':', 1), count(*) from core.blurbs b
  where b.kind = 'data' and b.status = 'published'
  group by 1 having count(*) > 1
$$;
revoke all on function core.duplicate_live_series() from public, anon, authenticated;

-- backfill (idempotent)
select core.supersede_series(s) from (select distinct split_part(dedupe_key, ':', 1) s from core.blurbs where kind = 'data' and status = 'published') x;
