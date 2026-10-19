-- Signed-in readers can list, change the time of, and cancel their own Brief email subscriptions.
-- The email is never taken from the client: it comes from auth.users for auth.uid(), and only
-- when that address is verified (email_confirmed_at is set). Safe to replay.
create or replace function core.my_verified_email() returns text
language sql stable security definer set search_path='' as $$
 select lower(u.email) from auth.users u
 where u.id = auth.uid() and u.email is not null and u.email_confirmed_at is not null; $$;
revoke all on function core.my_verified_email() from public,anon,authenticated;

-- One entry per kind. A stored 'both' row is shown as a daily and a weekly entry.
create or replace function api.my_brief_subscriptions() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e text:=core.my_verified_email();
begin
 if e is null then return '[]'::jsonb; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('kind',k.kind,'status',s.status,'send_hour_local',s.send_hour,'timezone',s.tz,'confirmed',s.confirmed_at is not null) order by k.kind)
  from core.brief_subscriptions s
  cross join lateral (select unnest(case s.kind when 'both' then array['daily','weekly'] else array[s.kind] end) as kind) k
  where s.email=e and s.status in ('pending','active')
 ),'[]'::jsonb);
end $$;

-- Same effect as the token path (row removed, address suppressed), limited to one kind.
-- Cancelling one half of a 'both' row keeps the other half. Idempotent.
create or replace function api.unsubscribe_my_brief(p_kind text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text:=core.my_verified_email(); n int:=0; c int;
begin
 if e is null then return jsonb_build_object('ok',false,'changed',false); end if;
 if p_kind not in ('daily','weekly') then return jsonb_build_object('ok',false,'changed',false); end if;
 delete from core.brief_subscriptions where email=e and kind=p_kind;
 get diagnostics c = row_count; n:=n+c;
 -- 'both' row: drop it if the other kind already has its own row, else narrow it to the other kind.
 if exists(select 1 from core.brief_subscriptions where email=e and kind='both') then
   if exists(select 1 from core.brief_subscriptions where email=e and kind=case p_kind when 'daily' then 'weekly' else 'daily' end) then
     delete from core.brief_subscriptions where email=e and kind='both';
   else
     update core.brief_subscriptions set kind=case p_kind when 'daily' then 'weekly' else 'daily' end where email=e and kind='both';
   end if;
   n:=n+1;
 end if;
 if n>0 and not exists(select 1 from core.brief_subscriptions where email=e) then
   insert into core.brief_email_suppressions(email) values(e) on conflict do nothing;
 end if;
 return jsonb_build_object('ok',true,'changed',n>0);
end $$;

-- Same rules as api.update_brief_subscription (hour 0-23, real timezone, active rows only).
-- Applies to the row(s) that cover p_kind (its own row, or a 'both' row).
create or replace function api.update_my_brief_time(p_kind text,p_send_hour int,p_timezone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text:=core.my_verified_email(); c int;
begin
 if e is null or p_kind not in ('daily','weekly') or p_send_hour not between 0 and 23 or p_timezone is null
    or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then
   return jsonb_build_object('ok',false,'changed',false);
 end if;
 update core.brief_subscriptions set send_hour=p_send_hour,tz=p_timezone
  where email=e and status='active' and kind in (p_kind,'both')
    and (send_hour is distinct from p_send_hour or tz is distinct from p_timezone);
 get diagnostics c = row_count;
 return jsonb_build_object('ok',true,'changed',c>0);
end $$;

revoke all on function api.my_brief_subscriptions(),api.unsubscribe_my_brief(text),api.update_my_brief_time(text,int,text) from public,anon;
grant execute on function api.my_brief_subscriptions(),api.unsubscribe_my_brief(text),api.update_my_brief_time(text,int,text) to authenticated;
notify pgrst,'reload schema';
