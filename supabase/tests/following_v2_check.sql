-- Checks for 20261018070000_following_v2.sql. Rows roll back at the deliberate final error.
do $$
declare
  dal_old uuid; dal_new uuid; fresh_rel uuid; r jsonb; cur text; seen text[]:='{}'; pg int; ids text[]; sci_name text; pol_name text; i int; p text;
begin
  select name into pol_name from core.categories where slug='policy';
  select name into sci_name from core.categories where slug='science';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('fv2:dal_old','summary','Delta old','B','science','published','[{"symbol":"DAL"}]',now(),now()-interval '48 hours',now()-interval '48 hours',1) returning id into dal_old;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('fv2:dal_new','summary','Delta new','B','science','published','[{"symbol":"DAL"}]',now(),now()-interval '30 hours',now()-interval '30 hours',1) returning id into dal_new;
  -- fresh unrelated-topic card that is only "related" through the shared category of a followed-topic card
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('fv2:rel','summary','Fresh science','B','science','published','[]',now(),now(),now(),5) returning id into fresh_rel;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('fv2:pol','summary','Policy item','B','policy','published','[]',now(),now()-interval '40 hours',now()-interval '40 hours',1);
  for i in 1..60 loop
    insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
    values ('fv2:filler'||i,'summary','Filler '||i,'B','science','published','[]',now(),now()-(i||' minutes')::interval,now()-(i||' minutes')::interval,5);
  end loop;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'FV2 src','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'fv2:%';

  set local role anon;
  r:=api.following_feed(array['policy'],array[]::text[],array['DAL'],null,30);
  ids:=(select array_agg(x->>'id' order by n) from jsonb_array_elements(r->'items') with ordinality e(x,n));
  if array_position(ids,dal_new::text) is null or array_position(ids,dal_old::text) is null then raise exception 'FAIL: direct ticker cards missing: %',ids; end if;
  if array_position(ids,dal_old::text) > array_position(ids,fresh_rel::text) then raise exception 'FAIL: old direct DAL card must outrank fresh related'; end if;
  if array_position(ids,dal_new::text) > array_position(ids,dal_old::text) then raise exception 'FAIL: direct matches newest-first'; end if;
  if (select x->>'follow_reason' from jsonb_array_elements(r->'items') x where x->>'id'=fresh_rel::text) <> 'Related to '||sci_name then
    raise exception 'FAIL: related reason display name: %',(select x->>'follow_reason' from jsonb_array_elements(r->'items') x where x->>'id'=fresh_rel::text); end if;
  if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'follow_reason'='Because you follow '||pol_name) then raise exception 'FAIL: topic reason display name (%)',pol_name; end if;
  if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'follow_reason'='Because you follow DAL') then raise exception 'FAIL: ticker reason'; end if;

  -- paging: 4 pages, no repeats
  cur:=null;
  for pg in 1..4 loop
    r:=api.following_feed(array['policy'],array[]::text[],array['DAL'],cur,15);
    for p in select x->>'id' from jsonb_array_elements(r->'items') x loop
      if p = any(seen) then raise exception 'FAIL: repeated card % on page %',p,pg; end if;
      seen:=seen||p;
    end loop;
    cur:=r->>'next_cursor';
    exit when cur is null;
  end loop;
  if cardinality(seen)<45 then raise exception 'FAIL: paging produced only % cards',cardinality(seen); end if;
  raise exception 'ALL FOLLOWING V2 CHECKS PASSED (test rows rolled back on purpose)';
end $$;
