-- Watchdog support (2026-11-08, design: docs/work/watchdog-design.md). Written, NOT applied.
-- Needs 20261019040000_ai_usage.sql and 20261019041000_run_log.sql first. Re-runnable.
--
-- 1. api.feed_status() (anon): last_published_at, last_ok_run_at, delayed. Worked out from now(), so there
--    is no stored flag and it keeps answering when the Worker is dead. delayed = no error-free finished run
--    (brief-summary does not count) AND no card published within 3 hours. A quiet weekend is not "delayed"
--    as long as runs keep finishing without error.
-- 2. api.ops_status(p_token) (anon, token checked against Vault 'element_watchdog_token'): counters for the
--    Cloudflare Worker (cron jobs, cron/http failures, hung runs, model_missing, AI use vs cap, db size).
--    Read-only. pg_cron / pg_net / Vault tables are read with dynamic SQL only when they exist.
--    DREW creates the token once in the SQL editor (not in this file):
--      select vault.create_secret('<long random string>', 'element_watchdog_token');
-- 3. core.ai_caps(provider, cap, reserve): the daily caps live in a table (a lowered free limit is one SQL
--    update). api.ai_usage_take(provider, cap, use_reserve) now uses the table cap when a row exists (the cap
--    argument is the fallback), and keeps `reserve` calls back for callers that pass use_reserve = true
--    (brief-summary). api.ai_usage_exhaust(provider) sets today's use to the cap (a daily-quota 429).
-- 4. api.run_start(p) writes the run_log row BEFORE the work (finished_at null); api.log_run(p) with p.id
--    finishes that row (without id it inserts, as before). Every log_run call also marks runs that are still
--    open after 10 minutes as killed (finished_at = now(), error 'killed: ...').

-- ---- AI caps ------------------------------------------------------------------------
create table if not exists core.ai_caps (
  provider text primary key check (provider ~ '^[a-z0-9_-]{1,40}$'),
  cap      int not null check (cap >= 0),
  reserve  int not null default 0 check (reserve >= 0 and reserve <= cap)
);
alter table core.ai_caps enable row level security;
revoke all on core.ai_caps from public, anon, authenticated;
insert into core.ai_caps (provider, cap, reserve) values ('gemini', 500, 10), ('groq', 74, 5)
on conflict (provider) do nothing;

drop function if exists api.ai_usage_take(text, int);
create or replace function api.ai_usage_take(p_provider text, p_cap int default null, p_use_reserve boolean default false)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_calls int;
  v_cap int;
  v_reserve int := 0;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'ai_usage_take: bad provider name';
  end if;
  if p_cap is not null and p_cap < 0 then
    raise exception 'ai_usage_take: cap must be 0 or more';
  end if;
  select c.cap, c.reserve into v_cap, v_reserve from core.ai_caps c where c.provider = p_provider;
  v_cap := coalesce(v_cap, p_cap);
  if v_cap is null then raise exception 'ai_usage_take: cap must be 0 or more'; end if;
  v_reserve := coalesce(v_reserve, 0);
  insert into core.ai_usage (day, provider, calls) values (v_day, p_provider, 0)
  on conflict (day, provider) do nothing;
  update core.ai_usage
     set calls = calls + 1, updated_at = now()
   where day = v_day and provider = p_provider
     and calls < case when p_use_reserve then v_cap else greatest(v_cap - v_reserve, 0) end
  returning calls into v_calls;
  delete from core.ai_usage where day < v_day - 60;
  return v_calls is not null;
end;
$$;

create or replace function api.ai_usage_exhaust(p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_cap int;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'ai_usage_exhaust: bad provider name';
  end if;
  select cap into v_cap from core.ai_caps where provider = p_provider;
  if v_cap is null then return; end if;
  insert into core.ai_usage (day, provider, calls) values (v_day, p_provider, v_cap)
  on conflict (day, provider) do update set calls = greatest(core.ai_usage.calls, excluded.calls), updated_at = now();
end;
$$;

revoke all on function api.ai_usage_take(text, int, boolean) from public, anon, authenticated;
revoke all on function api.ai_usage_exhaust(text) from public, anon, authenticated;
grant execute on function api.ai_usage_take(text, int, boolean) to service_role;
grant execute on function api.ai_usage_exhaust(text) to service_role;

-- ---- run log: start rows and hung-run marking ---------------------------------------
create or replace function api.run_start(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'run_start: payload must be an object'; end if;
  insert into ingest.run_log (source, started_at, finished_at)
  values (p->>'source', coalesce((p->>'started_at')::timestamptz, now()), null)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function api.log_run(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  nonneg constant text := 'log_run: counts must be whole numbers, 0 or more';
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'log_run: payload must be an object'; end if;
  if coalesce((p->>'items_new')::int, 0) < 0 or coalesce((p->>'published')::int, 0) < 0 or coalesce((p->>'skipped')::int, 0) < 0
     or coalesce((p->>'failed')::int, 0) < 0 or coalesce((p->>'ai_calls')::int, 0) < 0 then
    raise exception '%', nonneg;
  end if;
  -- Runs still open after 10 minutes died without a finish row (the platform stops a call at 150 s).
  update ingest.run_log
     set finished_at = now(),
         error = 'killed: no finish row within 10 minutes',
         detail = coalesce(detail, '{}'::jsonb) || '{"stopped_by":"killed"}'::jsonb
   where finished_at is null and started_at < now() - interval '10 minutes'
     and id is distinct from nullif(p->>'id', '')::bigint;
  if nullif(p->>'id', '') is not null then
    update ingest.run_log set
      finished_at = coalesce((p->>'finished_at')::timestamptz, now()),
      items_new = coalesce((p->>'items_new')::int, 0),
      published = coalesce((p->>'published')::int, 0),
      skipped = coalesce((p->>'skipped')::int, 0),
      failed = coalesce((p->>'failed')::int, 0),
      ai_calls = coalesce((p->>'ai_calls')::int, 0),
      error = left(nullif(p->>'error', ''), 1000),
      detail = case when jsonb_typeof(p->'detail') = 'object' then p->'detail' else null end
    where id = (p->>'id')::bigint and source = p->>'source'
    returning id into v_id;
  end if;
  if v_id is null then
    insert into ingest.run_log (source, started_at, finished_at, items_new, published, skipped, failed, ai_calls, error, detail)
    values (
      p->>'source',
      coalesce((p->>'started_at')::timestamptz, now()),
      coalesce((p->>'finished_at')::timestamptz, now()),
      coalesce((p->>'items_new')::int, 0),
      coalesce((p->>'published')::int, 0),
      coalesce((p->>'skipped')::int, 0),
      coalesce((p->>'failed')::int, 0),
      coalesce((p->>'ai_calls')::int, 0),
      left(nullif(p->>'error', ''), 1000),
      case when jsonb_typeof(p->'detail') = 'object' then p->'detail' else null end
    )
    returning id into v_id;
  end if;
  delete from ingest.run_log where started_at < now() - interval '30 days';
  return v_id;
end;
$$;

revoke all on function api.run_start(jsonb) from public, anon, authenticated;
revoke all on function api.log_run(jsonb) from public, anon, authenticated;
grant execute on function api.run_start(jsonb) to service_role;
grant execute on function api.log_run(jsonb) to service_role;

-- ---- api.feed_status (anon) ---------------------------------------------------------
create or replace function api.feed_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select (select max(published_at) from core.blurbs where status = 'published') as last_published_at,
           (select max(finished_at) from ingest.run_log
             where finished_at is not null and error is null and source <> 'brief-summary') as last_ok_run_at
  )
  select jsonb_build_object(
    'last_published_at', last_published_at,
    'last_ok_run_at', last_ok_run_at,
    'delayed', coalesce(last_ok_run_at, '-infinity'::timestamptz) < now() - interval '3 hours'
               and coalesce(last_published_at, '-infinity'::timestamptz) < now() - interval '3 hours'
  ) from s;
$$;
revoke all on function api.feed_status() from public;
grant execute on function api.feed_status() to anon, authenticated, service_role;

-- ---- api.ops_status (anon, token-gated) ---------------------------------------------
create or replace function api.ops_status(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_jobs int := null;
  v_cron_fail int := null;
  v_http_bad int := null;
  v_ai jsonb;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'element_watchdog_token';
  end if;
  if v_secret is null or p_token is null or length(p_token) < 16 or p_token <> v_secret then
    raise exception 'ops_status: not allowed';
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select count(*)::int from cron.job where jobname like 'element-%'$q$ into v_jobs;
    if to_regclass('cron.job_run_details') is not null then
      execute $q$select count(*)::int from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                  where j.jobname like 'element-%' and d.status = 'failed' and d.start_time > now() - interval '24 hours'$q$ into v_cron_fail;
    end if;
  end if;
  if to_regclass('net._http_response') is not null then
    execute $q$select count(*)::int from net._http_response
                where created > now() - interval '24 hours'
                  and (error_msg is not null or timed_out or status_code is null or status_code not between 200 and 299)$q$ into v_http_bad;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', c.provider, 'used', coalesce(u.calls, 0), 'cap', c.cap, 'reserve', c.reserve,
           'at_cap_3_days', (select count(*) from core.ai_usage x
                              where x.provider = c.provider and x.calls >= c.cap
                                and x.day between (now() at time zone 'utc')::date - 2 and (now() at time zone 'utc')::date) = 3
         ) order by c.provider), '[]'::jsonb)
    into v_ai
    from core.ai_caps c
    left join core.ai_usage u on u.provider = c.provider and u.day = (now() at time zone 'utc')::date;
  return jsonb_build_object(
    'now', now(),
    'jobs', v_jobs,
    'cron_failures_24h', v_cron_fail,
    'http_non2xx_24h', v_http_bad,
    'hung_open', (select count(*) from ingest.run_log where finished_at is null and started_at < now() - interval '10 minutes'),
    'killed_24h', (select count(*) from ingest.run_log where error like 'killed:%' and started_at > now() - interval '24 hours'),
    'model_missing', (select count(*) from ingest.run_log
                       where started_at > now() - interval '24 hours'
                         and (detail->'stats'->>'model_missing') in ('true', '1')),
    'ai', v_ai,
    'db_size_mb', round(pg_database_size(current_database()) / 1048576.0)
  );
end;
$$;
revoke all on function api.ops_status(text) from public;
grant execute on function api.ops_status(text) to anon, authenticated, service_role;
