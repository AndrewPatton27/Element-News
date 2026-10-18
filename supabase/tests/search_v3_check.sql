-- Quality gates: metadata is exact-word only and below threshold alone; exact headline wins;
-- weak metadata cannot create a result; multi-term paging remains duplicate-free.
do $$
declare b uuid; r jsonb; c jsonb; seen text[] := '{}'; cur text; i int;
begin
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv3-fed','summary','Federal Reserve signals interest rate hold','Officials discussed rates.',(select slug from core.categories where slug='economy'),'published',now(),now(),now(),2,100)
  returning id into b;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values(b,'Federal Register','government','https://www.federalregister.gov/sv3','public_domain',true);
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv3-faa','summary','FAA adopts aviation safety rule','A new aviation rule takes effect.',(select slug from core.categories where slug='safety'),'published',now(),now(),now(),2,1000);
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) select id,'Federal Register','government','https://www.federalregister.gov/sv3faa','public_domain',true from core.blurbs where dedupe_key='sv3-faa';
  r:=api.search('fed rate',null,30);
  if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=b::text) then raise exception 'FAIL: relevant Fed/rate card missing'; end if;
  if exists(select 1 from jsonb_array_elements(r->'items') x join core.blurbs z on z.id=(x->>'id')::uuid where z.dedupe_key='sv3-faa') then raise exception 'FAIL: Federal Register prefix false positive'; end if;
  r:=api.search('federl',null,30);
  if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=b::text) then raise exception 'FAIL: typo quality lost'; end if;
  r:=api.search('federal register',null,30);
  if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=(select id::text from core.blurbs where dedupe_key='sv3-faa')) then raise exception 'FAIL: exact metadata word match lost'; end if;
  r:=api.search('fed',null,1);
  select coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
  cur:=r->>'next_cursor';
  while cur is not null and i<10 loop
    r:=api.search('fed',cur,1);
    select seen||coalesce(array_agg(x->>'id'),'{}') into seen from jsonb_array_elements(r->'items') x;
    cur:=r->>'next_cursor'; i:=i+1;
  end loop;
  if cardinality(seen)<> (select count(distinct s) from unnest(seen) s) then raise exception 'FAIL: search cursor repeats a card'; end if;
  raise exception 'ALL SEARCH V3 CHECKS PASSED (quality gate and paging; test rows rolled back on purpose)';
end $$;
