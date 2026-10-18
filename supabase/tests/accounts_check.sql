-- =============================================================================
-- accounts_check.sql: checks for 20261017030000_accounts.sql
--
-- Supabase SQL editor (as Drew):
--   1. Authentication -> Users -> Add user, tick "Auto Confirm User", create
--        element-test-a@example.com   and   element-test-b@example.com
--      (any password; they are only used to get two real user ids).
--   2. Paste this whole file and run it.
--      expected:      ERROR: ALL ACCOUNT CHECKS PASSED (test data rolled back on purpose)
--      any failure:   ERROR: FAIL: <what failed>
--      The block raises an error on purpose at the end, so every test row is rolled back.
--   3. Delete the two test users afterwards.
--
-- How "signed in" is simulated: the block switches to the `authenticated` (or `anon`)
-- role and sets request.jwt.claims = {"sub": <user id>}, which is exactly what
-- auth.uid() reads when PostgREST serves an app request. This runs inside one
-- transaction, so nothing leaks. The real end-to-end test is still signing in from the app.
--
-- Offline: the same file runs in PGlite with stand-ins for auth.users, auth.uid() and the
-- anon/authenticated roles (see the runner script in the build notes).
-- =============================================================================

do $$
declare
  ua      uuid;
  ub      uuid;
  base    numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  b       uuid;
  r       jsonb;
  page    jsonb;
  cur     text;
  seen    text[];
  pages   int;
  got     text;
  ok      boolean;
  n       int;
  i       int;
  k1      text;
  k2      text;
  -- label, category, rank offset in hours from now
  spec    jsonb := '[
    {"l":"TECH", "c":"tech",    "o":0},
    {"l":"MKT",  "c":"markets", "o":1},
    {"l":"ECO",  "c":"economy", "o":0.5},
    {"l":"DIS",  "c":"markets", "o":3.5},
    {"l":"D2",   "c":"deals",   "o":-0.5},
    {"l":"ENE",  "c":"energy",  "o":-1},
    {"l":"LIKED","c":"deals",   "o":-10}]';
  c       jsonb;
  ids     jsonb := '{}';
begin
  -- ---- setup (as the migration owner) -------------------------------------
  select id into ua from auth.users where email = 'element-test-a@example.com';
  select id into ub from auth.users where email = 'element-test-b@example.com';
  if ua is null or ub is null then
    raise exception 'SETUP: create the users element-test-a@example.com and element-test-b@example.com first (Authentication -> Users -> Add user)';
  end if;
  delete from core.user_events where user_id in (ua, ub);
  delete from core.user_prefs  where user_id in (ua, ub);

  -- hide real cards for the duration of this block (rolled back at the end)
  update core.blurbs set status = 'hidden' where status = 'published';

  for c in select value from jsonb_array_elements(spec) loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('acct-' || (c->>'l'), 'summary', 'ACCT ' || (c->>'l'), c->>'c', now(), now(),
            base + (c->>'o')::numeric)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'SEC', 'filing', 'https://www.sec.gov/acct/' || (c->>'l'), 'company_filing', true);
    ids := ids || jsonb_build_object(c->>'l', b);
  end loop;
  -- six energy cards far down (for the affinity clamp) and 25 tech cards (for paging)
  for i in 1 .. 31 loop
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, rank_score)
    values ('acct-x' || i, 'summary', 'ACCT X' || i, case when i <= 6 then 'energy' else 'tech' end,
            now(), now(), base - 20 - i)
    returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
    values (b, 'SEC', 'filing', 'https://www.sec.gov/acct/x' || i, 'company_filing', true);
    ids := ids || jsonb_build_object('X' || i, b);
  end loop;
  -- 38 published test cards in total

  -- ---- 1. anon cannot call any account function ---------------------------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'anon')::text, true);
  foreach got in array array['get_prefs', 'set_prefs', 'track', 'feed_for_you', 'delete_my_data'] loop
    ok := false;
    begin
      case got
        when 'get_prefs'      then perform api.get_prefs();
        when 'set_prefs'      then perform api.set_prefs(array['tech'], null);
        when 'track'          then perform api.track((ids->>'TECH')::uuid, 'like');
        when 'feed_for_you'   then perform api.feed_for_you(null, 10);
        when 'delete_my_data' then perform api.delete_my_data();
      end case;
    exception when insufficient_privilege then ok := true;
              when others then raise exception 'FAIL: anon reached api.% (it ran and raised: %)', got, sqlerrm;
    end;
    if not ok then raise exception 'FAIL: anon can call api.%', got; end if;
  end loop;
  -- anon still reads the guest feed
  if jsonb_array_length(api.feed('top', null, 10) -> 'items') <> 10 then
    raise exception 'FAIL: anon lost access to api.feed';
  end if;

  -- ---- 2. authenticated without a user id is refused ------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  ok := false;
  begin perform api.get_prefs();
  exception when others then ok := sqlerrm = 'not_authenticated'; end;
  if not ok then raise exception 'FAIL: get_prefs without a user id did not raise not_authenticated'; end if;

  -- ---- 3. user A: prefs, validation, events ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  r := api.get_prefs();
  if (r->>'onboarded')::boolean or r->'followed_categories' <> '[]'::jsonb then
    raise exception 'FAIL: new user prefs are not the defaults: %', r;
  end if;

  r := api.set_prefs(array['tech', 'tech', 'markets'], array['economy']);
  if r->'followed_categories' <> '["markets","tech"]'::jsonb or r->'hidden_categories' <> '["economy"]'::jsonb
     or not (r->>'onboarded')::boolean then
    raise exception 'FAIL: set_prefs returned %', r;
  end if;
  -- null keeps a list
  r := api.set_prefs(array['tech'], null);
  if r->'followed_categories' <> '["tech"]'::jsonb or r->'hidden_categories' <> '["economy"]'::jsonb then
    raise exception 'FAIL: set_prefs with null hidden did not keep it: %', r;
  end if;

  ok := false;
  begin perform api.set_prefs(array['not-a-category'], null);
  exception when others then ok := sqlerrm like 'unknown_category%'; end;
  if not ok then raise exception 'FAIL: set_prefs accepted an unknown slug'; end if;

  ok := false;
  begin perform api.set_prefs(array['tech'], array['tech']);
  exception when others then ok := sqlerrm like 'category_followed_and_hidden%'; end;
  if not ok then raise exception 'FAIL: set_prefs accepted a slug both followed and hidden'; end if;

  ok := false;
  begin perform api.track((ids->>'TECH')::uuid, 'share');
  exception when others then ok := sqlerrm = 'invalid_kind'; end;
  if not ok then raise exception 'FAIL: track accepted an unknown kind'; end if;

  ok := false;
  begin perform api.track(gen_random_uuid(), 'view');
  exception when others then ok := sqlerrm = 'unknown_card'; end;
  if not ok then raise exception 'FAIL: track accepted an unknown card'; end if;

  -- view dedupe: second view inside the hour is ignored
  if api.track((ids->>'TECH')::uuid, 'view') ->> 'status' <> 'recorded' then raise exception 'FAIL: first view not recorded'; end if;
  if api.track((ids->>'TECH')::uuid, 'view') ->> 'status' <> 'ignored'  then raise exception 'FAIL: second view not ignored'; end if;
  -- (on an energy card far down, so it cannot tie with the follow-boost check below)
  if api.track((ids->>'X1')::uuid, 'open_source') ->> 'status' <> 'recorded' then raise exception 'FAIL: open_source not recorded'; end if;

  -- like then dislike on the same card: only the dislike is kept; clear removes it
  perform api.track((ids->>'MKT')::uuid, 'like');
  if api.track((ids->>'MKT')::uuid, 'like') ->> 'status' <> 'ignored' then raise exception 'FAIL: repeated like not ignored'; end if;
  perform api.track((ids->>'MKT')::uuid, 'dislike');
  perform set_config('role', 'none', true);
  select string_agg(kind, ',') into got from core.user_events where user_id = ua and blurb_id = (ids->>'MKT')::uuid;
  if got is distinct from 'dislike' then raise exception 'FAIL: like+dislike left %', got; end if;
  perform set_config('role', 'authenticated', true);
  if api.track((ids->>'MKT')::uuid, 'clear') ->> 'status' <> 'cleared' then raise exception 'FAIL: clear'; end if;

  -- A's reactions for the feed test: dislike DIS, like LIKED (deals +1 h)
  perform api.track((ids->>'DIS')::uuid, 'dislike');
  perform api.track((ids->>'LIKED')::uuid, 'like');

  -- ---- 4. feed_for_you for A --------------------------------------------------
  -- guest order:  DIS 3.5, MKT 1, ECO 0.5, TECH 0, D2 -0.5, ENE -1, LIKED -10
  -- A: follow tech (+2), hide economy, dislike DIS (markets -1 h, DIS gone),
  --    like a deals card (deals +1 h)
  -- For you v2 (trending_foryou migration): personal terms x3, a card already shown -24 h,
  -- the 2nd card of a topic -0.5 h. A also opened a source on X1 (energy +0.5 learned).
  -- expected:     D2 -0.5+3 = 2.5, ENE -1+1.5 = 0.5, MKT 1-3 = -2, LIKED -10+3-0.5 = -7.5,
  --               TECH 0+6-24 = -18 (shown once already: viewed above)
  page := api.feed_for_you(null, 10);
  select string_agg(replace(x->>'headline', 'ACCT ', ''), ',' order by o) into got
    from jsonb_array_elements(page -> 'items') with ordinality as t(x, o) where o <= 5;
  if got is distinct from 'D2,ENE,MKT,LIKED,TECH' then
    raise exception 'FAIL: for-you order for A is %, expected D2,ENE,MKT,LIKED,TECH', got;
  end if;
  if (page->'items'->3->>'my_reaction') is distinct from 'like' or (page->'items'->0->>'my_reaction') is not null then
    raise exception 'FAIL: my_reaction wrong: % / %', page->'items'->3->'my_reaction', page->'items'->0->'my_reaction';
  end if;

  -- same card shape as api.feed (plus my_reaction)
  select string_agg(key, ',' order by key) into k1 from jsonb_object_keys(page->'items'->0) key;
  select string_agg(key, ',' order by key) into k2
    from jsonb_object_keys((api.feed('top', null, 10)->'items'->0) || '{"my_reaction":null}'::jsonb) key;
  if k1 is distinct from k2 then raise exception 'FAIL: card keys differ: % vs %', k1, k2; end if;

  -- paging: every remaining card exactly once, never ECO or DIS
  seen := '{}'; cur := null; pages := 0;
  loop
    page := api.feed_for_you(cur, 10);
    pages := pages + 1;
    for r in select value from jsonb_array_elements(page -> 'items') loop
      if (r->>'id') = any (seen) then raise exception 'FAIL: for-you paging repeated %', r->>'headline'; end if;
      if r->>'headline' in ('ACCT ECO', 'ACCT DIS') then raise exception 'FAIL: % shown to A', r->>'headline'; end if;
      seen := seen || (r->>'id');
    end loop;
    cur := page ->> 'next_cursor';
    exit when cur is null or pages > 6;
  end loop;
  if cardinality(seen) <> 36 or pages <> 4 then
    raise exception 'FAIL: for-you paging returned % cards in % pages, expected 36 in 4', cardinality(seen), pages;
  end if;

  ok := false;
  begin perform api.feed_for_you('garbage', 10);
  exception when others then ok := sqlerrm = 'invalid_cursor'; end;
  if not ok then raise exception 'FAIL: bad cursor accepted'; end if;

  -- ---- 5. user B is isolated from A --------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  r := api.get_prefs();
  if (r->>'onboarded')::boolean or r->'followed_categories' <> '[]'::jsonb or r->'affinity' <> '{}'::jsonb then
    raise exception 'FAIL: B sees prefs or affinity that are not B''s: %', r;
  end if;
  -- B likes six energy cards: affinity clamps at +4 h
  for i in 1 .. 6 loop perform api.track((ids->>('X' || i))::uuid, 'like'); end loop;
  r := api.get_prefs();
  if (r->'affinity'->>'energy')::numeric <> 4 then raise exception 'FAIL: affinity not clamped to 4: %', r->'affinity'; end if;
  -- B's feed: DIS 3.5 (not disliked by B), ENE -1+4 = 3, MKT 1, ECO 0.5 (not hidden for B)
  select string_agg(replace(x->>'headline', 'ACCT ', ''), ',' order by o) into got
    from jsonb_array_elements(api.feed_for_you(null, 10) -> 'items') with ordinality as t(x, o) where o <= 4;
  -- For you v2: ENE -1+12 = 11, DIS 3.5+3 (exploration: B has no markets signals) = 6.5,
  -- then ECO 0.5+3 and MKT 1+3-0.5 tie at 3.5 (order between them decided by id)
  if got not in ('ENE,DIS,ECO,MKT', 'ENE,DIS,MKT,ECO') then
    raise exception 'FAIL: for-you order for B is %, expected ENE,DIS then ECO/MKT', got;
  end if;
  -- B deletes B's data: A's rows survive
  r := api.delete_my_data();
  if (r->>'deleted_events')::int <> 6 or (r->>'deleted_prefs')::int <> 0 then
    raise exception 'FAIL: delete_my_data for B returned %', r;
  end if;

  -- ---- 6. direct table access is closed; RLS limits rows to the owner -------------
  ok := false;
  begin perform 1 from core.user_prefs limit 1;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL: authenticated can select core.user_prefs directly'; end if;

  -- open the table on purpose (rolled back) to prove the RLS policy
  perform set_config('role', 'none', true);
  grant usage on schema core to authenticated;
  grant select, update, delete on core.user_prefs, core.user_events to authenticated;
  perform set_config('role', 'authenticated', true);
  select count(*) into n from core.user_events;                      -- as B
  if n <> 0 then raise exception 'FAIL: RLS lets B see % event rows of A', n; end if;
  update core.user_prefs set hidden_categories = '{}' where user_id = ua;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: RLS lets B update A''s prefs'; end if;
  delete from core.user_events where user_id = ua;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: RLS lets B delete A''s events'; end if;
  perform set_config('role', 'none', true);
  revoke usage on schema core from authenticated;
  revoke select, update, delete on core.user_prefs, core.user_events from authenticated;

  -- ---- 7. A deletes A's data ------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.delete_my_data();
  -- A kept: view, open_source, dislike DIS, like LIKED = 4 events, 1 prefs row
  if (r->>'deleted_events')::int <> 4 or (r->>'deleted_prefs')::int <> 1 then
    raise exception 'FAIL: delete_my_data for A returned %', r;
  end if;
  r := api.get_prefs();
  if (r->>'onboarded')::boolean or r->'hidden_categories' <> '[]'::jsonb then
    raise exception 'FAIL: prefs still there after delete_my_data: %', r;
  end if;
  perform set_config('role', 'none', true);
  if exists (select 1 from core.user_events where user_id in (ua, ub))
     or exists (select 1 from core.user_prefs where user_id in (ua, ub)) then
    raise exception 'FAIL: rows left after delete_my_data';
  end if;

  raise exception 'ALL ACCOUNT CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
