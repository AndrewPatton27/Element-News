-- Checks for 20261125000000_brief_window_fallback.sql; runs after that migration.
--   expected:     ERROR: ALL BRIEF WINDOW FALLBACK CHECKS PASSED (test rows rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
do $$
declare r jsonb; newid uuid; s record;
begin
  -- Monday = 72 h, other days 24 h, judged in New York incl. the DST edges of 2026
  if core.brief_window_hours('2026-11-02 12:00+00') <> 72 then raise exception 'FAIL: Monday noon should be 72'; end if;
  if core.brief_window_hours('2026-11-03 12:00+00') <> 24 then raise exception 'FAIL: Tuesday should be 24'; end if;
  if core.brief_window_hours('2026-11-01 12:00+00') <> 24 then raise exception 'FAIL: Sunday should be 24'; end if;
  if core.brief_window_hours('2026-03-09 03:30+00') <> 24 then raise exception 'FAIL: Sunday 23:30 EDT (DST start day) should be 24'; end if;
  if core.brief_window_hours('2026-03-09 04:30+00') <> 72 then raise exception 'FAIL: Monday 00:30 EDT should be 72'; end if;
  if core.brief_window_hours('2026-11-02 04:30+00') <> 24 then raise exception 'FAIL: Sunday 23:30 EST (DST end) should be 24'; end if;
  if core.brief_window_hours('2026-11-02 05:30+00') <> 72 then raise exception 'FAIL: Monday 00:30 EST should be 72'; end if;

  -- one old card (200 h) and nothing newer: brief is not empty, flagged fallback, dated
  update core.blurbs set sort_at = now() - interval '400 days';
  insert into core.blurbs (dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score)
  values ('bwf:1','summary','Fallback fixture story','Plain body.','economy','published','[]'::jsonb,now()-interval '200 hours',now()-interval '200 hours',now()-interval '200 hours',5,1000000)
  returning id into newid;
  insert into core.blurb_sources (blurb_id,name,kind,url,license_class,is_primary)
  values (newid,'Fallback Source','news','https://example.com/bwf','company_filing',true);
  r := api.daily_brief();
  if not (r->>'fallback')::boolean then raise exception 'FAIL: expected fallback'; end if;
  if jsonb_array_length(r->'headline_cards') < 1 then raise exception 'FAIL: fallback brief must have cards'; end if;
  if (r->>'window_hours')::int < 200 or (r->>'window_hours')::int > 720 then raise exception 'FAIL: fallback window % out of range', r->>'window_hours'; end if;
  if r->>'as_of' is null or r->>'brief_date' is null then raise exception 'FAIL: as_of and brief_date needed'; end if;

  -- a card older than 720 h: nothing to show, not an error, not flagged
  update core.blurbs set sort_at = now() - interval '800 hours' where dedupe_key = 'bwf:1';
  r := api.daily_brief();
  if jsonb_array_length(r->'headline_cards') <> 0 or (r->>'fallback')::boolean or r->>'as_of' is not null then raise exception 'FAIL: nothing within 720 h'; end if;

  -- summary: today's missing -> the latest earlier one, with for_date
  perform api.put_brief_summary('daily', date '2026-01-05', 'Older summary', 'fixture');
  perform api.put_brief_summary('daily', date '2026-01-06', 'Newer summary', 'fixture');
  r := api.daily_brief();
  if r->'summary'->>'text' <> 'Newer summary' or r->'summary'->>'for_date' <> '2026-01-06' then raise exception 'FAIL: summary fallback %', r->'summary'; end if;
  perform api.put_brief_summary('weekly', date '2026-01-05', 'Weekly old', 'fixture');
  if api.weekly_brief()->'summary'->>'text' <> 'Weekly old' then raise exception 'FAIL: weekly summary fallback'; end if;
  if api.weekly_brief()->>'window_kind' <> 'week' then raise exception 'FAIL: weekly window_kind'; end if;

  -- helpers private, brief RPCs still public
  if has_function_privilege('anon','core.brief_window_hours(timestamptz)','execute') or has_function_privilege('anon','core.brief_effective_window(int)','execute')
     or has_function_privilege('anon','core.brief_last_card_at()','execute') then raise exception 'FAIL: helpers must be private'; end if;
  if has_function_privilege('anon','api.daily_brief()','execute') is not true then raise exception 'FAIL: grants'; end if;

  raise exception 'ALL BRIEF WINDOW FALLBACK CHECKS PASSED (test rows rolled back on purpose)';
end $$;
