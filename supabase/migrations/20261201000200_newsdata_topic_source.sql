-- NewsData.io query set (M9 supply, branch newsdata-queries-m9). Written, NOT applied. Safe to apply any time: it only widens a check.
-- ingest.run_log accepts the new source name newsdata_topic (one source name for every topic query; the query id travels in the
-- ingest-source request body {"source":"newsdata_topic","query":"<id>"}). Re-runnable. Apply before 20261201000300_newsdata_queries_cron.sql.
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
  names := array(select distinct n from unnest(names || array['newsdata_topic']) as n order by n);
  alter table ingest.run_log drop constraint if exists run_log_source_check;
  execute format('alter table ingest.run_log add constraint run_log_source_check check (source in (%s))',
                 (select string_agg(quote_literal(n), ',') from unnest(names) as n));
end $$;
