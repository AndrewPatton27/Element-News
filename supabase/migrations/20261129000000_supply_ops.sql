-- Supply operations (M9 workstream 1). Written, NOT applied. Re-runnable. Apply with
--   npx supabase db query --remote --yes -f supabase/migrations/20261129000000_supply_ops.sql
--
-- 1. Indexes for the supply readout, the watchdog and the requeue tool. Before this file the only indexes on
--    core.blurbs were the partial rank / latest indexes (keyed on rank_score and sort_at, not published_at), so
--    "cards published in the last 24 h / 30 days" was a scan of core.blurbs. ingest.items had only the unique
--    url index, so "status = 'skipped' and fetched_at within 14 days" scanned ingest.items. All three tables
--    are small (thousands of rows), so the scans are cheap today; the indexes keep the hourly watchdog query and
--    the readout cheap as supply grows. EXPLAIN on prod (read-only) before applying if you want the plan.
-- 2. api.ops_status adds cards_24h and cards_1h (cards published in the last 24 hours / 60 minutes) for the
--    watchdog's supply floor. One RPC, no extra request. Everything else in it is unchanged.
-- 3. api.upsert_item also returns status_note, so the ingest pipeline can read the retry counter it keeps in
--    status_note for items whose report-card step failed (status stays 'new', note 'report_card_retry:N:<code>').

-- ---- 1. indexes ---------------------------------------------------------------------
create index if not exists blurbs_published_at_idx
  on core.blurbs (published_at desc) where status = 'published';
create index if not exists items_fetched_at_idx
  on ingest.items (fetched_at desc);
create index if not exists items_status_fetched_idx
  on ingest.items (status, fetched_at desc) where status <> 'published';

-- ---- 2. api.ops_status: cards_24h, cards_1h -------------------------------------------
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
    'db_size_mb', round(pg_database_size(current_database()) / 1048576.0),
    -- supply floor (one scan of the published_at index): live published cards only, hidden ones do not count
    'cards_24h', (select count(*) from core.blurbs where status = 'published' and published_at > now() - interval '24 hours'),
    'cards_1h',  (select count(*) from core.blurbs where status = 'published' and published_at > now() - interval '60 minutes')
  );
end;
$$;
revoke all on function api.ops_status(text) from public;
grant execute on function api.ops_status(text) to anon, authenticated, service_role;

-- ---- 3. api.upsert_item returns status_note -------------------------------------------
create or replace function api.upsert_item(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid; v_new boolean; v_status text; v_note text;
begin
  insert into ingest.items (source, external_id, url, title, body_text, published_at, expires_at,
                            license_class, use_level, tickers, event_type)
  values (p ->> 'source', p ->> 'external_id', p ->> 'url', p ->> 'title', p ->> 'body_text',
          (p ->> 'published_at')::timestamptz, (p ->> 'expires_at')::timestamptz,
          p ->> 'license_class', coalesce(p ->> 'use_level', 'full_summarize'),
          coalesce(p -> 'tickers', '[]'::jsonb), p ->> 'event_type')
  on conflict (url) do update set fetched_at = now()
  returning id, (xmax = 0), status, status_note into v_id, v_new, v_status, v_note;
  return jsonb_build_object('id', v_id, 'is_new', v_new, 'status', v_status, 'status_note', v_note);
end;
$$;
revoke execute on function api.upsert_item(jsonb) from public, anon, authenticated;
grant  execute on function api.upsert_item(jsonb) to service_role;
