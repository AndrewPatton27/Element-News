-- api.subscribe_brief abuse limits (M9 security review). NOT applied. Idempotent.
--
-- Problem: api.subscribe_brief is callable by anon. The old limits (5 per address per 24 h, 200 per hour overall) still
-- let one client queue confirmation emails to many strangers and burn the Resend free cap (100 emails per day).
--
-- Double opt-in check: the flow is already double opt-in. subscribe_brief only writes a 'pending' row; the mail job
-- (api.pending_confirmations, service role) sends ONE confirmation email per pending row with confirmation_sent_at null,
-- and nothing else is sent until the owner clicks the link (api.confirm_brief). The old upsert reset
-- confirmation_sent_at to null on every repeat, so every repeat queued another confirmation email. The rate limit
-- below sits exactly on that trigger: a repeat inside the window returns before the upsert and queues no email.
--
-- Limits (same signature and jsonb return shape; no new email flow):
--   * per normalized address: 1 attempt per 10 minutes. A repeat returns the normal {ok:true,status:'pending'}
--     and stores nothing, so the answer never shows whether the address is subscribed or was just asked about.
--   * per normalized address: at most 3 stored attempts per UTC day (the address hash is salted with the date), so a
--     third party cannot be mailed more than a few times a day even across the 10-minute windows.
--   * per client key: 5 attempts per hour. The client IP comes from cf-connecting-ip ONLY (set by Cloudflare, not
--     client-rotatable; x-forwarded-for is client-controlled and is never read). Signed-in readers without that header
--     fall back to their user id. With neither, the key is 'none' and the per-client check is skipped (one shared
--     bucket would lock everyone out); the per-address caps and the global cap still apply.
--   * global: 80 new attempts per UTC day (under Resend's 100 per day; the rest is headroom for the daily and weekly
--     briefs). Over a per-client or global limit: raise rate_limited, errcode PT429 (HTTP 429), as api.report_blurb does.
--   * format: trimmed, lower-cased, at most 254 characters and the same address pattern as before; else
--     {ok:false,status:'invalid'} as before.
-- Pending rows: a repeat while a pending row is under 24 h old keeps its token, created_at and confirmation_sent_at, so
-- no further confirmation mail is queued for it.
-- Privacy: core.subscribe_attempts stores only sha256(secret pepper || UTC date || address) (never the address) and the
-- hashed client key. The pepper is a random value in a private one-row table. Hashes rotate daily, so they cannot be
-- joined across days even by someone holding the table. Retention 2 days (core.prune_subscribe_attempts, daily).
-- Cost per call: one pepper read, up to three indexed LIMIT-bounded lookups, one insert, then the old upsert.
-- core.brief_email_rate (the old counter) is no longer written; it is left in place.

create table if not exists core.subscribe_salt (
  id     boolean primary key default true check (id),
  pepper text not null default (gen_random_uuid()::text || gen_random_uuid()::text)
);
insert into core.subscribe_salt (id) values (true) on conflict do nothing;
alter table core.subscribe_salt enable row level security;   -- no policies: private
revoke all on core.subscribe_salt from public, anon, authenticated;

create table if not exists core.subscribe_attempts (
  id         bigint generated always as identity primary key,
  email_hash text not null check (char_length(email_hash) = 64),
  client_key text not null check (char_length(client_key) <= 80),
  created_at timestamptz not null default now()
);
create index if not exists subscribe_attempts_email_time  on core.subscribe_attempts (email_hash, created_at desc);
create index if not exists subscribe_attempts_client_time on core.subscribe_attempts (client_key, created_at desc);
create index if not exists subscribe_attempts_time        on core.subscribe_attempts (created_at desc);
alter table core.subscribe_attempts enable row level security;   -- no policies: private
revoke all on core.subscribe_attempts from public, anon, authenticated;

create or replace function api.subscribe_brief(p_email text,p_kind text,p_hour int,p_tz text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 e text:=lower(btrim(coalesce(p_email,''))); now_at timestamptz:=clock_timestamp();
 v_pepper text; v_day text:=(now_at at time zone 'utc')::date::text; v_ehash text; v_key text;
 v_hdr json; v_ip text; v_uid uuid:=auth.uid(); v_n int;
begin
 if char_length(e)>254
    or e !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    or p_kind is null or p_kind not in ('daily','weekly','both') or p_hour is null or p_hour not between 0 and 23
    or p_tz is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_tz) then
   return jsonb_build_object('ok',false,'status','invalid');
 end if;

 select pepper into v_pepper from core.subscribe_salt where id;
 v_ehash:=encode(sha256(convert_to(v_pepper||':e:'||v_day||':'||e,'utf8')),'hex');
 begin v_hdr:=nullif(current_setting('request.headers',true),'')::json; exception when others then v_hdr:=null; end;
 v_ip:=btrim(split_part(coalesce(v_hdr->>'cf-connecting-ip',''),',',1));
 v_key:=case when v_ip<>'' then 'i:'||encode(sha256(convert_to(v_pepper||':i:'||v_day||':'||left(v_ip,64),'utf8')),'hex')
             when v_uid is not null then 'u:'||v_uid::text
             else 'none' end;

 -- same address inside 10 minutes: the normal answer, nothing stored, nothing queued (no oracle, no second email)
 if exists(select 1 from core.subscribe_attempts where email_hash=v_ehash and created_at>now_at-interval '10 minutes') then
   return jsonb_build_object('ok',true,'status','pending');
 end if;
 select count(*) into v_n from (select 1 from core.subscribe_attempts where email_hash=v_ehash limit 4) s;
 if v_n>=3 then return jsonb_build_object('ok',true,'status','pending'); end if;   -- per-address daily cap: silent, no oracle
 if v_key<>'none' then
   select count(*) into v_n from (select 1 from core.subscribe_attempts
      where client_key=v_key and created_at>now_at-interval '1 hour' limit 6) s;
   if v_n>=5 then raise exception 'rate_limited' using errcode='PT429'; end if;
 end if;
 select count(*) into v_n from (select 1 from core.subscribe_attempts
    where created_at>=date_trunc('day',now_at at time zone 'utc') at time zone 'utc' limit 81) s;
 if v_n>=80 then raise exception 'rate_limited' using errcode='PT429'; end if;
 insert into core.subscribe_attempts(email_hash,client_key,created_at) values(v_ehash,v_key,now_at);

 -- unchanged from 20261118000000: uniform answer; an unverified request never touches an ACTIVE row, and a
 -- suppression is lifted only when the new token is confirmed (api.confirm_brief).
 insert into core.brief_subscriptions(email,kind,send_hour,tz,status,token,created_at,confirmed_at,confirmation_sent_at,last_daily_sent_on,last_weekly_sent_on)
 values(e,p_kind,p_hour,p_tz,'pending',gen_random_uuid(),now_at,null,null,null,null)
 on conflict(email,kind) do update set send_hour=excluded.send_hour,tz=excluded.tz,status='pending',
   -- a live pending row (under 24 h) keeps token, created_at and confirmation_sent_at: no second confirmation mail
   token=case when core.brief_subscriptions.status='pending' and core.brief_subscriptions.created_at>now_at-interval '24 hours' then core.brief_subscriptions.token else gen_random_uuid() end,
   created_at=case when core.brief_subscriptions.status='pending' and core.brief_subscriptions.created_at>now_at-interval '24 hours' then core.brief_subscriptions.created_at else now_at end,
   confirmation_sent_at=case when core.brief_subscriptions.status='pending' and core.brief_subscriptions.created_at>now_at-interval '24 hours' then core.brief_subscriptions.confirmation_sent_at else null end,
   confirmed_at=null,last_daily_sent_on=null,last_weekly_sent_on=null
 where core.brief_subscriptions.status<>'active';
 return jsonb_build_object('ok',true,'status','pending');
end $$;
revoke all on function api.subscribe_brief(text,text,int,text) from public;
grant execute on function api.subscribe_brief(text,text,int,text) to anon,authenticated;

create or replace function core.prune_subscribe_attempts(p_days int default 2)
returns int language plpgsql security definer set search_path='' as $$
declare v_n int;
begin
  delete from core.subscribe_attempts where created_at < now() - make_interval(days => greatest(coalesce(p_days,2),1));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function core.prune_subscribe_attempts(int) from public, anon, authenticated;
grant execute on function core.prune_subscribe_attempts(int) to service_role;

-- daily purge with the existing pg_cron (skipped where pg_cron is absent: PGlite, dev without the extension)
do $cron$
begin
  if to_regnamespace('cron') is not null and to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'element-prune-subscribe-attempts';
    perform cron.schedule('element-prune-subscribe-attempts', '47 5 * * *', 'select core.prune_subscribe_attempts(2)');
  end if;
exception when others then
  raise warning 'subscribe_brief: could not schedule the purge job (%): schedule select core.prune_subscribe_attempts(2) by hand', sqlerrm;
end $cron$;
notify pgrst,'reload schema';
