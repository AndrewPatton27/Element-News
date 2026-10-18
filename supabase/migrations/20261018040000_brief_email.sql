-- Brief summaries, Markets section, and opt-in email subscriptions.
-- Safe to replay. Private tables are accessed only through the API functions below.
create table if not exists core.brief_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null check (kind in ('daily','weekly','both')),
  send_hour smallint not null default 7 check (send_hour between 0 and 23),
  tz text not null default 'America/New_York',
  status text not null default 'pending' check (status in ('pending','active','unsubscribed')),
  token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmation_sent_at timestamptz,
  last_daily_sent_on date,
  last_weekly_sent_on date,
  constraint brief_subscription_email_lower check (email = lower(email)),
  constraint brief_subscription_email_kind unique (email,kind)
);
create table if not exists core.brief_email_suppressions (
  email text primary key check(email=lower(email)), created_at timestamptz not null default now()
);
create table if not exists core.brief_email_rate (
  email text not null, requested_at timestamptz not null default now()
);
create index if not exists brief_email_rate_time_idx on core.brief_email_rate(requested_at);
create table if not exists core.brief_summaries (
  kind text not null check(kind in ('daily','weekly')), for_date date not null,
  text text not null, model text not null, created_at timestamptz not null default now(),
  primary key(kind,for_date)
);
alter table core.brief_subscriptions enable row level security;
alter table core.brief_subscriptions add column if not exists confirmation_sent_at timestamptz;
alter table core.brief_email_suppressions enable row level security;
alter table core.brief_email_rate enable row level security;
alter table core.brief_summaries enable row level security;
revoke all on core.brief_subscriptions,core.brief_email_suppressions,core.brief_email_rate,core.brief_summaries from public,anon,authenticated;

create or replace function api.subscribe_brief(p_email text,p_kind text,p_hour int,p_tz text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e text:=lower(btrim(coalesce(p_email,''))); now_at timestamptz:=clock_timestamp();
begin
 if e !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    or p_kind not in ('daily','weekly','both') or p_hour not between 0 and 23
    or p_tz is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_tz) then
   return jsonb_build_object('ok',false,'status','invalid');
 end if;
 delete from core.brief_email_rate where requested_at < now_at-interval '24 hours';
 if (select count(*) from core.brief_email_rate where email=e)>=5
    or (select count(*) from core.brief_email_rate where requested_at>=now_at-interval '1 hour')>=200 then
   return jsonb_build_object('ok',false,'status','limited');
 end if;
 insert into core.brief_email_rate(email,requested_at) values(e,now_at);
 -- All valid requests receive the same pending response. Suppressed addresses can
 -- only return after an explicit new opt-in, which always creates a fresh token.
 delete from core.brief_email_suppressions where email=e;
 insert into core.brief_subscriptions(email,kind,send_hour,tz,status,token,created_at,confirmed_at,confirmation_sent_at,last_daily_sent_on,last_weekly_sent_on)
 values(e,p_kind,p_hour,p_tz,'pending',gen_random_uuid(),now_at,null,null,null,null)
 on conflict(email,kind) do update set send_hour=excluded.send_hour,tz=excluded.tz,status='pending',token=gen_random_uuid(),created_at=now_at,confirmed_at=null,confirmation_sent_at=null,last_daily_sent_on=null,last_weekly_sent_on=null;
 return jsonb_build_object('ok',true,'status','pending');
end $$;
create or replace function api.confirm_brief(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin update core.brief_subscriptions set status='active',confirmed_at=coalesce(confirmed_at,now()) where token=p_token and status='pending'; return jsonb_build_object('ok',true); end $$;
create or replace function api.update_brief_subscription(p_token uuid,p_kind text,p_hour int,p_tz text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_kind not in ('daily','weekly','both') or p_hour not between 0 and 23 or p_tz is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_tz) then return jsonb_build_object('ok',false); end if;
 update core.brief_subscriptions set kind=p_kind,send_hour=p_hour,tz=p_tz where token=p_token and status='active';
 return jsonb_build_object('ok',true);
end $$;
create or replace function api.unsubscribe_brief(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text;
begin
 select email into e from core.brief_subscriptions where token=p_token;
 if e is not null then
   insert into core.brief_email_suppressions(email) values(e) on conflict do nothing;
   delete from core.brief_subscriptions where email=e;
 end if;
 return jsonb_build_object('ok',true);
end $$;

create or replace function api.put_brief_summary(p_kind text,p_for_date date,p_text text,p_model text) returns void
language sql security definer set search_path='' as $$
 insert into core.brief_summaries(kind,for_date,text,model) values(p_kind,p_for_date,p_text,p_model)
 on conflict(kind,for_date) do update set text=excluded.text,model=excluded.model,created_at=now(); $$;
create or replace function api.pending_confirmations() returns setof core.brief_subscriptions
language sql security definer set search_path='' as $$ select * from core.brief_subscriptions where status='pending' and confirmation_sent_at is null order by created_at; $$;
create or replace function api.due_brief_subscriptions(p_now timestamptz) returns setof core.brief_subscriptions
language sql stable security definer set search_path='' as $$
 select s.* from core.brief_subscriptions s
 where s.status='active' and extract(hour from p_now at time zone s.tz)>=s.send_hour
 and ((s.kind in ('daily','both') and s.last_daily_sent_on is distinct from (p_now at time zone s.tz)::date)
   or (s.kind in ('weekly','both') and extract(isodow from p_now at time zone s.tz)=1 and s.last_weekly_sent_on is distinct from (p_now at time zone s.tz)::date))
 order by s.created_at; $$;
create or replace function api.mark_brief_sent(p_id uuid,p_kind text,p_on_date date) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_kind='daily' then update core.brief_subscriptions set last_daily_sent_on=p_on_date where id=p_id and status='active' and kind in ('daily','both');
 elsif p_kind='weekly' then update core.brief_subscriptions set last_weekly_sent_on=p_on_date where id=p_id and status='active' and kind in ('weekly','both');
 elsif p_kind='confirm' then update core.brief_subscriptions set confirmation_sent_at=now() where id=p_id and status='pending'; end if;
end $$;
revoke all on function api.subscribe_brief(text,text,int,text),api.confirm_brief(uuid),api.update_brief_subscription(uuid,text,int,text),api.unsubscribe_brief(uuid) from public;
grant execute on function api.subscribe_brief(text,text,int,text),api.confirm_brief(uuid),api.update_brief_subscription(uuid,text,int,text),api.unsubscribe_brief(uuid) to anon,authenticated;
revoke all on function api.put_brief_summary(text,date,text,text),api.pending_confirmations(),api.due_brief_subscriptions(timestamptz),api.mark_brief_sent(uuid,text,date) from public,anon,authenticated;
grant execute on function api.put_brief_summary(text,date,text,text),api.pending_confirmations(),api.due_brief_subscriptions(timestamptz),api.mark_brief_sent(uuid,text,date) to service_role;

create or replace function core.brief_market_pack(p_hours int) returns jsonb
language sql stable security definer set search_path='' as $$
 with eligible as (
   select b.id,b.dedupe_key,b.rank_score,row_number() over(partition by b.dedupe_key order by b.rank_score desc,b.id desc) rn
   from core.blurbs b join core.app_config cfg on cfg.id
   where b.status='published' and b.published_at<=now() and b.sort_at>=now()-make_interval(hours=>p_hours)
    and (b.kind<>'link_out' or cfg.linkout_cards) and b.category in ('markets','earnings','deals')
    and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
 ), cards as (
   select e.rank_score,e.id,j.c from eligible e cross join lateral jsonb_array_elements(core.cards_json(array[e.id],null)) j(c) where e.rn=1
 )
 select jsonb_build_object('cards',coalesce((select jsonb_agg(c order by rank_score desc,id desc) from (select * from cards order by rank_score desc,id desc limit 6) x),'[]'::jsonb),'total',(select count(*) from cards));
$$;
revoke all on function core.brief_market_pack(int) from public,anon,authenticated;

create or replace function api.daily_brief() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_hours int:=24; v_built jsonb; v_numbers jsonb; v_mnums jsonb; v_summary jsonb; v_market jsonb;
begin
 if core.brief_supply(24)<12 then v_hours:=48; if core.brief_supply(48)<12 then v_hours:=72; end if; end if;
 v_built:=core.brief_build(v_hours,6);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
 v_market:=core.brief_market_pack(v_hours);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_mnums from api.numbers_to_know n where n.series_id in ('DGS10','DGS2','DFF','DCOILWTICO');
 select jsonb_build_object('text',s.text,'generated_at',s.created_at,'model',s.model) into v_summary from core.brief_summaries s where s.kind='daily' and s.for_date=(now() at time zone 'America/New_York')::date;
 return jsonb_build_object('generated_at',now(),'window_hours',v_hours,'headline_cards',v_built->'headline_cards','sections',coalesce((select jsonb_agg(sec order by (sec->>'rank')::int) from jsonb_array_elements(v_built->'sections') sec where sec->>'category' not in ('markets','earnings','deals')),'[]'::jsonb),'numbers',v_numbers,'summary',v_summary,'markets',jsonb_build_object('cards',v_market->'cards','numbers',v_mnums,'total',(v_market->>'total')::int));
end $$;
create or replace function api.weekly_brief() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_built jsonb; v_numbers jsonb; v_mnums jsonb; v_summary jsonb; v_market jsonb;
begin
 v_built:=core.brief_build(168,8);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
 v_market:=core.brief_market_pack(168);
 select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_mnums from api.numbers_to_know n where n.series_id in ('DGS10','DGS2','DFF','DCOILWTICO');
 select jsonb_build_object('text',s.text,'generated_at',s.created_at,'model',s.model) into v_summary from core.brief_summaries s where s.kind='weekly' and s.for_date=date_trunc('week',now() at time zone 'America/New_York')::date;
 return jsonb_build_object('generated_at',now(),'window_hours',168,'headline_cards',v_built->'headline_cards','sections',coalesce((select jsonb_agg(sec order by (sec->>'rank')::int) from jsonb_array_elements(v_built->'sections') sec where sec->>'category' not in ('markets','earnings','deals')),'[]'::jsonb),'numbers',v_numbers,'summary',v_summary,'markets',jsonb_build_object('cards',v_market->'cards','numbers',v_mnums,'total',(v_market->>'total')::int),'movers',api.number_trends());
end $$;
revoke all on function api.daily_brief(),api.weekly_brief() from public;
grant execute on function api.daily_brief(),api.weekly_brief() to anon,authenticated;
notify pgrst,'reload schema';
