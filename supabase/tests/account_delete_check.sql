-- =============================================================================
-- account_delete_check.sql: checks for 20261017040000_account_delete.sql
--
-- Supabase SQL editor:
--   1. Authentication -> Users -> Add user ("Auto Confirm User"):
--        element-test-a@example.com  and  element-test-b@example.com
--   2. Paste this whole file and run it.
--      expected:     ERROR: ALL ACCOUNT DELETE CHECKS PASSED (test data rolled back on purpose)
--      any failure:  ERROR: FAIL: <what failed>
--      The final error rolls everything back, so user A is NOT really deleted.
--      An error "permission denied for table users" means postgres can no longer delete
--      from auth.users on this project (see the migration header).
--   3. Delete the two test users afterwards.
-- Signed-in users are simulated as in accounts_check.sql (role + request.jwt.claims).
-- =============================================================================

do $$
declare
  ua  uuid;
  ub  uuid;
  b   uuid;
  r   jsonb;
  ok  boolean;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first';
  end if;

  -- one card both users react to
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at)
  values ('acctdel-1', 'summary', 'ACCTDEL 1', 'tech', now(), now()) returning id into b;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  values (b, 'SEC', 'filing', 'https://www.sec.gov/acctdel/1', 'company_filing', true);
  insert into core.user_prefs (user_id, followed_categories, onboarded) values (ua, '{tech}', true), (ub, '{tech}', true)
  on conflict (user_id) do update set followed_categories = '{tech}';
  insert into core.user_events (user_id, blurb_id, kind) values (ua, b, 'like'), (ub, b, 'like');

  -- 1. anon cannot call it
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'anon')::text, true);
  ok := false;
  begin perform api.delete_account();
  exception when insufficient_privilege then ok := true;
            when others then raise exception 'FAIL: anon reached api.delete_account (%)', sqlerrm;
  end;
  if not ok then raise exception 'FAIL: anon can call api.delete_account'; end if;

  -- 2. signed-in role without a user id is refused
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  ok := false;
  begin perform api.delete_account();
  exception when others then ok := sqlerrm = 'not_authenticated'; end;
  if not ok then raise exception 'FAIL: delete_account without a user id did not raise not_authenticated'; end if;

  -- 3. user A deletes A (and only A)
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.delete_account();
  if r is distinct from '{"deleted": true}'::jsonb then raise exception 'FAIL: delete_account returned %', r; end if;

  -- 4. calling again with the old token: nothing left to delete
  ok := false;
  begin perform api.delete_account();
  exception when others then ok := sqlerrm = 'account_not_found'; end;
  if not ok then raise exception 'FAIL: second delete_account did not raise account_not_found'; end if;

  perform set_config('role', 'none', true);
  if exists (select 1 from auth.users where id = ua) then raise exception 'FAIL: user A still in auth.users'; end if;
  if exists (select 1 from core.user_prefs where user_id = ua) or exists (select 1 from core.user_events where user_id = ua) then
    raise exception 'FAIL: user A data left after delete_account';
  end if;
  if not exists (select 1 from auth.users where id = ub)
     or not exists (select 1 from core.user_prefs where user_id = ub)
     or not exists (select 1 from core.user_events where user_id = ub) then
    raise exception 'FAIL: user B (or B''s data) was deleted by A';
  end if;

  raise exception 'ALL ACCOUNT DELETE CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
