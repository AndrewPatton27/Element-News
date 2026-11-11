-- Checks for 20261134000000_m9c_series.sql. Test rows roll back at the deliberate final error.
-- run_log accepts the new source names and still rejects others; the 16 FRED series are seeded with agency citations;
-- BLS calendar, EIA, MTS and auction card keys behave as separate series under core.supersede_series.
do $$
declare
  n int;
begin
  -- run_log: new names accepted, old ones kept, junk refused
  insert into ingest.run_log (source, started_at) values ('blscal', now()), ('mts', now()), ('macro', now());
  begin
    insert into ingest.run_log (source, started_at) values ('not-a-source', now());
    raise exception 'FAIL: run_log accepted an unknown source';
  exception when check_violation then null; end;

  -- 16 series, FRED provider, agency named plus "via FRED", not in the Numbers panel
  select count(*) into n from core.macro_series
   where series_id in ('CCSA','CIVPART','U6RATE','CPILFESL','PPIFIS','PCEPI','PCEPILFE','PSAVERT','INDPRO','TCU','TOTALSL','WALCL','M2SL','PERMIT','HSN1F','DGORDER');
  if n <> 16 then raise exception 'FAIL: expected 16 new series, found %', n; end if;
  if exists (select 1 from core.macro_series
              where series_id in ('CCSA','CIVPART','U6RATE','CPILFESL','PPIFIS','PCEPI','PCEPILFE','PSAVERT','INDPRO','TCU','TOTALSL','WALCL','M2SL','PERMIT','HSN1F','DGORDER')
                and (provider <> 'fred' or in_numbers or source_name not like '% via FRED' or source_name like 'FRED%'
                     or source_url <> 'https://fred.stlouisfed.org/series/' || series_id)) then
    raise exception 'FAIL: a new series has the wrong provider, citation or link'; end if;
  -- never a series with a third-party copyright
  if exists (select 1 from core.macro_series where series_id in ('MORTGAGE30US','MORTGAGE15US','SP500','DJIA','NASDAQCOM','VIXCLS','RRPONTSYD')) then
    raise exception 'FAIL: a forbidden series was seeded'; end if;
  -- sort orders stay unique among the new series
  select count(distinct sort_order) into n from core.macro_series where sort_order between 70 and 85;
  if n <> 16 then raise exception 'FAIL: sort orders 70-85 are not unique (%)', n; end if;

  -- card keys: one live card per report type
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance) values
    ('BLSCAL_CPI:2026-10-14','data','CPI due Wed','Old notice.','economy','published','2026-10-12',now(),'2026-10-12',5),
    ('BLSCAL_CPI:2026-11-10','data','CPI due Tue','New notice.','economy','published','2026-11-07',now(),'2026-11-07',5),
    ('BLSCAL_JOBS:2026-11-06','data','Jobs due Fri','Other report.','economy','published','2026-11-03',now(),'2026-11-03',5),
    ('EIA_PETROLEUM:2026-11-06','data','Crude stocks','A.','energy','published','2026-11-06',now(),'2026-11-06',5),
    ('EIA_SUPPLY:2026-11-06','data','Refinery use','B.','energy','published','2026-11-06',now(),'2026-11-06',5),
    ('EIA_GAS_STORAGE:2026-11-06','data','Gas storage','C.','energy','published','2026-11-06',now(),'2026-11-06',5),
    ('AUCTION_10Y_NOTE:2026-11-10','data','10-year auction','D.','markets','published','2026-11-10',now(),'2026-11-10',5),
    ('AUCTION_30Y_BOND:2026-11-12','data','30-year auction','E.','markets','published','2026-11-12',now(),'2026-11-12',5),
    ('MTS_BUDGET:2026-08-31','data','Deficit Aug','F.','economy','published','2026-08-31',now(),'2026-08-31',5),
    ('MTS_BUDGET:2026-09-30','data','Deficit Sep','G.','economy','published','2026-09-30',now(),'2026-09-30',5);
  select count(*) into n from core.blurbs where status = 'published';
  if n <> 8 then raise exception 'FAIL: expected 8 live cards (one per report type), found %', n; end if;
  if (select status from core.blurbs where dedupe_key = 'BLSCAL_CPI:2026-10-14') <> 'hidden'
     or (select status from core.blurbs where dedupe_key = 'MTS_BUDGET:2026-08-31') <> 'hidden' then
    raise exception 'FAIL: an older notice of the same report must be superseded'; end if;
  if exists (select 1 from core.duplicate_live_series()) then raise exception 'FAIL: duplicate live series'; end if;
  raise exception 'ALL M9C SOURCES CHECKS PASSED (test rows rolled back on purpose)';
end $$;
