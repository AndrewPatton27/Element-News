-- Checks for 20261110000000_watchdog.sql (feed_status, ops_status, ai_caps and the reserve, run_start /
-- log_run and hung-run marking). Run after all migrations (PGlite: no pg_cron, pg_net or Vault, so the check
-- creates a stand-in vault.decrypted_secrets table inside the block). Everything rolls back at the final error.
do $$
declare
  j jsonb; n int; rid bigint; rid2 bigint; today date := (now() at time zone 'utc')::date;
  tok constant text := 'test-watchdog-token-0123456789-abcdefghij';
begin
  delete from ingest.run_log;
  delete from core.blurbs;
  delete from core.ai_usage where day = today;

  -- feed_status: nothing at all -> delayed
  j := api.feed_status();
  if (j->>'delayed')::boolean is not true or j->>'last_ok_run_at' is not null then raise exception 'FAIL: empty feed_status %', j; end if;

  -- an ok run 2 h 59 min ago: not delayed; 3 h 1 min ago: delayed (cards also old)
  insert into ingest.run_log(source, started_at, finished_at) values ('fed', now() - interval '3 hours', now() - interval '179 minutes');
  if (api.feed_status()->>'delayed')::boolean then raise exception 'FAIL: delayed at 2h59m'; end if;
  delete from ingest.run_log;
  insert into ingest.run_log(source, started_at, finished_at) values ('fed', now() - interval '4 hours', now() - interval '181 minutes');
  if (api.feed_status()->>'delayed')::boolean is not true then raise exception 'FAIL: not delayed at 3h01m'; end if;

  -- a failed run and a brief-summary run do not count as proof of life
  insert into ingest.run_log(source, started_at, finished_at, error) values ('sec', now() - interval '5 min', now() - interval '4 min', 'boom');
  insert into ingest.run_log(source, started_at, finished_at) values ('brief-summary', now() - interval '5 min', now() - interval '4 min');
  if (api.feed_status()->>'delayed')::boolean is not true then raise exception 'FAIL: error/brief rows counted as ok'; end if;
  if api.feed_status()->>'last_ok_run_at' is null then null; end if;

  -- a quiet weekend: ok run 20 min ago, newest card 60 h old -> not delayed
  insert into ingest.run_log(source, started_at, finished_at) values ('macro', now() - interval '21 min', now() - interval '20 min');
  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, published_at)
  select 'wd-old', 'summary', 'Old card', slug, now() - interval '60 hours', now() - interval '60 hours', now() - interval '60 hours'
    from core.categories limit 1;
  if (api.feed_status()->>'delayed')::boolean then raise exception 'FAIL: quiet weekend counted as delayed'; end if;
  if api.feed_status()->>'last_published_at' is null then raise exception 'FAIL: last_published_at missing'; end if;

  -- run_start leaves finished_at null; log_run with id finishes the same row; without id inserts
  rid := api.run_start('{"source":"fed"}');
  if (select finished_at from ingest.run_log where id = rid) is not null then raise exception 'FAIL: start row already finished'; end if;
  if rid <> api.log_run(jsonb_build_object('id', rid, 'source', 'fed', 'items_new', 2, 'published', 1, 'detail', '{"stopped_by":"done"}'::jsonb)) then
    raise exception 'FAIL: log_run with id made a new row';
  end if;
  if not exists (select 1 from ingest.run_log where id = rid and finished_at is not null and published = 1 and items_new = 2) then
    raise exception 'FAIL: start row not completed';
  end if;
  select count(*) into n from ingest.run_log;
  perform api.log_run('{"source":"fed"}');
  if (select count(*) from ingest.run_log) <> n + 1 then raise exception 'FAIL: log_run without id must insert'; end if;
  begin perform api.run_start('[1]'); raise exception 'FAIL: array accepted';
  exception when others then if sqlerrm not like 'run_start: payload%' then raise; end if; end;

  -- hung runs: open > 10 min is reported, then the next log_run marks it killed; a fresh open run is left alone
  rid := api.run_start('{"source":"usgs","started_at":"2000-01-01T00:00:00Z"}');
  update ingest.run_log set started_at = now() - interval '11 minutes' where id = rid;
  rid2 := api.run_start('{"source":"cpsc"}');
  perform set_config('wd.rid', rid::text, true);
  -- ops_status needs the Vault token; stand in for Vault
  create schema if not exists vault;
  create table vault.decrypted_secrets (name text, decrypted_secret text);
  insert into vault.decrypted_secrets values ('element_watchdog_token', tok);

  begin perform api.ops_status('wrong-token-wrong-token'); raise exception 'FAIL: wrong token accepted';
  exception when others then if sqlerrm not like 'ops_status: not allowed' then raise; end if; end;
  begin perform api.ops_status(null); raise exception 'FAIL: null token accepted';
  exception when others then if sqlerrm not like 'ops_status: not allowed' then raise; end if; end;
  begin perform api.ops_status('short'); raise exception 'FAIL: short token accepted';
  exception when others then if sqlerrm not like 'ops_status: not allowed' then raise; end if; end;

  j := api.ops_status(tok);
  if (j->>'hung_open')::int <> 1 then raise exception 'FAIL: hung_open % (expected 1)', j; end if;
  if (j->>'killed_24h')::int <> 0 then raise exception 'FAIL: killed too early %', j; end if;
  if j->'jobs' <> 'null'::jsonb then raise exception 'FAIL: jobs must be null without pg_cron %', j; end if;
  if jsonb_typeof(j->'ai') <> 'array' or jsonb_array_length(j->'ai') < 2 then raise exception 'FAIL: ai section %', j; end if;

  perform api.log_run('{"source":"wiki"}');
  if (select error from ingest.run_log where id = rid) not like 'killed:%' or (select finished_at from ingest.run_log where id = rid) is null then
    raise exception 'FAIL: hung run not marked killed';
  end if;
  if (select finished_at from ingest.run_log where id = rid2) is not null then raise exception 'FAIL: fresh open run was closed'; end if;
  j := api.ops_status(tok);
  if (j->>'hung_open')::int <> 0 or (j->>'killed_24h')::int <> 1 then raise exception 'FAIL: after marking %', j; end if;

  -- model_missing from the run summary stats
  perform api.log_run('{"source":"fed","detail":{"stats":{"model_missing":true}}}');
  if (api.ops_status(tok)->>'model_missing')::int <> 1 then raise exception 'FAIL: model_missing not counted'; end if;

  -- anon can call feed_status and ops_status (token-gated) but cannot read the private tables
  if has_function_privilege('anon', 'api.feed_status()', 'execute') is not true then raise exception 'FAIL: anon cannot call feed_status'; end if;
  if has_function_privilege('anon', 'api.ops_status(text)', 'execute') is not true then raise exception 'FAIL: anon cannot call ops_status'; end if;
  if has_table_privilege('anon', 'core.ai_caps', 'select') or has_table_privilege('anon', 'core.ai_usage', 'select')
     or has_table_privilege('anon', 'ingest.run_log', 'select') or has_table_privilege('authenticated', 'core.ai_caps', 'select') then
    raise exception 'FAIL: anon/authenticated can read private tables';
  end if;
  foreach j in array array['"api.run_start(jsonb)"', '"api.ai_usage_exhaust(text)"']::jsonb[] loop
    if has_function_privilege('anon', j#>>'{}', 'execute') or has_function_privilege('authenticated', j#>>'{}', 'execute') then
      raise exception 'FAIL: app roles may call %', j;
    end if;
    if has_function_privilege('service_role', j#>>'{}', 'execute') is not true then raise exception 'FAIL: service_role denied %', j; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'core.ai_caps'::regclass) then raise exception 'FAIL: RLS off on ai_caps'; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
             where s.nspname = 'api' and p.proname in ('feed_status', 'ops_status', 'run_start', 'ai_usage_take', 'ai_usage_exhaust')
               and not (p.prosecdef and p.proconfig @> array['search_path=""'])) then
    raise exception 'FAIL: RPCs must be security definer with an empty search_path';
  end if;

  -- caps table seeded; reserve: non-reserve takes stop at cap - reserve, reserve takes go on to the cap
  if (select cap || '/' || reserve from core.ai_caps where provider = 'gemini') <> '500/10'
     or (select cap || '/' || reserve from core.ai_caps where provider = 'groq') <> '74/5' then
    raise exception 'FAIL: ai_caps seed';
  end if;
  insert into core.ai_usage(day, provider, calls) values (today, 'gemini', 489);
  if api.ai_usage_take('gemini', 9999) is not true then raise exception 'FAIL: take at 489 refused'; end if;   -- 490 (table cap wins over the argument)
  if api.ai_usage_take('gemini', 9999) is not false then raise exception 'FAIL: reserve not held back at 490'; end if;
  if api.ai_usage_take('gemini', 9999, true) is not true then raise exception 'FAIL: reserve take refused'; end if;
  update core.ai_usage set calls = 500 where day = today and provider = 'gemini';
  if api.ai_usage_take('gemini', 9999, true) is not false then raise exception 'FAIL: passed the cap'; end if;
  -- lowering a cap is one update
  update core.ai_caps set cap = 100, reserve = 0 where provider = 'groq';
  insert into core.ai_usage(day, provider, calls) values (today, 'groq', 99);
  if api.ai_usage_take('groq', 74) is not true or api.ai_usage_take('groq', 74) is not false then raise exception 'FAIL: table cap not used'; end if;
  update core.ai_caps set cap = 74, reserve = 5 where provider = 'groq';
  -- a provider without a row uses the caller's cap; with neither it is refused
  if api.ai_usage_take('other_t', 1) is not true or api.ai_usage_take('other_t', 1) is not false then raise exception 'FAIL: fallback cap'; end if;
  begin perform api.ai_usage_take('other2_t'); raise exception 'FAIL: no cap anywhere accepted';
  exception when others then if sqlerrm not like 'ai_usage_take: cap%' then raise; end if; end;

  -- exhaust: a daily-quota 429 sets today's use to the cap (never lowers it); unknown provider is a no-op
  delete from core.ai_usage where day = today and provider = 'groq';
  insert into core.ai_usage(day, provider, calls) values (today, 'groq', 3);
  perform api.ai_usage_exhaust('groq');
  if (select calls from core.ai_usage where day = today and provider = 'groq') <> 74 then raise exception 'FAIL: exhaust did not set the cap'; end if;
  if api.ai_usage_take('groq', 74, true) is not false then raise exception 'FAIL: take after exhaust allowed'; end if;
  perform api.ai_usage_exhaust('nobody_t');
  -- 3 days at the cap is reported
  insert into core.ai_usage(day, provider, calls) values (today - 1, 'groq', 74), (today - 2, 'groq', 80);
  select elem into j from jsonb_array_elements(api.ops_status(tok)->'ai') elem where elem->>'provider' = 'groq';
  if (j->>'at_cap_3_days')::boolean is not true or (j->>'used')::int <> 74 then raise exception 'FAIL: at_cap_3_days %', j; end if;

  raise exception 'ALL WATCHDOG CHECKS PASSED (test rows rolled back on purpose)';
end $$;
