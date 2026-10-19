-- Checks for 20261019040000_ai_usage.sql and 20261019041000_run_log.sql. All rows roll back at the deliberate final error.
do $$
declare
  ok boolean; n int; j jsonb; rid bigint; today date := (now() at time zone 'utc')::date;
begin
  delete from core.ai_usage where day = today and provider in ('gemini_t', 'groq_t');

  -- take: counts up to the cap, then refuses; the count never passes the cap
  for i in 1..3 loop
    if api.ai_usage_take('gemini_t', 3) is not true then raise exception 'FAIL: take % under the cap refused', i; end if;
  end loop;
  if api.ai_usage_take('gemini_t', 3) is not false then raise exception 'FAIL: take above the cap allowed'; end if;
  select calls into n from core.ai_usage where day = today and provider = 'gemini_t';
  if n <> 3 then raise exception 'FAIL: calls % (expected 3)', n; end if;
  if api.ai_usage_take('groq_t', 0) is not false then raise exception 'FAIL: cap 0 must refuse'; end if;

  -- get: today's counts per provider; another day is empty
  j := api.ai_usage_get();
  if (j->>'gemini_t')::int <> 3 or (j->>'groq_t')::int <> 0 then raise exception 'FAIL: ai_usage_get today %', j; end if;
  if api.ai_usage_get(today - 1) ? 'gemini_t' then raise exception 'FAIL: yesterday must not have the test rows'; end if;

  -- a new day starts from 0; rows older than 60 days are removed on the next take
  insert into core.ai_usage(day, provider, calls) values (today - 61, 'gemini_t', 500), (today - 1, 'gemini_t', 500);
  perform api.ai_usage_take('groq_t', 5);
  if exists (select 1 from core.ai_usage where day = today - 61) then raise exception 'FAIL: old rows not purged'; end if;
  if not exists (select 1 from core.ai_usage where day = today - 1) then raise exception 'FAIL: recent rows purged'; end if;

  -- bad input
  begin perform api.ai_usage_take('Bad Name!', 5); raise exception 'FAIL: bad provider accepted';
  exception when others then if sqlerrm not like 'ai_usage_take: bad provider%' then raise; end if; end;
  begin perform api.ai_usage_take('gemini_t', -1); raise exception 'FAIL: negative cap accepted';
  exception when others then if sqlerrm not like 'ai_usage_take: cap%' then raise; end if; end;

  -- run log
  rid := api.log_run(jsonb_build_object('source', 'fed', 'started_at', now() - interval '90 seconds', 'finished_at', now(),
    'items_new', 5, 'published', 3, 'skipped', 1, 'failed', 1, 'ai_calls', 6, 'error', null,
    'detail', jsonb_build_object('stopped_by', 'work_cap', 'deferred', 4)));
  if rid is null then raise exception 'FAIL: log_run returned null'; end if;
  if not exists (select 1 from ingest.run_log where id = rid and source = 'fed' and published = 3 and ai_calls = 6
                 and detail->>'stopped_by' = 'work_cap' and finished_at > started_at) then
    raise exception 'FAIL: run_log row wrong';
  end if;
  rid := api.log_run('{"source":"brief-summary","error":"boom"}');
  if (select error from ingest.run_log where id = rid) <> 'boom' or (select items_new from ingest.run_log where id = rid) <> 0 then
    raise exception 'FAIL: defaults or error not stored';
  end if;
  insert into ingest.run_log(source, started_at) values ('usgs', now() - interval '31 days');
  perform api.log_run('{"source":"usgs"}');
  if exists (select 1 from ingest.run_log where started_at < now() - interval '30 days') then raise exception 'FAIL: old run_log rows not purged'; end if;
  begin perform api.log_run('{"source":"guardian"}'); raise exception 'FAIL: unknown source accepted';
  exception when check_violation then null; end;
  begin perform api.log_run('{"source":"fed","published":-1}'); raise exception 'FAIL: negative count accepted';
  exception when others then if sqlerrm not like 'log_run: counts%' then raise; end if; end;
  begin perform api.log_run('[1]'); raise exception 'FAIL: array payload accepted';
  exception when others then if sqlerrm not like 'log_run: payload%' then raise; end if; end;

  -- privileges: service role only; tables private with RLS on
  foreach j in array array['"api.ai_usage_take(text,int)"', '"api.ai_usage_get(date)"', '"api.log_run(jsonb)"']::jsonb[] loop
    if has_function_privilege('service_role', j#>>'{}', 'execute') is not true then raise exception 'FAIL: service_role denied %', j; end if;
    if has_function_privilege('anon', j#>>'{}', 'execute') or has_function_privilege('authenticated', j#>>'{}', 'execute') then
      raise exception 'FAIL: app roles may call %', j;
    end if;
  end loop;
  if has_table_privilege('anon', 'core.ai_usage', 'select') or has_table_privilege('authenticated', 'core.ai_usage', 'select')
     or has_table_privilege('anon', 'ingest.run_log', 'select') or has_table_privilege('authenticated', 'ingest.run_log', 'insert') then
    raise exception 'FAIL: app roles can read or write the private tables';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'core.ai_usage'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'ingest.run_log'::regclass) then
    raise exception 'FAIL: RLS must be on';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
             where s.nspname = 'api' and p.proname in ('ai_usage_take', 'ai_usage_get', 'log_run')
               and not (p.prosecdef and p.proconfig @> array['search_path=""'])) then
    raise exception 'FAIL: RPCs must be security definer with an empty search_path';
  end if;
  raise exception 'ALL AI_USAGE RUN_LOG CHECKS PASSED (test rows rolled back on purpose)';
end $$;
