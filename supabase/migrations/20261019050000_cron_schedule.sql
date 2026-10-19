-- Cloud schedule (2026-10-19, D-72): pg_cron calls the Edge Functions through pg_net, replacing the
-- laptop tasks ElementIngest (hourly) and ElementBriefSummary (daily). Written, NOT applied.
-- Needs: the functions deployed (supabase/functions/functions.md) and migrations 20261019040000 and
-- 20261019041000 applied first.
--
-- No key is ever written in this file. The function base URL and the service-role key are read at
-- call time from Supabase Vault (vault.decrypted_secrets). BEFORE the first run, Drew creates the two
-- secrets ONCE in the SQL editor (replace the <...> parts; do not save the filled-in lines anywhere):
--
--   -- DREW: run once by hand, not part of this migration
--   select vault.create_secret('https://mzfpelilxpbpcgskppxu.supabase.co/functions/v1', 'element_functions_url');
--   select vault.create_secret('<service_role key: Project Settings > API Keys > Legacy API keys > service_role>', 'element_service_key');
--
-- The key must be exactly the service_role key the functions see as SUPABASE_SERVICE_ROLE_KEY (the
-- functions compare the bearer token with it). To change it later: select vault.update_secret(id, '<new>')
-- with the id from vault.secrets where name = 'element_service_key'.
--
-- Schedule (UTC; pg_cron on Supabase runs in UTC):
--   element-brief-summary   30 10 * * *   06:30 EDT (05:30 EST after the clocks change on Nov 1)
--   element-ingest-<source> once an hour, 6 minutes apart so calls (each at most about 150 s) never
--                           overlap: macro :03, fed :09, bea :15, fedreg :21, sec :27, wiki :39,
--                           cpsc :45, usgs :51, nasa :57 (nasa also refreshes Trending and purges ML rows).
--                           :33 is left free for the brief summary at 10:30.
-- Re-runnable: each job is unscheduled by name first, then scheduled again.
-- Check: select jobname, schedule, command from cron.job where jobname like 'element-%';
--        select * from cron.job_run_details order by start_time desc limit 20;
--        select id, status_code, left(content, 300) from net._http_response order by id desc limit 20;
--        select * from ingest.run_log order by started_at desc limit 20;
-- Stop everything: select cron.unschedule(jobname) from cron.job where jobname like 'element-%';

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Calls one Edge Function: POST <element_functions_url>/<name> with the body and
-- Authorization: Bearer <element_service_key>. Returns the pg_net request id. Private (core), owner only.
create or replace function core.invoke_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if p_name not in ('ingest-source', 'brief-summary') then
    raise exception 'invoke_function: unknown function %', p_name;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'element_functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'element_service_key';
  if v_url is null or v_key is null then
    raise exception 'invoke_function: Vault secrets element_functions_url and element_service_key are not set (see 20261019050000_cron_schedule.sql)';
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/' || p_name,
    body := coalesce(p_body, '{}'::jsonb),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 150000
  );
end;
$$;
revoke all on function core.invoke_function(text, jsonb) from public, anon, authenticated, service_role;

-- Idempotent: drop the old jobs by name, then schedule them again.
select cron.unschedule(jobname) from cron.job
 where jobname in ('element-brief-summary', 'element-ingest-macro', 'element-ingest-fed', 'element-ingest-bea',
                   'element-ingest-fedreg', 'element-ingest-sec', 'element-ingest-wiki', 'element-ingest-cpsc',
                   'element-ingest-usgs', 'element-ingest-nasa');

select cron.schedule('element-brief-summary', '30 10 * * *', $$select core.invoke_function('brief-summary', '{"kind":"both"}')$$);
select cron.schedule('element-ingest-macro',  '3 * * * *',  $$select core.invoke_function('ingest-source', '{"source":"macro"}')$$);
select cron.schedule('element-ingest-fed',    '9 * * * *',  $$select core.invoke_function('ingest-source', '{"source":"fed"}')$$);
select cron.schedule('element-ingest-bea',    '15 * * * *', $$select core.invoke_function('ingest-source', '{"source":"bea"}')$$);
select cron.schedule('element-ingest-fedreg', '21 * * * *', $$select core.invoke_function('ingest-source', '{"source":"fedreg"}')$$);
select cron.schedule('element-ingest-sec',    '27 * * * *', $$select core.invoke_function('ingest-source', '{"source":"sec"}')$$);
select cron.schedule('element-ingest-wiki',   '39 * * * *', $$select core.invoke_function('ingest-source', '{"source":"wiki"}')$$);
select cron.schedule('element-ingest-cpsc',   '45 * * * *', $$select core.invoke_function('ingest-source', '{"source":"cpsc"}')$$);
select cron.schedule('element-ingest-usgs',   '51 * * * *', $$select core.invoke_function('ingest-source', '{"source":"usgs"}')$$);
select cron.schedule('element-ingest-nasa',   '57 * * * *', $$select core.invoke_function('ingest-source', '{"source":"nasa","finish":true}')$$);
