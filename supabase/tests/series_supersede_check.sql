-- Checks for 20261122000200_series_supersede.sql. Test rows roll back at the deliberate final error.
-- No two live cards for the same series; the newest observation stays live whatever the insert order; other series
-- and non-data cards are untouched; a hidden reading restored to published is superseded again; backfill idempotent.
do $$
declare
  a1 uuid; a2 uuid; a3 uuid; b1 uuid; s1 uuid; late uuid; declare_n int;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVSER:2026-11-04','data','Series A rose to 4.80%','Reading 1.','economy','published','2026-11-04',now(),'2026-11-04',5) returning id into a1;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVSER:2026-11-05','data','Series A rose to 4.84%','Reading 2.','economy','published','2026-11-05',now(),'2026-11-05',5) returning id into a2;
  if (select status from core.blurbs where id = a1) <> 'hidden' or (select superseded_by from core.blurbs where id = a1) <> a2 then
    raise exception 'FAIL: the older reading must be hidden and point at the newer one'; end if;
  if (select status from core.blurbs where id = a2) <> 'published' then raise exception 'FAIL: the newest reading must stay live'; end if;

  -- a late older reading never replaces the newer one: it is superseded on arrival
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVSER:2026-11-03','data','Series A at 4.70%','Late reading.','economy','published','2026-11-03',now(),'2026-11-03',5) returning id into late;
  if (select status from core.blurbs where id = late) <> 'hidden' or (select status from core.blurbs where id = a2) <> 'published' then
    raise exception 'FAIL: a late older reading must not replace the newest'; end if;

  -- a newer one replaces a2
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVSER:2026-11-06','data','Series A rose to 4.86%','Reading 3.','economy','published','2026-11-06',now(),'2026-11-06',5) returning id into a3;
  if (select status from core.blurbs where id = a2) <> 'hidden' or (select superseded_by from core.blurbs where id = a2) <> a3 then
    raise exception 'FAIL: the newest reading must supersede the previous live one'; end if;

  -- another series and a summary card with a similar key are untouched
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVOTHER:2026-11-06','data','Series B at 2.1%','B.','economy','published','2026-11-06',now(),'2026-11-06',5) returning id into b1;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance)
  values ('SVSER:note','summary','A story about series A','Not a data card.','economy','published','2026-11-06',now(),'2026-11-06',5) returning id into s1;
  if (select status from core.blurbs where id = b1) <> 'published' or (select status from core.blurbs where id = s1) <> 'published' then
    raise exception 'FAIL: another series or a non-data card was hidden'; end if;

  -- restoring an old reading re-supersedes it
  update core.blurbs set status = 'published' where id = a1;
  if (select status from core.blurbs where id = a1) <> 'hidden' then raise exception 'FAIL: a restored old reading must be superseded again'; end if;

  -- the headline rule of this release: no two live cards for the same series
  if exists (select 1 from core.duplicate_live_series()) then
    raise exception 'FAIL: two live cards for the same series: %', (select string_agg(series, ',') from core.duplicate_live_series()); end if;
  -- idempotent
  if core.supersede_series('SVSER') <> 0 then raise exception 'FAIL: supersede_series not idempotent'; end if;
  -- bypass the trigger to build a duplicate, then the function repairs it
  alter table core.blurbs disable trigger blurbs_supersede_series;
  update core.blurbs set status = 'published' where id = a2;
  alter table core.blurbs enable trigger blurbs_supersede_series;
  if not exists (select 1 from core.duplicate_live_series()) then raise exception 'FAIL: test setup (duplicate)'; end if;
  declare_n := core.supersede_series('SVSER'); if declare_n <> 1 or exists (select 1 from core.duplicate_live_series()) then raise exception 'FAIL: repair % %', declare_n, (select string_agg(series||live_cards, ',') from core.duplicate_live_series()); end if;
  -- the feed shows one card of the series
  if (select count(*) from jsonb_array_elements(api.feed('latest', null, 30, null)->'items') x where x->>'id' in (a1::text, a2::text, a3::text, late::text)) <> 1 then
    raise exception 'FAIL: the feed must show one card for the series'; end if;
  if has_function_privilege('anon','core.supersede_series(text)','EXECUTE') or has_function_privilege('authenticated','core.supersede_series(text)','EXECUTE') then
    raise exception 'FAIL: client roles can run supersede_series'; end if;
  raise exception 'ALL SERIES SUPERSEDE CHECKS PASSED (test rows rolled back on purpose)';
end $$;
