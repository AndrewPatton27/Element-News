-- =============================================================================
-- web_column_check.sql: checks for 20261017090000_web_side_column.sql
--   api.top_stories (max 5, last 7 days, no duplicate story) and api.number_trends.
-- Supabase SQL editor: paste the whole file and run it.
--   expected:     ERROR: ALL WEB COLUMN CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- =============================================================================
do $$
declare
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  r    jsonb;
  t    jsonb;
  i    int;
begin
  -- 7 cards: two share a headline, one is 10 days old, one shares a ticker with the best
  for i in 1..7 loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, sort_at, rank_score, tickers)
    values ('webcheck:' || i, 'summary',
            case when i = 2 then 'Webcheck story 1' else 'Webcheck story ' || i end,
            'Body.', (select slug from core.categories order by sort_order limit 1), 'published',
            now(), case when i = 5 then now() - interval '10 days' else now() end,
            base + 1000 - i,
            case when i = 3 then '[{"symbol":"WCHK","name":"Webcheck"}]'::jsonb
                 when i = 4 then '[{"symbol":"WCHK","name":"Webcheck"}]'::jsonb else '[]'::jsonb end);
  end loop;
  update core.blurbs set headline = 'Webcheck story 1' where dedupe_key = 'webcheck:2';

  r := api.top_stories();
  if jsonb_array_length(r) > 5 then raise exception 'FAIL: more than 5 stories'; end if;
  if (select count(*) from jsonb_array_elements(r) c where c ->> 'headline' = 'Webcheck story 1') <> 1 then
    raise exception 'FAIL: duplicate headline in top stories';
  end if;
  if (select count(*) from jsonb_array_elements(r) c where c -> 'tickers' -> 0 ->> 'symbol' = 'WCHK') > 1 then
    raise exception 'FAIL: same ticker twice in top stories';
  end if;
  if exists (select 1 from jsonb_array_elements(r) c where c ->> 'headline' = 'Webcheck story 5') then
    raise exception 'FAIL: a card older than 7 days is in top stories';
  end if;
  if exists (select 1 from jsonb_array_elements(r) c where c ? 'my_reaction') then
    raise exception 'FAIL: my_reaction leaked';
  end if;

  -- number trends: 14 weekly readings of DGS10, 3 monthly of UNRATE
  delete from core.macro_observations where series_id in ('DGS10', 'UNRATE');
  for i in 0..13 loop
    insert into core.macro_observations (series_id, obs_date, value, display_value)
    values ('DGS10', current_date - 7 * (13 - i), 4 + i * 0.1, round(4 + i * 0.1, 2) || '%');
  end loop;
  insert into core.macro_observations (series_id, obs_date, value, display_value) values
    ('UNRATE', current_date - 90, 4.1, '4.1%'), ('UNRATE', current_date - 60, 4.2, '4.2%'), ('UNRATE', current_date - 30, 4.2, '4.2%');

  r := api.number_trends();
  t := (select c from jsonb_array_elements(r) c where c ->> 'key' = 'DGS10');
  if t is null then raise exception 'FAIL: DGS10 missing'; end if;
  if jsonb_array_length(t -> 'points') <> 12 then raise exception 'FAIL: DGS10 needs 12 points'; end if;
  if (t -> 'points' ->> 11)::numeric <> 5.3 or (t -> 'points' ->> 0)::numeric <> 4.2 then raise exception 'FAIL: points not oldest first'; end if;
  if t ->> 'direction' <> 'up' or t ->> 'change' <> '▲ 0.10 this week' then raise exception 'FAIL: DGS10 change %', t ->> 'change'; end if;
  t := (select c from jsonb_array_elements(r) c where c ->> 'key' = 'UNRATE');
  if t ->> 'direction' <> 'flat' or t ->> 'change' <> '● unchanged' or jsonb_array_length(t -> 'points') <> 3 then
    raise exception 'FAIL: UNRATE trend %', t;
  end if;
  if has_function_privilege('public', 'api.top_stories()', 'execute') then raise exception 'FAIL: public may execute'; end if;

  raise exception 'ALL WEB COLUMN CHECKS PASSED (test data rolled back on purpose)';
end $$;
