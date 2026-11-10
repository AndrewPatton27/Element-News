-- Following v2 (20261120000400_following_speed.sql): one-pass 'related' tier, URL keys are not a shared prefix.
-- Checks: direct matches first with their reasons; a card sharing the followed card's ticker, topic or number
-- series (series key prefix) is related with the right reason; an unrelated filing card whose dedupe key is also a
-- URL is NOT listed; paging over 300 extra cards has no repeats and the first page is fast (time in the message);
-- grants unchanged. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_dir uuid; c_tick uuid; c_cat uuid; c_ser uuid; c_ser2 uuid; c_unrel uuid;
  r jsonb; items jsonb; seen text[] := '{}'; cur text; i int := 0; t0 timestamptz; ms numeric;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score) values
   ('https://www.sec.gov/fs-dir','summary','Zentro Corp reports quarterly results','Revenue rose.','earnings','published','[{"symbol":"ZNTR","name":"Zentro"}]',now(),now(),now(),6,base+20),
   ('https://www.sec.gov/fs-tick','summary','Zentro Corp names a new finance chief','A new officer.','markets','published','[{"symbol":"ZNTR","name":"Zentro"}]',now(),now(),now()-interval '1 hour',3,base+10),
   ('https://www.sec.gov/fs-cat','summary','Quolla Inc reports quarterly results','Sales fell.','earnings','published','[{"symbol":"QOLL","name":"Quolla"}]',now(),now(),now()-interval '2 hours',6,base+18),
   ('https://www.sec.gov/fs-unrel','summary','Varnik Ltd signs a credit agreement','A new loan.','deals','published','[{"symbol":"VRNK","name":"Varnik"}]',now(),now(),now()-interval '1 hour',4,base+15);
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,macro,as_of,published_at,sort_at,importance,rank_score) values
   ('FSTEST1:2026-10','data','Test index rises to 3.1%','A number.','energy','published','[{"series_id":"FSTEST1"}]',now(),now(),now()-interval '3 hours',10,base+22),
   ('FSTEST1:2026-09','data','Test index falls to 3.0%','A number.','markets','published','[{"series_id":"FSTEST1"}]',now(),now(),now()-interval '700 hours',10,base-670);
  select id into c_dir from core.blurbs where dedupe_key='https://www.sec.gov/fs-dir';
  select id into c_tick from core.blurbs where dedupe_key='https://www.sec.gov/fs-tick';
  select id into c_cat from core.blurbs where dedupe_key='https://www.sec.gov/fs-cat';
  select id into c_unrel from core.blurbs where dedupe_key='https://www.sec.gov/fs-unrel';
  select id into c_ser from core.blurbs where dedupe_key='FSTEST1:2026-10';
  select id into c_ser2 from core.blurbs where dedupe_key='FSTEST1:2026-09';
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'FS Source','filing','https://www.sec.gov/src/'||md5(dedupe_key),'company_filing',true from core.blurbs where dedupe_key like '%fs-%' or dedupe_key like 'FSTEST1:%';

  -- follow the ticker ZNTR and the Energy topic
  r := api.following_feed(array['energy'], '{}', array['ZNTR'], null, 30);
  items := r -> 'items';
  if items -> 0 ->> 'id' not in (c_dir::text, c_ser::text, c_tick::text) then raise exception 'FAIL: a direct match must lead: %', items -> 0 ->> 'headline'; end if;
  if not exists (select 1 from jsonb_array_elements(items) x where x->>'id' = c_tick::text and x->>'follow_reason' = 'Because you follow ZNTR') then
    raise exception 'FAIL: the ZNTR leadership card is a direct ticker match'; end if;
  if not exists (select 1 from jsonb_array_elements(items) x where x->>'id' = c_cat::text and x->>'follow_reason' = 'Related to Earnings') then
    raise exception 'FAIL: same-topic card must be related with "Related to Earnings": %', items; end if;
  -- M9 (20261122000200_series_supersede.sql): the older reading of a series is superseded (hidden), so only the newest shows
  if exists (select 1 from jsonb_array_elements(items) x where x->>'id' = c_ser2::text) then
    raise exception 'FAIL: the older reading of the followed series must be superseded, not shown'; end if;
  if not exists (select 1 from jsonb_array_elements(items) x where x->>'id' = c_ser::text) then
    raise exception 'FAIL: the newest reading of the followed series must show'; end if;
  if exists (select 1 from jsonb_array_elements(items) x where x->>'id' = c_unrel::text) then
    raise exception 'FAIL: an unrelated filing card must not be listed just because both dedupe keys are URLs'; end if;

  -- 300 extra cards in the followed topic: paging, speed
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score)
  select 'https://www.sec.gov/fs-x'||g,'summary','Company '||g||' reports results','Text.',(array['earnings','deals','markets','energy'])[1+g%4],'published',
    jsonb_build_array(jsonb_build_object('symbol','X'||g)),now(),now(),now()-(g||' hours')::interval,4,base-g+16 from generate_series(1,300) g;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'FS Source','filing','https://www.sec.gov/src/'||md5(dedupe_key),'company_filing',true from core.blurbs where dedupe_key like '%fs-x%';
  t0 := clock_timestamp();
  r := api.following_feed(array['energy'], '{}', array['ZNTR'], null, 10);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  loop
    seen := seen || array(select x->>'id' from jsonb_array_elements(r->'items') x);
    cur := r->>'next_cursor'; i := i + 1;
    exit when cur is null or i > 60;
    r := api.following_feed(array['energy'], '{}', array['ZNTR'], cur, 10);
  end loop;
  if (select count(distinct x) from unnest(seen) x) <> cardinality(seen) then raise exception 'FAIL: Following paging repeated a card'; end if;
  if not has_function_privilege('anon','api.following_feed(text[],text[],text[],text,int)','execute') then raise exception 'FAIL: anon must keep execute'; end if;
  raise exception 'ALL FOLLOWING SPEED CHECKS PASSED (% cards over % pages, first page % ms; test rows rolled back on purpose)', cardinality(seen), i, round(ms);
end $$;
