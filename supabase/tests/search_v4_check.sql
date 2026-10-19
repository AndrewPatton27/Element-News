-- Search v4: a match in the visible card (headline, summary, chips) outranks a match found only in
-- the in-depth detail, even when the detail-only card trends far higher; Trending breaks ties;
-- the quality gate still drops weak (source-only) matches; typo and synonym still work;
-- anon can call it; paging has no repeats. Test rows are rolled back on purpose.
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_head uuid; c_body uuid; c_deep uuid; c_syn uuid; c_weak uuid; c_tie_hi uuid; c_tie_lo uuid;
  r jsonb; ids text[]; seen text[] := '{}'; cur text; i int := 0;
begin
  -- "inflation" in the headline, modest trending
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-head','summary','Inflation cools in September','Price growth slowed.','economy','published',now(),now(),now(),2,base)
  returning id into c_head;
  -- "inflation" only in the summary, a bit less trending
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-body','summary','Fed holds interest rates steady','Officials said inflation is still too high.','economy','published',now(),now(),now(),2,base-1)
  returning id into c_body;
  -- "inflation" only deep in the detail, far more trending (50 hours = about 75 times more important)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,detail,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-deep','summary','Snack maker reports quarterly earnings','Revenue rose 5%.','earnings','published',
    '{"key_points":["Revenue rose 5%."],"paragraphs":["Cost cuts aim to offset rising input cost inflation."]}'::jsonb,now(),now(),now(),5,base+50)
  returning id into c_deep;
  -- synonym only: "CPI" in the headline (inflation group), no "inflation" anywhere
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-syn','summary','CPI rises 0.3% in August','Consumer costs rose.','economy','published',now(),now(),now(),2,base-2)
  returning id into c_syn;
  -- weak: the word appears only in the source name (metadata 0.25, below the 0.5 gate)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-weak','summary','Bridge reopens after repairs','Traffic is moving again.','economy','published',now(),now(),now(),2,base+100)
  returning id into c_weak;
  -- two headline matches of a made-up word: only Trending differs
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-tie-lo','summary','Zorvex tariff plan announced','Details follow.','economy','published',now(),now(),now(),2,base+3)
  returning id into c_tie_lo;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv4-tie-hi','summary','Zorvex tariff plan delayed','Details follow.','economy','published',now(),now(),now(),2,base+6)
  returning id into c_tie_hi;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,case when dedupe_key='sv4-weak' then 'Inflation Monitor' else 'SV4 Source' end,'news','https://example.com/'||dedupe_key,'company_filing',true
  from core.blurbs where dedupe_key like 'sv4-%';

  -- 1. visible match beats detail-only match; summary match beats detail-only match too
  r:=api.search('inflation',null,30);
  ids:=(select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if array_position(ids,c_head::text) is null or array_position(ids,c_body::text) is null or array_position(ids,c_deep::text) is null then
    raise exception 'FAIL: inflation should return headline, summary and detail-only cards: %',ids; end if;
  if array_position(ids,c_head::text) > array_position(ids,c_deep::text) then raise exception 'FAIL: headline match must outrank detail-only match'; end if;
  if array_position(ids,c_body::text) > array_position(ids,c_deep::text) then raise exception 'FAIL: summary match must outrank detail-only match'; end if;
  -- 2. same quality (both headline exact): Trending breaks the tie
  if array_position(ids,c_head::text) > array_position(ids,c_body::text) then raise exception 'FAIL: equal matches must follow Trending (head > body)'; end if;
  r:=api.search('zorvex',null,30);
  ids:=(select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if ids is distinct from array[c_tie_hi::text,c_tie_lo::text] then raise exception 'FAIL: tie must be broken by Trending: %',ids; end if;
  -- 3. weak (source-name only) match is still dropped
  if exists(select 1 from jsonb_array_elements(api.search('inflation',null,30)->'items') x where x->>'id'=c_weak::text) then
    raise exception 'FAIL: source-only match must stay below the quality gate'; end if;
  -- 4. typo still works (headline and detail), synonym still works
  r:=api.search('inflaton',null,30);
  ids:=(select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if array_position(ids,c_head::text) is null or array_position(ids,c_deep::text) is null then raise exception 'FAIL: typo match lost: %',ids; end if;
  if array_position(ids,c_head::text) > array_position(ids,c_deep::text) then raise exception 'FAIL: typo: headline must outrank detail-only'; end if;
  if not exists(select 1 from jsonb_array_elements(api.search('inflation',null,30)->'items') x where x->>'id'=c_syn::text) then
    raise exception 'FAIL: synonym (CPI for inflation) lost'; end if;
  if not exists(select 1 from jsonb_array_elements(api.search('cpi',null,30)->'items') x where x->>'id'=c_head::text) then
    raise exception 'FAIL: synonym (inflation for CPI) lost'; end if;
  -- 5. paging: one card per page, no repeats, same set as one big page
  r:=api.search('inflation',null,1);
  select coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
  cur:=r->>'next_cursor';
  while cur is not null and i<20 loop
    r:=api.search('inflation',cur,1);
    select seen||coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
    cur:=r->>'next_cursor'; i:=i+1;
  end loop;
  if cardinality(seen)<>(select count(distinct s) from unnest(seen) s) then raise exception 'FAIL: search cursor repeats a card'; end if;
  if cardinality(seen)<>jsonb_array_length(api.search('inflation',null,30)->'items') then raise exception 'FAIL: paging lost or added cards'; end if;
  -- 6. security: definer, empty search_path, anon and authenticated may call, public may not
  if not exists(select 1 from pg_proc where oid='api.search(text,text,int)'::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must be security definer with an empty search_path'; end if;
  if not has_function_privilege('anon','api.search(text,text,int)','execute') or not has_function_privilege('authenticated','api.search(text,text,int)','execute') then
    raise exception 'FAIL: anon/authenticated must be able to call api.search'; end if;
  set local role anon;
  r:=api.search('inflation',null,5);
  if jsonb_array_length(r->'items')=0 or (r->'items'->0->>'id')<>c_head::text then raise exception 'FAIL: anon search result: %',r->'items'->0->>'headline'; end if;
  reset role;
  raise exception 'ALL SEARCH V4 CHECKS PASSED (placement-aware ranking, gate, typo, synonym, paging, anon; test rows rolled back on purpose)';
end $$;
