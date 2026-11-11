-- Checks for 20261138000000_m9c3_sources.sql. Test rows roll back at the deliberate final error.
-- run_log accepts the four new source names, keeps the old ones and still rejects junk; the four BLS CPI series are seeded and
-- cite the agency; Beige Book preview/release share a series (release replaces preview); trade notices and regulator releases
-- (kind summary) never supersede each other; annual figures are one series each.
do $$
declare
  n int;
begin
  insert into ingest.run_log (source, started_at) values ('beige', now()), ('trade', now()), ('regpress', now()), ('annual', now()), ('blscal', now()), ('bls', now()), ('macro', now());
  begin
    insert into ingest.run_log (source, started_at) values ('not-a-source', now());
    raise exception 'FAIL: run_log accepted an unknown source';
  exception when check_violation then null; end;

  select count(*) into n from core.macro_series where series_id in ('BLS_CPI_FOOD_HOME','BLS_CPI_RENT','BLS_CPI_ELECTRICITY','BLS_CPI_MEDICAL');
  if n <> 4 then raise exception 'FAIL: expected 4 BLS CPI series, found %', n; end if;
  if exists (select 1 from core.macro_series
              where series_id like 'BLS_CPI_%' and (provider <> 'bls' or in_numbers or source_name <> 'U.S. Bureau of Labor Statistics' or source_name ilike '%FRED%')) then
    raise exception 'FAIL: a BLS CPI series has the wrong provider or citation'; end if;
  select count(distinct sort_order) into n from core.macro_series where sort_order between 86 and 89;
  if n <> 4 then raise exception 'FAIL: sort orders 86-89 are not unique (%)', n; end if;

  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance) values
    ('BEIGE_BOOK:2026-11-25','data','Beige Book preview','A.','economy','published','2026-11-22',now(),'2026-11-22',5),
    ('BEIGE_BOOK:2026-11-25b','data','Beige Book release','B.','economy','published','2026-11-25',now(),'2026-11-25',5),
    ('ANNUAL_SSA_COLA:2026-10-14','data','COLA','C.','personal-finance','published','2026-10-14',now(),'2026-10-14',5),
    ('ANNUAL_IRS_LIMITS:2026-11-13','data','401k limits','D.','personal-finance','published','2026-11-13',now(),'2026-11-13',5),
    ('FRTRADE:2026-22925','summary','USTR extends tariff exclusions','E.','policy','published','2026-11-10',now(),'2026-11-10',5),
    ('FRTRADE:2026-22926','summary','USTR extends a Section 301 probe','F.','policy','published','2026-11-10',now(),'2026-11-10',5),
    ('REGPRESS-occ-aaaaaaaaaa','summary','OCC digital asset rule','G.','policy','published','2026-10-21',now(),'2026-10-21',5),
    ('REGPRESS-occ-bbbbbbbbbb','summary','OCC stablecoin rule','H.','policy','published','2026-10-22',now(),'2026-10-22',5),
    ('EIA_DIESEL:2026-11-02','data','Diesel','I.','energy','published','2026-11-02',now(),'2026-11-02',5),
    ('EIA_DIESEL:2026-11-09','data','Diesel newer','J.','energy','published','2026-11-09',now(),'2026-11-09',5),
    ('BLS_CPI_RENT:2026-08-01','data','Rent Aug','K.','economy','published','2026-08-01',now(),'2026-08-01',5),
    ('BLS_CPI_RENT:2026-09-01','data','Rent Sep','L.','economy','published','2026-09-01',now(),'2026-09-01',5);
  select count(*) into n from core.blurbs where status = 'published';
  if n <> 9 then raise exception 'FAIL: expected 9 live cards, found %', n; end if;
  if (select status from core.blurbs where dedupe_key = 'BEIGE_BOOK:2026-11-25') <> 'hidden' then
    raise exception 'FAIL: the Beige Book release must replace its preview'; end if;
  if (select status from core.blurbs where dedupe_key = 'EIA_DIESEL:2026-11-02') <> 'hidden' then
    raise exception 'FAIL: an older diesel week must be superseded'; end if;
  if exists (select 1 from core.blurbs where status = 'hidden' and kind = 'summary') then
    raise exception 'FAIL: a trade or regulator card (kind summary) was superseded'; end if;
  if exists (select 1 from core.duplicate_live_series()) then raise exception 'FAIL: duplicate live series'; end if;
  raise exception 'ALL M9C3 SOURCES CHECKS PASSED (test rows rolled back on purpose)';
end $$;
