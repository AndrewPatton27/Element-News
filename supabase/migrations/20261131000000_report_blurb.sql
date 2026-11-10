-- "Report a problem" on a card (M9 trust, workstream 6). NOT applied. Idempotent. Run after 20261121000400_api_grants.sql.
-- Client: POST /rest/v1/rpc/report_blurb  {"p_id": uuid, "p_reason": text} (lib/api/report.ts).
--   * core.blurb_reports: private (RLS on, no policies, no client grants). One row per reporter, card and UTC day.
--   * api.report_blurb: anon + authenticated. Reporter key = sha256(salt || user id) when signed in, else
--     sha256(salt || first x-forwarded-for address). Salt is random, stored in core.blurb_report_salt (never exposed),
--     so keys cannot be reversed or compared across deployments. No raw IP is stored.
--   * Limits: 20 reports per reporter per hour (HTTP 429, errcode PT429); 1 per card per reporter per UTC day (a repeat
--     answers 200 {"status":"duplicate"} and writes nothing). Unknown / unpublished card or bad reason: HTTP 422 (PT422).
--   * Cost per call: one indexed count + one insert. Growth bounded by the limits and a 180-day purge (daily cron).
--   * core.blurb_report_counts: ops view for triage (service role / SQL editor only).
-- Reason codes must match REPORT_REASONS in lib/api/report.ts.

create table if not exists core.blurb_reports (
  id           bigint generated always as identity primary key,
  blurb_id     uuid        not null references core.blurbs (id) on delete cascade,
  reason       text        not null check (reason in ('inaccurate', 'broken_link', 'misleading', 'other')),
  reporter_key text        not null check (char_length(reporter_key) = 64),
  report_day   date        not null default ((now() at time zone 'utc')::date),
  created_at   timestamptz not null default now()
);
alter table core.blurb_reports enable row level security;   -- no policies: private
revoke all on core.blurb_reports from public, anon, authenticated;

create index if not exists blurb_reports_blurb_idx    on core.blurb_reports (blurb_id, created_at);
create index if not exists blurb_reports_reporter_idx on core.blurb_reports (reporter_key, created_at);
create unique index if not exists blurb_reports_once_per_day on core.blurb_reports (blurb_id, reporter_key, report_day);
create index if not exists blurb_reports_created_idx  on core.blurb_reports (created_at);   -- purge

create table if not exists core.blurb_report_salt (
  id   boolean primary key default true check (id),
  salt text    not null default encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'utf8')), 'hex')
);
alter table core.blurb_report_salt enable row level security;
revoke all on core.blurb_report_salt from public, anon, authenticated;
insert into core.blurb_report_salt (id) values (true) on conflict do nothing;

create or replace function api.report_blurb(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_hourly constant int := 20;
  v_uid  uuid := auth.uid();
  v_salt text;
  v_who  text;
  v_key  text;
  v_n    int;
  v_hdr  jsonb;
  v_rows int;
begin
  if p_id is null or p_reason is null or char_length(p_reason) > 32
     or p_reason not in ('inaccurate', 'broken_link', 'misleading', 'other') then
    raise exception 'invalid_report' using errcode = 'PT422';
  end if;
  if not exists (select 1 from core.blurbs where id = p_id and status = 'published') then
    raise exception 'unknown_card' using errcode = 'PT422';
  end if;

  select salt into v_salt from core.blurb_report_salt;
  if v_uid is not null then
    v_who := 'u:' || v_uid::text;
  else
    begin
      v_hdr := nullif(current_setting('request.headers', true), '')::jsonb;
    exception when others then v_hdr := null; end;
    v_who := 'ip:' || coalesce(nullif(left(trim(split_part(coalesce(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'x-real-ip', ''), ',', 1)), 64), ''), 'unknown');
  end if;
  v_key := encode(sha256(convert_to(v_salt || '|' || v_who, 'utf8')), 'hex');

  -- a repeat on the same card the same UTC day is a quiet success (no write, no rate-limit charge)
  if exists (select 1 from core.blurb_reports
              where blurb_id = p_id and reporter_key = v_key and report_day = (now() at time zone 'utc')::date) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select count(*) into v_n from core.blurb_reports
   where reporter_key = v_key and created_at > now() - interval '1 hour';
  if v_n >= c_hourly then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;

  insert into core.blurb_reports (blurb_id, reason, reporter_key) values (p_id, p_reason, v_key)
  on conflict (blurb_id, reporter_key, report_day) do nothing;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('status', case when v_rows = 1 then 'ok' else 'duplicate' end);
end $$;

revoke all on function api.report_blurb(uuid, text) from public;
grant execute on function api.report_blurb(uuid, text) to anon, authenticated;

-- Ops triage: reports per card (service role / SQL editor; never exposed through api)
create or replace view core.blurb_report_counts as
  select r.blurb_id, b.headline, b.status, count(*) as reports,
         count(*) filter (where r.reason = 'inaccurate')  as inaccurate,
         count(*) filter (where r.reason = 'broken_link') as broken_link,
         count(*) filter (where r.reason = 'misleading')  as misleading,
         count(*) filter (where r.reason = 'other')       as other,
         max(r.created_at) as last_reported_at
    from core.blurb_reports r join core.blurbs b on b.id = r.blurb_id
   group by r.blurb_id, b.headline, b.status;
revoke all on core.blurb_report_counts from public, anon, authenticated;
grant select on core.blurb_report_counts to service_role;

-- Retention: 180 days. Not callable by clients (core functions are private).
create or replace function core.purge_blurb_reports()
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  delete from core.blurb_reports where created_at < now() - interval '180 days';
  get diagnostics v = row_count;
  return v;
end $$;
revoke all on function core.purge_blurb_reports() from public, anon, authenticated;

-- Daily purge job (pg_cron absent in PGlite / local: skipped)
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobname) from cron.job where jobname = 'element-purge-reports';
    perform cron.schedule('element-purge-reports', '41 4 * * *', 'select core.purge_blurb_reports()');
  end if;
end $$;

notify pgrst, 'reload schema';
