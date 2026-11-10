-- Function grants allowlist (20261121000400_api_grants.sql). Fails on ANY api function whose anon / authenticated
-- EXECUTE differs from the allowlist below, so a new RPC must be added here (and granted in a migration) on purpose.
-- Checks: every api function: anon / authenticated exactly as listed, everything else service-role only and never
-- PUBLIC; no core function callable by PUBLIC, anon or authenticated; api.retag_companies service-role only; a
-- function created after the migrations is not callable by PUBLIC (global default revoked).
-- Test rows are rolled back on purpose (the closing error).
do $$
declare
  v_allow jsonb := '{
    "api.card_companies(uuid[])": "a", "api.companies_directory(integer)": "a", "api.company_cards(text,text,integer)": "a",
    "api.confirm_brief(uuid)": "a", "api.daily_brief()": "a", "api.feed(text,text,integer,text)": "a", "api.feed_status()": "a",
    "api.card_by_id(uuid)": "a", "api.followed_micro(text[],integer)": "a", "api.following_feed(text[],text[],text[],text,integer)": "a", "api.number_trends()": "a",
    "api.ops_status(text)": "a", "api.related_cards(uuid,integer)": "a", "api.search(text,text,integer)": "a",
    "api.search_companies(text,integer)": "a", "api.sources()": "a", "api.subscribe_brief(text,text,integer,text)": "a",
    "api.top_stories()": "a", "api.unsubscribe_brief(uuid)": "a", "api.update_brief_subscription(uuid,text,integer,text)": "a",
    "api.weekly_brief()": "a",
    "api.delete_account()": "u", "api.delete_my_data()": "u", "api.feed_for_you(text,integer)": "u",
    "api.feed_for_you(text,integer,uuid[])": "u", "api.get_prefs()": "u", "api.my_brief_subscriptions()": "u",
    "api.my_categories()": "u", "api.set_prefs(text[],text[],text[])": "u", "api.track(uuid,text,integer,uuid,integer,text)": "u",
    "api.unsubscribe_my_brief(text)": "u", "api.update_my_brief_time(text,integer,text)": "u"
  }';
  f record; v_bad text := ''; v_n int := 0; k text;
begin
  for f in select p.oid, p.oid::regprocedure::text as name,
                  has_function_privilege('anon', p.oid, 'execute') as a,
                  has_function_privilege('authenticated', p.oid, 'execute') as u,
                  has_function_privilege('service_role', p.oid, 'execute') as s,
                  exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as pub
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api' and p.prokind = 'f' loop
    v_n := v_n + 1;
    if f.pub then v_bad := v_bad || ' ' || f.name || '(PUBLIC)'; end if;
    case v_allow ->> f.name
      when 'a' then if not (f.a and f.u) then v_bad := v_bad || ' ' || f.name || '(needs anon+authenticated)'; end if;
      when 'u' then if f.a or not f.u then v_bad := v_bad || ' ' || f.name || '(authenticated only)'; end if;
      else if f.a or f.u or not f.s then v_bad := v_bad || ' ' || f.name || '(not in the allowlist: service role only)'; end if;
    end case;
  end loop;
  for k in select jsonb_object_keys(v_allow) loop
    if to_regprocedure(k) is null then v_bad := v_bad || ' ' || k || '(listed but missing)'; end if;
  end loop;
  if v_bad <> '' then raise exception 'FAIL: api grants differ from the allowlist:%', v_bad; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'core' and p.prokind = 'f'
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'FAIL: core functions callable by the client roles: %', (select string_agg(p.oid::regprocedure::text, ', ')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.prokind = 'f'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))); end if;

  if has_function_privilege('anon', 'api.retag_companies(integer)', 'execute') or has_function_privilege('authenticated', 'api.retag_companies(integer)', 'execute')
     or not has_function_privilege('service_role', 'api.retag_companies(integer)', 'execute') then
    raise exception 'FAIL: api.retag_companies must be service-role only'; end if;

  -- a function created now (rolled back) gets no PUBLIC execute
  create function api.zz_grants_probe() returns int language sql as 'select 1';
  create function core.zz_grants_probe() returns int language sql as 'select 1';
  if has_function_privilege('anon', 'api.zz_grants_probe()', 'execute') or has_function_privilege('authenticated', 'core.zz_grants_probe()', 'execute') then
    raise exception 'FAIL: new functions must not be executable by PUBLIC / client roles by default'; end if;
  raise exception 'ALL API GRANTS CHECKS PASSED (% api functions; test objects rolled back on purpose)', v_n;
end $$;
