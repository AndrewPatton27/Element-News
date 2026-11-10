-- Checks for 20261121000000_card_by_id.sql. All rows roll back at the deliberate final error.
do $$
declare
  pub uuid; hid uuid; r jsonb;
begin
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('cardbyid:pub','summary','Shared story','First sentence. Second one.','world','published','[]',now(),now(),now(),10) returning id into pub;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('cardbyid:hid','summary','Hidden story','Body','world','hidden','[]',now(),now(),now(),10) returning id into hid;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'Card check','news','https://example.com/cardbyid/'||dedupe_key,'company_filing',true
  from core.blurbs where dedupe_key like 'cardbyid:%';

  r:=api.card_by_id(pub);
  if r is null or r->>'id'<>pub::text or r->>'headline'<>'Shared story' then raise exception 'FAIL: published card not returned: %',r; end if;
  if r ? 'my_reaction' then raise exception 'FAIL: card_by_id must not carry my_reaction'; end if;
  if jsonb_array_length(r->'sources')<1 then raise exception 'FAIL: card must carry its sources: %',r; end if;
  if api.card_by_id(hid) is not null then raise exception 'FAIL: a hidden card must not be returned'; end if;
  if api.card_by_id(gen_random_uuid()) is not null then raise exception 'FAIL: an unknown id must give null'; end if;
  if not has_function_privilege('anon','api.card_by_id(uuid)','execute') then raise exception 'FAIL: anon must be able to call card_by_id'; end if;
  if has_function_privilege('anon','core.cards_json(uuid[],uuid)','execute') then raise exception 'FAIL: core.cards_json must stay private'; end if;

  raise exception 'ALL CARD_BY_ID CHECKS PASSED';
end $$;
