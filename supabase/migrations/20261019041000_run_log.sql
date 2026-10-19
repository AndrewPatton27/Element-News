-- Run log for the scheduled Edge Functions (2026-10-19, D-72). One row per invocation of
-- ingest-source (one source per call) or brief-summary, so Drew can read what each cloud run did.
-- ingest.run_log: private (RLS on, no policies, no grants to app roles). `detail` holds the full run
-- summary JSON (stats, deferred items, stop reason); it never holds keys or source text.
-- api.log_run(p jsonb): service role only; inserts one row and returns its id. Rows older than
-- 30 days are deleted on each call (free-tier storage). Re-runnable.

create table if not exists ingest.run_log (
  id          bigint generated always as identity primary key,
  source      text        not null check (source in ('macro','fed','bea','fedreg','sec','wiki','cpsc','usgs','nasa','brief-summary')),
  started_at  timestamptz not null,
  finished_at timestamptz,
  items_new   int not null default 0 check (items_new >= 0),
  published   int not null default 0 check (published >= 0),
  skipped     int not null default 0 check (skipped >= 0),
  failed      int not null default 0 check (failed >= 0),
  ai_calls    int not null default 0 check (ai_calls >= 0),
  error       text check (error is null or length(error) <= 1000),
  detail      jsonb
);
create index if not exists run_log_started_idx on ingest.run_log (started_at desc);
alter table ingest.run_log enable row level security;
revoke all on ingest.run_log from public, anon, authenticated;

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
  delete from ingest.run_log where started_at < now() - interval '30 days';
  return v_id;
end;
$$;

revoke all on function api.log_run(jsonb) from public, anon, authenticated;
grant execute on function api.log_run(jsonb) to service_role;
