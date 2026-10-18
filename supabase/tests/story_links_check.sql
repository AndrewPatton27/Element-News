-- Checks for 20261018060000_story_links.sql. All rows roll back at the deliberate final error.
do $$
declare
  followed uuid; upd uuid; ang uuid; rel uuid; r jsonb; u uuid;
begin
  select id into u from auth.users where email='element-test-a@example.com';
  if u is null then raise exception 'SETUP: create element-test-a@example.com'; end if;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('storylink:followed','summary','Followed story','Body','markets','published','[]',now(),now(),now(),10) returning id into followed;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('storylink:update','summary','Update story','Body','world','published','[]',now(),now(),now(),10) returning id into upd;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('storylink:angle','summary','Angle story','Body','world','published','[]',now(),now(),now(),10) returning id into ang;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('storylink:related','summary','Related story','Body','world','published','[]',now(),now(),now(),10) returning id into rel;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'Story link check','news','https://example.com/storylink/'||dedupe_key,'company_filing',true
  from core.blurbs where dedupe_key like 'storylink:%';

  perform api.set_story_link(upd,followed,'related');
  perform api.set_story_link(upd,followed,'update');
  perform api.set_story_link(ang,followed,'angle');
  perform api.set_story_link(rel,followed,'related');
  if (select count(*) from core.story_links where card_id=upd and related_id=followed)<>1
    or (select kind from core.story_links where card_id=upd and related_id=followed)<>'update' then
    raise exception 'FAIL: set_story_link must be idempotent and update existing kind';
  end if;

  r:=api.related_cards(followed,3);
  if (select array_agg(x->>'id') from jsonb_array_elements(r) x)<>array[upd::text,ang::text,rel::text] then
    raise exception 'FAIL: related_cards ordering update > angle > related: %',r;
  end if;
  if r->0->'story_link'->>'kind'<>'update' or r->1->'story_link'->>'kind'<>'angle' or r->2->'story_link'->>'kind'<>'related' then
    raise exception 'FAIL: related_cards story_link metadata';
  end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',u::text,'role','authenticated')::text,true);
  r:=api.following_feed(array['markets'],array[]::text[],array[]::text[],null,20);
  if (select min(n) from jsonb_array_elements(r->'items') with ordinality e(x,n) where x->>'id' in (upd::text,ang::text)) >=
     (select min(n) from jsonb_array_elements(r->'items') with ordinality e(x,n) where x->>'id'=rel::text) then
    raise exception 'FAIL: Following updates/angles must rank above plain related: %',r->'items';
  end if;
  if (select x->>'follow_reason' from jsonb_array_elements(r->'items') x where x->>'id'=upd::text)<>'Update to a story you follow'
    or (select x->>'follow_reason' from jsonb_array_elements(r->'items') x where x->>'id'=ang::text)<>'Another angle on a story you follow'
    or (select x->>'follow_reason' from jsonb_array_elements(r->'items') x where x->>'id'=rel::text)<>'Related to something you follow' then
    raise exception 'FAIL: Following reasons';
  end if;
  if has_function_privilege('anon','api.set_story_link(uuid,uuid,text)','EXECUTE') then raise exception 'FAIL: anon can call set_story_link'; end if;
  raise exception 'ALL STORY LINK CHECKS PASSED (test rows rolled back on purpose)';
end $$;
