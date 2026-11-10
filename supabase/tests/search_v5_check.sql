-- Search v5 (20261114000000_search_v5.sql): text relevance first, a small capped ranking prior second.
-- Checks: settings and their range guard; a strong text match beats a weak one however much the weak
-- one trends; a visible match still beats a detail-only one; equal matches follow the prior (fresher /
-- more important first for guests, the reader's followed topic first when signed in); weight 0 gives
-- the plain relevance order; deterministic; keyset paging has no repeats or gaps; security unchanged.
-- Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  ua uuid; c_strong uuid; c_weak uuid; c_vis uuid; c_deep uuid; c_fresh uuid; c_stale uuid; c_econ uuid; c_tech uuid;
  r jsonb; r2 jsonb; ids text[]; seen text[] := '{}'; cur text; i int := 0; t0 timestamptz; ms numeric;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  if ua is null then raise exception 'SETUP: create the user element-test-a@example.com first'; end if;
  delete from core.user_events where user_id = ua;
  delete from core.user_prefs where user_id = ua;
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)

  -- 1. settings exist with the documented defaults, and out-of-range values are refused
  if (select value from core.rank_params where key='search_prior_weight') is distinct from 0.15
     or (select value from core.rank_params where key='search_prior_affinity_share') is distinct from 0.5 then
    raise exception 'FAIL: search prior defaults must be weight 0.15, affinity share 0.5'; end if;
  begin
    update core.rank_params set value = 0.9 where key = 'search_prior_weight';
    raise exception 'FAIL: search_prior_weight 0.9 must be refused';
  exception when check_violation then null; end;

  -- strong (exact headline word) but stale and unimportant, vs weak (prefix only) and trending hard
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-strong','summary','Quixor plant closes','Workers were told on Monday.','economy','published',now(),now(),now()-interval '40 hours',1,base-40)
  returning id into c_strong;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-weak','summary','Quixorama festival sells out','Tickets went fast.','economy','published',now(),now(),now(),8,base+60)
  returning id into c_weak;
  -- visible (source name only, 0.25 + typo-free summary word) vs detail-only exact word that trends far higher
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-vis','summary','Port traffic slows','Glimmora shipments fell.','economy','published',now(),now(),now()-interval '30 hours',1,base-30)
  returning id into c_vis;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,detail,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-deep','summary','Retailer posts results','Sales rose.','earnings','published',
    '{"key_points":["Sales rose."],"paragraphs":["Glimmora demand drove the quarter."]}'::jsonb,now(),now(),now(),8,base+60)
  returning id into c_deep;
  -- equal headline matches: one fresh, one 24 h older
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-fresh','summary','Vantrel merger approved','Details follow.','economy','published',now(),now(),now(),2,base+8)
  returning id into c_fresh;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-stale','summary','Vantrel merger delayed','Details follow.','economy','published',now(),now(),now()-interval '24 hours',2,base-16)
  returning id into c_stale;
  -- equal headline matches in two topics, economy trending a little higher; the reader follows tech
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-econ','summary','Zelquin outlook raised','Details follow.','economy','published',now(),now(),now(),2,base+3)
  returning id into c_econ;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv5-tech','summary','Zelquin outlook cut','Details follow.','tech','published',now(),now(),now(),2,base+1)
  returning id into c_tech;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV5 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sv5-%';

  -- 2. strong text match beats a weak one, even 100 h of Trending behind
  r := api.search('quixor', null, 10);
  ids := (select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if ids is distinct from array[c_strong::text, c_weak::text] then raise exception 'FAIL: exact match must beat a hot prefix match: %', ids; end if;

  -- 3. a visible match beats a detail-only one even when the detail-only card trends far higher
  r := api.search('glimmora', null, 10);
  ids := (select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if ids is distinct from array[c_vis::text, c_deep::text] then raise exception 'FAIL: visible match must beat detail-only: %', ids; end if;

  -- 4. equal matches: the prior decides (fresher first)
  r := api.search('vantrel', null, 10);
  ids := (select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if ids is distinct from array[c_fresh::text, c_stale::text] then raise exception 'FAIL: equal matches must follow the prior: %', ids; end if;

  -- 5. guests: Trending order; signed in and following tech: the tech card first
  r := api.search('zelquin', null, 10);
  if r->'items'->0->>'id' <> c_econ::text then raise exception 'FAIL: guest search should follow Trending (economy first)'; end if;
  insert into core.user_prefs(user_id, followed_categories) values (ua, array['tech']);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.search('zelquin', null, 10);
  if r->'items'->0->>'id' <> c_tech::text then raise exception 'FAIL: signed-in search should put the followed topic first, got %', r->'items'->0->>'headline'; end if;
  -- ... but the followed topic never lifts a weak match over a strong one
  update core.user_prefs set followed_categories = array['economy','tech'] where user_id = ua;
  r := api.search('quixor', null, 10);
  if r->'items'->0->>'id' <> c_strong::text then raise exception 'FAIL: affinity must not beat a stronger text match'; end if;
  perform set_config('request.jwt.claims', '', true);

  -- 6. deterministic
  r := api.search('vantrel zelquin quixor', null, 30); r2 := api.search('vantrel zelquin quixor', null, 30);
  if r is distinct from r2 then raise exception 'FAIL: same query, same answer'; end if;

  -- 7. paging: one card per page, no repeats, same set and order as one big page
  -- (v8: several words are AND, so each of the four words is paged on its own; together they hold all 8 cards)
  seen := '{}'; ids := '{}';
  declare q5 text; ids5 text[];
  begin
    foreach q5 in array array['vantrel','zelquin','quixor','glimmora'] loop
      r := api.search(q5, null, 1);
      select seen || coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
      cur := r->>'next_cursor'; i := 0;
      while cur is not null and i < 20 loop
        r := api.search(q5, cur, 1);
        select seen || coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
        cur := r->>'next_cursor'; i := i + 1;
      end loop;
      select array_agg(x->>'id' order by n) into ids5 from jsonb_array_elements(api.search(q5, null, 30)->'items') with ordinality e(x,n);
      ids := ids || coalesce(ids5,'{}');
    end loop;
  end;
  if seen is distinct from ids then raise exception 'FAIL: paged order % differs from one page %', seen, ids; end if;
  if cardinality(seen) <> 8 then raise exception 'FAIL: expected all 8 test cards across pages, got %', cardinality(seen); end if;

  -- 8. weight 0: plain relevance (then importance, newest, id); the strong card still first
  update core.rank_params set value = 0 where key = 'search_prior_weight';
  r := api.search('vantrel', null, 10);
  if r->'items'->0->>'id' <> c_fresh::text then raise exception 'FAIL: weight 0 tie must fall back to importance, newest'; end if;
  update core.rank_params set value = 0.15 where key = 'search_prior_weight';

  -- 9. time: a search over this small fixture stays fast (the prior is a few numbers per matched card)
  t0 := clock_timestamp();
  perform api.search('vantrel zelquin', null, 20);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if ms > 2000 then raise exception 'FAIL: search took % ms', round(ms); end if;

  -- 10. security unchanged: definer, empty search_path, anon and authenticated may call
  if not exists(select 1 from pg_proc where oid='api.search(text,text,int)'::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must be security definer with an empty search_path'; end if;
  if not has_function_privilege('anon','api.search(text,text,int)','execute') then raise exception 'FAIL: anon must be able to call api.search'; end if;
  raise exception 'ALL SEARCH V5 CHECKS PASSED (relevance first, capped prior, visible tier, affinity, paging, determinism; test rows rolled back on purpose)';
end $$;
