-- NewsData.io link-out cards (M9 supply, branch m9c-linkout). Written, NOT applied. Safe to apply while the feature is off:
-- nothing changes for readers until core.app_config.linkout_cards is set to true by hand (it is false today).
--
-- What this does:
--   1. core.blurbs.delayed_hours: a link_out card with no value gets 12 (NewsData.io's free plan delays news by 12 hours),
--      so the card shows "Delayed 12 h" (rule 7). Other card kinds are untouched. api.publish_blurb is NOT rewritten:
--      a BEFORE INSERT trigger fills the column.
--   2. ingest.run_log accepts the two new source names (newsdata_market, newsdata_latest).
-- The cron jobs are in 20261201000100_newsdata_cron.sql (apply that last, after the key is set).
-- Turn on later:  update core.app_config set linkout_cards = true where id;   Turn off: set it back to false.
-- Re-runnable.

-- 1. delayed_hours for link_out
create or replace function core.blurbs_linkout_delay()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'link_out' and new.delayed_hours is null then new.delayed_hours := 12; end if;
  return new;
end;
$$;

drop trigger if exists blurbs_linkout_delay on core.blurbs;
create trigger blurbs_linkout_delay
  before insert on core.blurbs
  for each row execute function core.blurbs_linkout_delay();

-- 2. run_log accepts the new source names (read the current list, add ours)
do $$
declare
  def   text;
  names text[];
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'ingest.run_log'::regclass and c.conname = 'run_log_source_check';
  select coalesce(array_agg(distinct m[1]), '{}') into names
    from regexp_matches(coalesce(def, ''), '''([^'']+)''', 'g') as m;
  names := array(select distinct n from unnest(names || array['newsdata_market', 'newsdata_latest']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;
