-- AI usage counters in the database (2026-10-19, D-72). The laptop ingest kept its per-day AI call
-- counts in ingest/state/ai-usage.json; Edge Functions have no lasting disk, so the counts live here
-- and the daily caps (Gemini 500, Groq 74, from ingest/src/config.ts) hold across separate runs.
-- core.ai_usage(day, provider, calls): one row per UTC day and provider. Private (RLS on, no policies,
-- no grants to app roles).
-- api.ai_usage_take(p_provider, p_cap): atomically adds 1 call for today (UTC) only while calls < p_cap;
--   returns true if the call may go ahead, false at the cap. Concurrent callers never pass the cap
--   (the conditional UPDATE locks the row and re-checks).
-- api.ai_usage_get(p_day): {"gemini": n, "groq": n, ...} for that UTC day (default today).
-- Both RPCs: service role only, security definer, empty search_path. Re-runnable.

create table if not exists core.ai_usage (
  day        date        not null,
  provider   text        not null check (provider ~ '^[a-z0-9_-]{1,40}$'),
  calls      int         not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, provider)
);
alter table core.ai_usage enable row level security;
revoke all on core.ai_usage from public, anon, authenticated;

create or replace function api.ai_usage_take(p_provider text, p_cap int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_calls int;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'ai_usage_take: bad provider name';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'ai_usage_take: cap must be 0 or more';
  end if;
  insert into core.ai_usage (day, provider, calls) values (v_day, p_provider, 0)
  on conflict (day, provider) do nothing;
  update core.ai_usage
     set calls = calls + 1, updated_at = now()
   where day = v_day and provider = p_provider and calls < p_cap
  returning calls into v_calls;
  -- Keep the table small: rows older than 60 days are not needed for any cap.
  delete from core.ai_usage where day < v_day - 60;
  return v_calls is not null;
end;
$$;

create or replace function api.ai_usage_get(p_day date default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(provider, calls), '{}'::jsonb)
    from core.ai_usage
   where day = coalesce(p_day, (now() at time zone 'utc')::date);
$$;

revoke all on function api.ai_usage_take(text, int) from public, anon, authenticated;
revoke all on function api.ai_usage_get(date) from public, anon, authenticated;
grant execute on function api.ai_usage_take(text, int) to service_role;
grant execute on function api.ai_usage_get(date) to service_role;
