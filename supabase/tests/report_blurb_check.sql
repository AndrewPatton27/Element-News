-- Checks for 20261130000100_report_blurb.sql: validation, storage, de-duplication, per-key and global rate limits,
-- privacy of the table, grants. Test rows roll back at the deliberate final error.
do $$
declare
  v_id uuid; v_other uuid; v_n int; v_ok boolean; i int;
begin
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('rep:a','summary','Report me','Body','world','published','[]',now(),now(),now(),10) returning id into v_id;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('rep:hidden','summary','Hidden','Body','world','hidden','[]',now(),now(),now(),10) returning id into v_other;

  -- 1. validation: reason list, unknown card, hidden card, nulls
  begin perform api.report_blurb(v_id, 'spam; drop table'); raise exception 'FAIL: bad reason accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(gen_random_uuid(), 'other'); raise exception 'FAIL: unknown card accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(v_other, 'other'); raise exception 'FAIL: hidden card accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(null, 'other'); raise exception 'FAIL: null id accepted';
  exception when sqlstate 'PT422' then null; end;

  -- 2. anonymous report with a client IP header is stored without the address; a repeat is silent and not stored twice
  perform set_config('request.headers', '{"cf-connecting-ip":"203.0.113.9"}', true);
  perform api.report_blurb(v_id, 'inaccurate');
  perform api.report_blurb(v_id, 'inaccurate');
  select count(*) into v_n from core.blurb_reports where blurb_id = v_id;
  if v_n <> 1 then raise exception 'FAIL: duplicate report stored (% rows)', v_n; end if;
  if exists (select 1 from core.blurb_reports where reporter_key like '%203.0.113.9%' or reporter_key = 'anon') then
    raise exception 'FAIL: the IP address must not be stored, and a header must give a hashed key'; end if;
  if not exists (select 1 from core.blurb_reports where reporter_key like 'i:%' and reporter_id is null) then
    raise exception 'FAIL: anonymous key missing'; end if;

  -- 3. per-key limit: 20 per hour, the 21st raises rate_limited
  for i in 1..19 loop
    insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
    values ('rep:n'||i,'summary','N'||i,'Body','world','published','[]',now(),now(),now(),10) returning id into v_other;
    perform api.report_blurb(v_other, 'other');
  end loop;
  v_ok := false;
  begin perform api.report_blurb(v_id, 'misleading');
  exception when sqlstate 'PT429' then v_ok := true; end;
  if not v_ok then raise exception 'FAIL: the 21st report in an hour was not limited'; end if;
  -- a different client is not affected
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.4, 10.0.0.1"}', true);
  perform api.report_blurb(v_id, 'misleading');

  -- 4. global ceiling
  insert into core.blurb_reports(blurb_id, reason, reporter_key)
  select v_id, 'other', 'bulk:' || g from generate_series(1, 2000) g;
  perform set_config('request.headers', '{"cf-connecting-ip":"192.0.2.77"}', true);
  v_ok := false;
  begin perform api.report_blurb(v_id, 'broken_link');
  exception when sqlstate 'PT429' then v_ok := true; end;
  if not v_ok then raise exception 'FAIL: global hourly ceiling not enforced'; end if;

  -- 5. prune keeps recent rows, drops old ones
  update core.blurb_reports set created_at = now() - interval '120 days' where reporter_key = 'bulk:1';
  if core.prune_blurb_reports(90) < 1 then raise exception 'FAIL: prune removed nothing'; end if;
  if not exists (select 1 from core.blurb_reports where reporter_key = 'bulk:2') then raise exception 'FAIL: prune removed recent rows'; end if;

  -- 6. privacy and grants
  if has_table_privilege('anon','core.blurb_reports','select') or has_table_privilege('authenticated','core.blurb_reports','insert')
     or has_table_privilege('authenticated','core.blurb_reports','select') then
    raise exception 'FAIL: client roles have privileges on core.blurb_reports'; end if;
  if not (select relrowsecurity from pg_class where oid = 'core.blurb_reports'::regclass) then raise exception 'FAIL: RLS off on blurb_reports'; end if;
  if not has_function_privilege('anon','api.report_blurb(uuid,text)','execute') or not has_function_privilege('authenticated','api.report_blurb(uuid,text)','execute') then
    raise exception 'FAIL: report_blurb must be callable by anon and authenticated'; end if;
  if has_function_privilege('anon','core.prune_blurb_reports(integer)','execute') or has_function_privilege('authenticated','core.prune_blurb_reports(integer)','execute') then
    raise exception 'FAIL: prune must be service-role only'; end if;
  if not exists (select 1 from pg_proc where oid = 'api.report_blurb(uuid,text)'::regprocedure and prosecdef and proconfig::text like '%search_path%') then
    raise exception 'FAIL: report_blurb must be security definer with a pinned search_path'; end if;

  raise exception 'ALL REPORT BLURB CHECKS PASSED (test rows rolled back on purpose)';
end $$;
