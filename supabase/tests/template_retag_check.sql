-- Checks for 20261124000000_template_retag.sql (with 20261122000200_series_supersede.sql). Rows roll back at the
-- deliberate final error. Covers: data cards -> Economy (Energy kept), FAA orders -> Recalls & Safety (other Federal
-- Register cards and other sources untouched), per-maturity yield cards hidden, the daily YIELDCURVE card keeps ONE live
-- card, no two live cards for the same series, idempotent second run, bounded by the limit, updated_at untouched.
do $$
declare
  y1 uuid; y2 uuid; c1 uuid; c2 uuid; d1 uuid; d2 uuid; e1 uuid; faa uuid; far uuid; sec uuid; r record; n int;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  -- old per-maturity cards (Business) and a CPI card (Business) and an oil card (Energy)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('DGS10:2026-11-05','data','10-year Treasury yield rises to 4.84%','b','markets','published','2026-11-05',now(),'2026-11-05',5) returning id into y1;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('DGS2:2026-11-05','data','2-year Treasury yield rises to 4.46%','b','policy','published','2026-11-05',now(),'2026-11-05',5) returning id into y2;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('CPIAUCSL:2026-09-01','data','Consumer prices up 3.1% from a year earlier in September','b','markets','published','2026-09-01',now(),'2026-09-01',5) returning id into d1;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('DCOILWTICO:2026-11-05','data','WTI crude oil rises to $61.40','b','energy','published','2026-11-05',now(),'2026-11-05',5) returning id into e1;
  update core.blurbs set updated_at = null where id in (y1, y2, d1, e1);
  -- FAA order (Federal Register, category policy), a non-aircraft Federal Register rule, an aircraft story from SEC
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('https://example.test/faa','summary','FAA orders fix for some Boeing 737 planes','b','policy','published',now(),now(),now(),5) returning id into faa;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values (faa,'Federal Register','government','https://www.federalregister.gov/d/x','public_domain',true);
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('https://example.test/rule','summary','Agency tightens rules on bank overdraft fees','b','policy','published',now(),now(),now(),5) returning id into far;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values (far,'Federal Register','government','https://www.federalregister.gov/d/y','public_domain',true);
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('https://example.test/sec','summary','Northwind Air buys 40 aircraft','b','deals','published',now(),now(),now(),5) returning id into sec;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values (sec,'SEC','filing','https://www.sec.gov/a','company_filing',true);

  -- bounded: a limit of 1 changes at most one row per statement
  select * into r from core.retag_templates_m9(1);
  if r.data_to_economy <> 1 or r.faa_to_safety <> 1 or r.yield_cards_hidden <> 1 then
    raise exception 'FAIL: limit 1 must change one row per statement, got %/%/%', r.data_to_economy, r.faa_to_safety, r.yield_cards_hidden; end if;
  select * into r from core.retag_templates_m9();
  if (select count(*) from core.blurbs where kind = 'data' and status = 'published' and category not in ('economy','energy')) <> 0 then
    raise exception 'FAIL: a published data card is still not Economy/Energy'; end if;
  if (select category from core.blurbs where id = e1) <> 'energy' then raise exception 'FAIL: oil card must stay Energy'; end if;
  if (select category from core.blurbs where id = d1) <> 'economy' or (select category from core.blurbs where id = y1) <> 'economy' then
    raise exception 'FAIL: data cards not retagged to Economy'; end if;
  if (select category from core.blurbs where id = faa) <> 'safety' then raise exception 'FAIL: FAA order not filed under Recalls & Safety'; end if;
  if (select category from core.blurbs where id = far) <> 'policy' or (select category from core.blurbs where id = sec) <> 'deals' then
    raise exception 'FAIL: a non-FAA Federal Register card or an SEC aircraft story was retagged'; end if;
  if (select status from core.blurbs where id in (y1) ) <> 'hidden' or (select status from core.blurbs where id = y2) <> 'hidden' then
    raise exception 'FAIL: per-maturity yield cards must be hidden'; end if;
  if (select status from core.blurbs where id = d1) <> 'published' or (select status from core.blurbs where id = e1) <> 'published' then
    raise exception 'FAIL: CPI / oil cards must stay published'; end if;
  if exists (select 1 from core.blurbs where id in (y1, y2, d1, e1) and updated_at is not null) then
    raise exception 'FAIL: updated_at must not be touched (it would show an Updated tag)'; end if;

  -- idempotent: second full run changes nothing
  select * into r from core.retag_templates_m9();
  if r.data_to_economy <> 0 or r.faa_to_safety <> 0 or r.yield_cards_hidden <> 0 then
    raise exception 'FAIL: second run not idempotent: %/%/%', r.data_to_economy, r.faa_to_safety, r.yield_cards_hidden; end if;
  if (select label from core.macro_series where series_id = 'DFF') <> 'Fed funds (effective)' then raise exception 'FAIL: DFF ticker label'; end if;

  -- the daily yield-curve card: a newer one replaces the older one, one live card for the series
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('YIELDCURVE:2026-11-05','data','Treasury yields rise, 10-year at 4.84%','b','economy','published','2026-11-05',now(),'2026-11-05',5) returning id into c1;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('YIELDCURVE:2026-11-06','data','Treasury yields mixed, 10-year at 4.86%','b','economy','published','2026-11-06',now(),'2026-11-06',5) returning id into c2;
  if (select status from core.blurbs where id = c1) <> 'hidden' or (select superseded_by from core.blurbs where id = c1) <> c2 then
    raise exception 'FAIL: the older yield-curve card must be superseded by the newer one'; end if;
  if exists (select 1 from core.duplicate_live_series()) then
    raise exception 'FAIL: two live cards for the same series: %', (select string_agg(series, ',') from core.duplicate_live_series()); end if;
  -- the feed shows exactly one yield-curve card and no per-maturity card
  select count(*) into n from jsonb_array_elements(api.feed('latest', null, 30, null)->'items') x where x->>'id' in (y1::text, y2::text, c1::text, c2::text);
  if n <> 1 then raise exception 'FAIL: the feed must show one yield card, got %', n; end if;
  if has_function_privilege('anon','core.retag_templates_m9(int)','EXECUTE') or has_function_privilege('authenticated','core.retag_templates_m9(int)','EXECUTE') then
    raise exception 'FAIL: client roles can run the retag'; end if;
  raise exception 'ALL TEMPLATE RETAG CHECKS PASSED (test rows rolled back on purpose)';
end $$;
