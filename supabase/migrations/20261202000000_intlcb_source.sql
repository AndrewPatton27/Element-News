-- Foreign central-bank headline source (ECB, Bank of England, BIS): run_log accepts the new source name 'intlcb'.
-- Written, NOT applied. Idempotent. No cron job here on purpose: the source is OFF until the secrets INTLCB_ENABLED=1 (ECB) and
-- INTLCB_NONCOMMERCIAL_OK=1 (Bank of England, BIS) are set, and Drew gives the OK. Add a cron row (weekdays, one call per run,
-- 5 RSS requests) in a later migration when it is switched on; the watchdog EXPECTED_JOBS goes up with it.
-- The current constraint list is READ from the live constraint and extended (never hard-coded), same as 20261138000000.
-- Check:  select source from ingest.run_log group by 1;

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
  names := array(select distinct n from unnest(names || array['intlcb']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;
