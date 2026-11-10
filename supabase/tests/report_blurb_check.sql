-- api.report_blurb (20261131000000_report_blurb.sql). Checks: valid report ok and stored hashed; bad reason, unknown and
-- hidden card rejected (PT422); same-day repeat is a quiet duplicate (one row); 20/hour limit trips with PT429 for the
-- same reporter but not for another; anon and authenticated cannot read the table, salt or view; function is
-- search_path-safe (pinned, security definer) and granted to anon + authenticated only; purge removes only old rows.
-- Test rows are rolled back on purpose.
do $$
declare
  ua uuid; ub uuid; v_card uuid; v_hidden uuid; r jsonb; n int; i int; st text; v_cfg text[]; cards uuid[] := '{}';
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  select 'rp-'||g,'summary','Report check card '||g,'Body.','economy',case when g = 0 then 'hidden' else 'published' end,now(),now(),now(),4,1
  from generate_series(0,25) g;
  select id into v_hidden from core.blurbs where dedupe_key = 'rp-0';
  select id into v_card from core.blurbs where dedupe_key = 'rp-1';
  for i in 0..25 loop cards := cards || (select id from core.blurbs where dedupe_key = 'rp-'||i); end loop;  -- cards[i+1] = rp-i

  -- signed-out (anon) valid report
  perform set_config('role', 'anon', true);
  perform set_config('request.headers', '{"x-forwarded-for":"203.0.113.9, 10.0.0.1"}', true);
  r := api.report_blurb(v_card, 'inaccurate');
  if r ->> 'status' <> 'ok' then raise exception 'FAIL: valid report should be ok, got %', r; end if;

  -- bad reasons, null, too long, unknown card, hidden card
  foreach st in array array['spam', '', repeat('x', 40)] loop
    begin perform api.report_blurb(v_card, st); raise exception 'FAIL: reason % accepted', left(st, 10);
    exception when sqlstate 'PT422' then null; end;
  end loop;
  begin perform api.report_blurb(v_card, null); raise exception 'FAIL: null reason accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(null, 'other'); raise exception 'FAIL: null id accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(gen_random_uuid(), 'other'); raise exception 'FAIL: unknown card accepted';
  exception when sqlstate 'PT422' then null; end;
  begin perform api.report_blurb(v_hidden, 'other'); raise exception 'FAIL: hidden card accepted';
  exception when sqlstate 'PT422' then null; end;

  -- same card, same reporter, same day: duplicate, still one row (reason of the first stays)
  r := api.report_blurb(v_card, 'other');
  if r ->> 'status' <> 'duplicate' then raise exception 'FAIL: repeat should be duplicate, got %', r; end if;

  -- client roles cannot read anything private
  begin perform 1 from core.blurb_reports; raise exception 'FAIL: anon read blurb_reports';
  exception when insufficient_privilege then null; end;
  begin perform 1 from core.blurb_report_salt; raise exception 'FAIL: anon read salt';
  exception when insufficient_privilege then null; end;
  begin perform 1 from core.blurb_report_counts; raise exception 'FAIL: anon read counts view';
  exception when insufficient_privilege then null; end;
  begin insert into core.blurb_reports(blurb_id, reason, reporter_key) values (v_card, 'other', repeat('a', 64)); raise exception 'FAIL: anon insert';
  exception when insufficient_privilege then null; end;
  begin perform core.purge_blurb_reports(); raise exception 'FAIL: anon ran purge';
  exception when insufficient_privilege then null; end;

  -- rate limit: 20 distinct cards ok for this IP (1 already used), the 21st trips PT429
  for i in 2..20 loop perform api.report_blurb(cards[i+1], 'misleading'); end loop;
  begin perform api.report_blurb(cards[22], 'misleading');
    raise exception 'FAIL: 21st report in an hour was accepted';
  exception when sqlstate 'PT429' then null; end;
  -- a duplicate is still a quiet success at the limit (no write)
  r := api.report_blurb(v_card, 'other');
  if r ->> 'status' <> 'duplicate' then raise exception 'FAIL: duplicate at the limit should stay duplicate'; end if;
  -- another IP is not limited
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.7"}', true);
  r := api.report_blurb(cards[22], 'broken_link');
  if r ->> 'status' <> 'ok' then raise exception 'FAIL: other IP should not be limited'; end if;
  -- signed in is keyed by user, not IP
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', '{"x-forwarded-for":"203.0.113.9"}', true);
  r := api.report_blurb(cards[22], 'other');
  if r ->> 'status' <> 'ok' then raise exception 'FAIL: signed-in user should not share the IP bucket'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.report_blurb(cards[22], 'other');
  if r ->> 'status' <> 'ok' then raise exception 'FAIL: second user should be separate'; end if;

  -- back to the owner role: stored data
  perform set_config('role', 'postgres', true);
  select count(*) into n from core.blurb_reports;
  if n <> 23 then raise exception 'FAIL: expected 23 rows, got %', n; end if;
  if exists (select 1 from core.blurb_reports where reporter_key !~ '^[0-9a-f]{64}$' or reporter_key like '%203.0.113%') then
    raise exception 'FAIL: reporter key must be a hash'; end if;
  if (select reports from core.blurb_report_counts where blurb_id = v_card) <> 1 then raise exception 'FAIL: counts view'; end if;
  if (select count(*) from core.blurb_report_salt) <> 1 then raise exception 'FAIL: salt row'; end if;

  -- search_path pinned, security definer, grants
  select proconfig into v_cfg from pg_proc where oid = 'api.report_blurb(uuid,text)'::regprocedure;
  if v_cfg is null or not ('search_path=""' = any (v_cfg)) then raise exception 'FAIL: search_path not pinned: %', v_cfg; end if;
  if not (select prosecdef from pg_proc where oid = 'api.report_blurb(uuid,text)'::regprocedure) then raise exception 'FAIL: not security definer'; end if;
  if not (has_function_privilege('anon', 'api.report_blurb(uuid,text)', 'execute') and has_function_privilege('authenticated', 'api.report_blurb(uuid,text)', 'execute')) then
    raise exception 'FAIL: report_blurb must be executable by anon and authenticated'; end if;

  -- retention: only rows older than 180 days go; cascade removes reports with their card
  update core.blurb_reports set created_at = now() - interval '181 days' where id = (select min(id) from core.blurb_reports);
  if core.purge_blurb_reports() <> 1 then raise exception 'FAIL: purge should remove exactly the one old row'; end if;
  delete from core.blurbs where id = v_card;
  if exists (select 1 from core.blurb_reports where blurb_id = v_card) then raise exception 'FAIL: reports must cascade with the card'; end if;

  raise exception 'ALL REPORT BLURB CHECKS PASSED (test rows rolled back on purpose)';
end $$;
