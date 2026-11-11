-- Checks for 20261141000000_macro_history.sql: api.macro_history (bounded, oldest first, enabled series only, anon
-- may call) and api.upsert_macro_batch (service role only, validates series, no churn on unchanged rows).
-- expected: ERROR: ALL MACRO HISTORY CHECKS PASSED (test data rolled back on purpose)
do $$
declare
  r jsonb; i int; n int;
begin
  delete from core.macro_observations where series_id in ('DGS10', 'UNRATE', 'DCOILWTICO');
  -- 200 daily readings of DGS10 (more than the 120 cap and more than the 92-day window)
  for i in 0..199 loop
    insert into core.macro_observations (series_id, obs_date, value, display_value) values ('DGS10', current_date - i, 4 + i * 0.001, '4%');
  end loop;
  -- 30 monthly UNRATE readings (window 400 days)
  for i in 0..29 loop
    insert into core.macro_observations (series_id, obs_date, value, display_value) values ('UNRATE', (date_trunc('month', current_date) - (i || ' months')::interval)::date, 4.0 + i * 0.01, '4%');
  end loop;

  r := api.macro_history(array['DGS10', 'UNRATE', 'NOPE', 'DGS10']);
  if r ? 'NOPE' then raise exception 'FAIL: unknown series returned'; end if;
  if r -> 'DGS10' ->> 'frequency' <> 'daily' then raise exception 'FAIL: frequency %', r -> 'DGS10' ->> 'frequency'; end if;
  n := jsonb_array_length(r -> 'DGS10' -> 'points');
  if n < 80 or n > 93 then raise exception 'FAIL: daily window gave % points', n; end if;
  if (r -> 'DGS10' -> 'points' -> 0 ->> 0)::date >= (r -> 'DGS10' -> 'points' -> (n - 1) ->> 0)::date then raise exception 'FAIL: not oldest first'; end if;
  if (r -> 'DGS10' -> 'points' -> (n - 1) ->> 0)::date <> current_date then raise exception 'FAIL: newest point is not the newest reading'; end if;
  n := jsonb_array_length(r -> 'UNRATE' -> 'points');
  if n < 12 or n > 15 then raise exception 'FAIL: monthly window gave % points', n; end if;
  if jsonb_typeof(r -> 'DGS10' -> 'points' -> 0 -> 1) <> 'number' then raise exception 'FAIL: value is not a number'; end if;

  -- at most 6 series, a series with no readings is left out, empty input is {}
  if api.macro_history(null) <> '{}'::jsonb or api.macro_history('{}') <> '{}'::jsonb then raise exception 'FAIL: empty input'; end if;
  if (select count(*) from jsonb_object_keys(api.macro_history(array['DGS10','UNRATE','DCOILWTICO','DGS2','DGS30','DFF','CPIAUCSL','ICSA']))) > 6 then raise exception 'FAIL: more than 6 series'; end if;
  if api.macro_history(array['DCOILWTICO']) ? 'DCOILWTICO' then raise exception 'FAIL: series without readings should be left out'; end if;

  -- a disabled series is never returned
  update core.macro_series set enabled = false where series_id = 'UNRATE';
  if api.macro_history(array['UNRATE']) ? 'UNRATE' then raise exception 'FAIL: disabled series returned'; end if;
  update core.macro_series set enabled = true where series_id = 'UNRATE';

  -- grants: anon + authenticated read, only the service role writes
  if not has_function_privilege('anon', 'api.macro_history(text[])', 'execute') then raise exception 'FAIL: anon cannot read history'; end if;
  if has_function_privilege('public', 'api.macro_history(text[])', 'execute') then raise exception 'FAIL: public may execute history'; end if;
  if has_function_privilege('anon', 'api.upsert_macro_batch(jsonb)', 'execute') or has_function_privilege('authenticated', 'api.upsert_macro_batch(jsonb)', 'execute')
     or has_function_privilege('public', 'api.upsert_macro_batch(jsonb)', 'execute') then raise exception 'FAIL: a client role may write history'; end if;
  if not has_function_privilege('service_role', 'api.upsert_macro_batch(jsonb)', 'execute') then raise exception 'FAIL: service role cannot write history'; end if;

  -- batch: inserts, then the same rows again change nothing, then a changed value updates one row
  n := api.upsert_macro_batch('[{"series_id":"DCOILWTICO","obs_date":"2026-01-02","value":4.1,"display_value":"4.10%","change_text":"+0.01 pts","direction":"up","period_label":null},
                                {"series_id":"DCOILWTICO","obs_date":"2026-01-03","value":4.2,"display_value":"4.20%","change_text":"+0.10 pts","direction":"up","period_label":null}]'::jsonb);
  if n <> 2 then raise exception 'FAIL: batch inserted %', n; end if;
  n := api.upsert_macro_batch('[{"series_id":"DCOILWTICO","obs_date":"2026-01-02","value":4.1,"display_value":"4.10%","change_text":"+0.01 pts","direction":"up","period_label":null}]'::jsonb);
  if n <> 0 then raise exception 'FAIL: an unchanged row was rewritten (%)', n; end if;
  n := api.upsert_macro_batch('[{"series_id":"DCOILWTICO","obs_date":"2026-01-02","value":4.15,"display_value":"4.15%","change_text":"+0.06 pts","direction":"up","period_label":null}]'::jsonb);
  if n <> 1 then raise exception 'FAIL: a revised row was not updated (%)', n; end if;
  begin
    perform api.upsert_macro_batch('[{"series_id":"NOT_A_SERIES","obs_date":"2026-01-02","value":1,"display_value":"1"}]'::jsonb);
    raise exception 'FAIL: unknown series accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  begin
    perform api.upsert_macro_batch('{"a":1}'::jsonb);
    raise exception 'FAIL: non-array accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  raise exception 'ALL MACRO HISTORY CHECKS PASSED (test data rolled back on purpose)';
end $$;
