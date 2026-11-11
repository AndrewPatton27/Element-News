-- Checks for 20261137000100_following_entity_links.sql. All rows roll back at the deliberate final error.
-- A story link is shown (related_cards, Following) only when the two cards share a ticker, a CIK or a macro series.
do $$
declare
  anchor uuid; same_tk uuid; same_series uuid; stranger uuid; r jsonb; u uuid;
begin
  select id into u from auth.users where email='element-test-a@example.com';
  update core.blurbs set status='hidden' where status='published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,macro,as_of,published_at,sort_at,importance)
  values ('entlink:anchor','summary','Treasury yield rises','Body','markets','published','[]','[{"series_id":"DGS10","label":"10-yr","value":"4.0%"}]',now(),now(),now(),10) returning id into anchor;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,macro,as_of,published_at,sort_at,importance)
  values ('entlink:series','summary','Treasury yield rises again','Body','markets','published','[]','[{"series_id":"DGS10","label":"10-yr","value":"4.1%"}]',now(),now(),now(),10) returning id into same_series;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,macro,as_of,published_at,sort_at,importance)
  values ('entlink:tk','summary','Northwind reports results','Body','earnings','published','[{"symbol":"NWND","name":"Northwind"}]','[]',now(),now(),now(),10) returning id into same_tk;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,macro,as_of,published_at,sort_at,importance)
  values ('entlink:stranger','summary','Northwind raises guidance','Body','markets','published','[{"symbol":"NWND","name":"Northwind"}]','[]',now(),now(),now(),10) returning id into stranger;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'Entity link check','news','https://example.com/entlink/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'entlink:%';

  if not core.cards_share_entity(anchor,same_series) then raise exception 'FAIL: same macro series must share an entity'; end if;
  if core.cards_share_entity(anchor,same_tk) then raise exception 'FAIL: a yield card and a company card share nothing'; end if;
  if not core.cards_share_entity(same_tk,stranger) then raise exception 'FAIL: same ticker must share an entity'; end if;

  perform api.set_story_link(same_series,anchor,'update');   -- shares DGS10: shown
  perform api.set_story_link(same_tk,anchor,'update');       -- Northwind earnings under a yield card: ignored
  r := api.related_cards(anchor,5);
  if not exists(select 1 from jsonb_array_elements(r) x where x->>'id'=same_series::text and x->'story_link'->>'kind'='update') then
    raise exception 'FAIL: an update that shares the series must be listed: %',r; end if;
  if exists(select 1 from jsonb_array_elements(r) x where x->>'id'=same_tk::text) then
    raise exception 'FAIL: an unrelated card must not be listed as an update: %',r; end if;

  perform set_config('request.jwt.claims',jsonb_build_object('sub',u::text,'role','authenticated')::text,true);
  r := api.following_feed(array['markets'],array[]::text[],array[]::text[],null,20);
  if exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=same_tk::text and x->>'follow_reason'='Update to a story you follow') then
    raise exception 'FAIL: Following labelled an unrelated card "Update to a story you follow": %',r->'items'; end if;
  if (select count(*) from jsonb_array_elements(r->'items') x where x->>'id'=anchor::text)<>1 then
    raise exception 'FAIL: a followed card must appear once'; end if;
  raise exception 'ALL FOLLOWING ENTITY LINK CHECKS PASSED (test rows rolled back on purpose)';
end $$;
