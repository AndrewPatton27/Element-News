-- Checks for 20261019000000_set_card_category.sql. All rows roll back at the deliberate final error.
do $$
declare
  pub uuid; hid uuid; r jsonb; got text; cats text[];
begin
  select array_agg(slug order by sort_order) into cats from core.categories;
  if array_length(cats, 1) < 2 then raise exception 'SETUP: need two categories'; end if;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('setcat:pub','summary','Published card','Body','markets','published','[]',now(),now(),now(),10) returning id into pub;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('setcat:hid','summary','Hidden card','Body','markets','hidden','[]',now(),now(),now(),10) returning id into hid;

  r := api.set_card_category(pub, 'economy');
  if r->>'status' <> 'updated' or (select category from core.blurbs where id = pub) <> 'economy' then
    raise exception 'FAIL: published card not re-filed: %', r;
  end if;
  if (select updated_at from core.blurbs where id = pub) is null then raise exception 'FAIL: updated_at not set'; end if;
  if (select status from core.blurbs where id = pub) <> 'published' then raise exception 'FAIL: status changed'; end if;

  r := api.set_card_category(hid, 'economy');
  if r->>'status' <> 'updated' or (select status from core.blurbs where id = hid) <> 'hidden' then
    raise exception 'FAIL: hidden card must be re-filed and stay hidden: %', r;
  end if;

  r := api.set_card_category(gen_random_uuid(), 'economy');
  if r->>'status' <> 'not_found' then raise exception 'FAIL: unknown id: %', r; end if;

  begin
    perform api.set_card_category(pub, 'no-such-category');
    raise exception 'FAIL: unknown slug accepted';
  exception when others then
    if sqlerrm not like 'invalid_category%' then raise; end if;
  end;
  if (select category from core.blurbs where id = pub) <> 'economy' then raise exception 'FAIL: bad slug changed the card'; end if;

  if has_function_privilege('service_role','api.set_card_category(uuid,text)','execute') is not true then raise exception 'FAIL: service_role denied'; end if;
  if has_function_privilege('anon','api.set_card_category(uuid,text)','execute')
     or has_function_privilege('authenticated','api.set_card_category(uuid,text)','execute') then
    raise exception 'FAIL: app roles may call set_card_category';
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='api' and p.proname='set_card_category') then
    raise exception 'FAIL: must be security definer with empty search_path';
  end if;
  raise exception 'ALL set_card_category CHECKS PASSED';
end $$;
