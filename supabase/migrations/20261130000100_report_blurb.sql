-- api.report_blurb: "Report a problem" on a card (M9). NOT applied. The app already calls POST /rest/v1/rpc/report_blurb
-- (lib/api/report.ts); until this migration is applied the call answers 404 and the app says "Reporting is not
-- available yet". Idempotent.
--
-- Design (security and scale):
--   * core.blurb_reports is private: RLS on with no policies, all client privileges revoked. Only this function (owner)
--     and the service role touch it. Rows hold the card id, a reason code from a fixed list, the signed-in user id (or
--     null) and a rate-limit key. No free text, no IP address: anonymous readers are keyed by a SHA-256 of the client IP
--     plus today's date (rotates daily), read from the request headers PostgREST exposes.
--   * Abuse limits, each one indexed lookup bounded by LIMIT: per reporter key 20 reports per hour; the same key,
--     card and reason is accepted once per 24 h (repeats return silently, so there is no oracle); a global ceiling of
--     2000 per hour stops a distributed flood. Over the limit raises rate_limited (PT429); the app shows "try again later".
--   * Cost per call: one primary-key read (card published), up to three bounded index lookups, one insert.
--   * Retention: core.prune_blurb_reports() deletes rows older than 90 days; scheduled daily with pg_cron when present.
create table if not exists core.blurb_reports (
  id           bigint generated always as identity primary key,
  blurb_id     uuid not null references core.blurbs (id) on delete cascade,
  reason       text not null check (reason in ('inaccurate', 'broken_link', 'misleading', 'other')),
  reporter_id  uuid,
  reporter_key text not null check (char_length(reporter_key) <= 80),
  created_at   timestamptz not null default now()
);
create index if not exists blurb_reports_key_time on core.blurb_reports (reporter_key, created_at desc);
create index if not exists blurb_reports_time on core.blurb_reports (created_at desc);
create index if not exists blurb_reports_blurb on core.blurb_reports (blurb_id, created_at desc);
alter table core.blurb_reports enable row level security;   -- no policies: private
revoke all on core.blurb_reports from public, anon, authenticated;

create or replace function api.report_blurb(p_id uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_hdr  json;
  v_ip   text;
  v_key  text;
  v_n    int;
begin
  if p_id is null or p_reason is null or p_reason not in ('inaccurate', 'broken_link', 'misleading', 'other') then
    raise exception 'invalid_report' using errcode = 'PT422';
  end if;
  if not exists (select 1 from core.blurbs where id = p_id and status = 'published') then
    raise exception 'unknown_card' using errcode = 'PT422';
  end if;

  if v_uid is not null then
    v_key := 'u:' || v_uid::text;
  else
    begin
      v_hdr := nullif(current_setting('request.headers', true), '')::json;
    exception when others then v_hdr := null;
    end;
    -- cf-connecting-ip only: x-forwarded-for is client-controlled and would let one client rotate keys.
    v_ip := btrim(split_part(coalesce(v_hdr ->> 'cf-connecting-ip', ''), ',', 1));
    v_key := case when v_ip = '' then 'none'
                  else 'i:' || encode(sha256(convert_to(left(v_ip, 64) || ':' || current_date::text, 'utf8')), 'hex') end;
  end if;

  -- same reporter, card and reason within 24 h: accepted silently, nothing stored
  if exists (select 1 from core.blurb_reports
              where reporter_key = v_key and created_at > now() - interval '24 hours'
                and blurb_id = p_id and reason = p_reason) then
    return;
  end if;
  -- no trusted IP ('none'): skip the per-key cap (one shared bucket would block everyone); the global cap still applies
  if v_key <> 'none' then
    select count(*) into v_n from (select 1 from core.blurb_reports
       where reporter_key = v_key and created_at > now() - interval '1 hour' limit 21) s;
    if v_n >= 20 then raise exception 'rate_limited' using errcode = 'PT429'; end if;
  end if;
  select count(*) into v_n from (select 1 from core.blurb_reports
     where created_at > now() - interval '1 hour' limit 2001) s;
  if v_n >= 2000 then raise exception 'rate_limited' using errcode = 'PT429'; end if;

  insert into core.blurb_reports (blurb_id, reason, reporter_id, reporter_key) values (p_id, p_reason, v_uid, v_key);
end $$;
revoke all on function api.report_blurb(uuid, text) from public;
grant execute on function api.report_blurb(uuid, text) to anon, authenticated;

create or replace function core.prune_blurb_reports(p_days int default 90)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from core.blurb_reports where created_at < now() - make_interval(days => greatest(coalesce(p_days, 90), 7));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function core.prune_blurb_reports(int) from public, anon, authenticated;
grant execute on function core.prune_blurb_reports(int) to service_role;

-- daily purge with the existing pg_cron (skipped where pg_cron is absent: PGlite, dev without the extension)
do $cron$
begin
  if to_regnamespace('cron') is not null and to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'element-prune-reports';
    perform cron.schedule('element-prune-reports', '41 5 * * *', 'select core.prune_blurb_reports(90)');
  end if;
exception when others then
  raise warning 'report_blurb: could not schedule the purge job (%): schedule select core.prune_blurb_reports(90) by hand', sqlerrm;
end $cron$;
