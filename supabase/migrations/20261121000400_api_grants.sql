-- Function grants as an explicit allowlist (SQL scale/security audit, 2026-11-09). NOT applied. Idempotent.
-- Must be the LAST of the 20261121* migrations (it also re-checks that the macro_focus wrappers are intact).
--
-- 1. 20261118000000_security_fixes.sql ran "alter default privileges in schema api/core revoke execute on functions
--    from public". That is a no-op: PUBLIC's EXECUTE on new functions comes from the global default, and a
--    per-schema entry can only add to it. Now the global default is revoked for the migration role, so a function
--    created later is not callable by PUBLIC until a migration grants it; any per-schema default grant to
--    anon / authenticated in api or core (e.g. one added in the dashboard) is revoked too.
-- 2. Every api function is set to exactly the allowlist below (client-callable RPCs); every other api function is
--    service-role only (revoked from PUBLIC, anon and authenticated). This also fixes api.retag_companies, which
--    20261115000000_companies.sql revoked from PUBLIC only (any direct anon/authenticated grant survived).
-- 3. No core function is callable by PUBLIC, anon or authenticated (core is private; the feeds call it as the
--    owner). Before this, three trigger functions were (core.blurbs_tag_trg, core.blurb_sources_tag_trg,
--    core.companies_derive); triggers do not need it.
-- Adding a client RPC later: add it to the allowlist here (a new migration) AND in tests/api_grants_check.sql,
-- which fails on any api function that is not listed.

alter default privileges revoke execute on functions from public;
alter default privileges in schema api revoke execute on functions from anon, authenticated;
alter default privileges in schema core revoke execute on functions from anon, authenticated;

do $$
declare
  -- name(args) as regprocedure text  ->  roles that may call it ('a' = anon + authenticated, 'u' = authenticated)
  v_allow jsonb := '{
    "api.card_by_id(uuid)": "a",
    "api.card_companies(uuid[])": "a",
    "api.companies_directory(integer)": "a",
    "api.company_cards(text,text,integer)": "a",
    "api.confirm_brief(uuid)": "a",
    "api.daily_brief()": "a",
    "api.feed(text,text,integer,text)": "a",
    "api.feed_status()": "a",
    "api.followed_micro(text[],integer)": "a",
    "api.following_feed(text[],text[],text[],text,integer)": "a",
    "api.number_trends()": "a",
    "api.ops_status(text)": "a",
    "api.related_cards(uuid,integer)": "a",
    "api.search(text,text,integer)": "a",
    "api.search_companies(text,integer)": "a",
    "api.sources()": "a",
    "api.subscribe_brief(text,text,integer,text)": "a",
    "api.top_stories()": "a",
    "api.unsubscribe_brief(uuid)": "a",
    "api.update_brief_subscription(uuid,text,integer,text)": "a",
    "api.weekly_brief()": "a",
    "api.delete_account()": "u",
    "api.delete_my_data()": "u",
    "api.feed_for_you(text,integer)": "u",
    "api.feed_for_you(text,integer,uuid[])": "u",
    "api.get_prefs()": "u",
    "api.my_brief_subscriptions()": "u",
    "api.my_categories()": "u",
    "api.set_prefs(text[],text[],text[])": "u",
    "api.track(uuid,text,integer,uuid,integer,text)": "u",
    "api.unsubscribe_my_brief(text)": "u",
    "api.update_my_brief_time(text,integer,text)": "u"
  }';
  f record;
  v_who text;
begin
  for f in select p.oid::regprocedure as sig, p.oid::regprocedure::text as name
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'api' and p.prokind = 'f' loop
    v_who := v_allow ->> f.name;
    execute format('revoke execute on function %s from public', f.sig);
    if v_who = 'a' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif v_who = 'u' then
      execute format('revoke execute on function %s from anon', f.sig);
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('revoke execute on function %s from anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;

  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'core' and p.prokind = 'f'
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- api.retag_companies, spelled out (finding P2-5): service role only
revoke all on function api.retag_companies(int) from public, anon, authenticated;
grant execute on function api.retag_companies(int) to service_role;

-- The 20261121* migrations replace only the *_base bodies; the macro_focus wrappers must still be in place.
do $$
declare f text;
begin
  foreach f in array array['feed_top(text,text,integer,text)', 'feed_for_you_v5(text,integer)',
                           'feed_for_you_v6(text,integer,bigint,bigint)', 'feed_for_you_v7(text,integer)'] loop
    if (select prosrc from pg_proc where oid = to_regprocedure('core.' || f)) not like '%macro_focus_wrapper%'
       or to_regprocedure('core.' || replace(f, '(', '_base(')) is null then
      raise exception 'api_grants: core.% is not wrapped by macro_focus; re-run 20261116000000_macro_focus.sql', f;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
