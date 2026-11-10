-- Security fixes from the 2026-11-09 release audit. Written, NOT applied: Drew applies it in the Supabase SQL
-- editor after the previous migrations (see supabase/supabase.md). Safe to re-run.
-- 1. api.related_cards: the "linked" branch returned the queried card itself (sl.card_id) and never checked that
--    card's status, so a hidden card that links to a published one came back in full. Now both branches require
--    the queried card to be published (src) and return only the other, published card.
-- 2. api.subscribe_brief: an anonymous call for an address that already has an ACTIVE subscription reset it to
--    pending (briefs stopped until the owner re-confirmed). Active rows are now left alone; the response stays the
--    same uniform 'pending' so the call still does not reveal who is subscribed. The suppression row is lifted
--    only when the new token is confirmed (api.confirm_brief), not on the unverified request.
-- 3. Defence in depth: functions created later in api/core are no longer executable by PUBLIC by default, and
--    pg_net's functions (if installed) are not executable by the client roles.

create or replace function api.related_cards(p_card_id uuid,p_limit int default 5)
returns jsonb language sql stable security definer set search_path = '' as $$
  with src as (select * from core.blurbs where id=p_card_id and status='published'), linked as (
    select sl.related_id id, sl.kind, sl.related_id, target.headline related_headline, 0 ord, sl.created_at
    from src join core.story_links sl on sl.card_id=src.id join core.blurbs target on target.id=sl.related_id
    where target.status='published'
    union all
    select sl.card_id, sl.kind, sl.related_id, target.headline, 0, sl.created_at
    from src join core.story_links sl on sl.related_id=src.id join core.blurbs target on target.id=sl.card_id
    where target.status='published'
  ), overlap_rows as (
    select b.id,null::text kind,null::uuid related_id,null::text related_headline,1 ord,now() created_at,
      (case when b.category=src.category then 1 else 0 end + (select count(*) from jsonb_array_elements(b.tickers) x join jsonb_array_elements(src.tickers) y on lower(x->>'symbol')=lower(y->>'symbol'))) score
    from src join core.blurbs b on b.id<>src.id and b.status='published'
    where (b.category=src.category or exists(select 1 from jsonb_array_elements(b.tickers) x join jsonb_array_elements(src.tickers) y on lower(x->>'symbol')=lower(y->>'symbol')))
  ), allrows as (
    select l.id,l.kind,l.related_id,l.related_headline,l.ord,l.created_at,0 score from linked l where l.id<>p_card_id
    union all select o.id,o.kind,o.related_id,o.related_headline,o.ord,o.created_at,o.score from overlap_rows o where not exists(select 1 from linked l where l.id=o.id)
  ), picked as (select * from allrows order by ord,case kind when 'update' then 1 when 'angle' then 2 when 'related' then 3 else 4 end,score desc,created_at desc,id desc limit least(greatest(coalesce(p_limit,5),1),10))
  select coalesce(jsonb_agg((x.c-'my_reaction') || case when p.kind is null then '{}'::jsonb else jsonb_build_object('story_link',jsonb_build_object('kind',p.kind,'related_id',p.related_id,'related_headline',p.related_headline)) end order by x.o),'[]'::jsonb)
  from picked p, lateral jsonb_array_elements(core.cards_json(array[p.id],null)) with ordinality x(c,o);
$$;
revoke all on function api.related_cards(uuid,int) from public;
grant execute on function api.related_cards(uuid,int) to anon,authenticated;

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
 -- Same uniform response for every valid request. An unverified request never touches an ACTIVE row, and a
 -- suppression is lifted only when the new token is confirmed (api.confirm_brief).
 insert into core.brief_subscriptions(email,kind,send_hour,tz,status,token,created_at,confirmed_at,confirmation_sent_at,last_daily_sent_on,last_weekly_sent_on)
 values(e,p_kind,p_hour,p_tz,'pending',gen_random_uuid(),now_at,null,null,null,null)
 on conflict(email,kind) do update set send_hour=excluded.send_hour,tz=excluded.tz,status='pending',token=gen_random_uuid(),created_at=now_at,confirmed_at=null,confirmation_sent_at=null,last_daily_sent_on=null,last_weekly_sent_on=null
 where core.brief_subscriptions.status<>'active';
 return jsonb_build_object('ok',true,'status','pending');
end $$;

create or replace function api.confirm_brief(p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text;
begin
 update core.brief_subscriptions set status='active',confirmed_at=coalesce(confirmed_at,now())
 where token=p_token and status='pending' returning email into e;
 if e is not null then delete from core.brief_email_suppressions where email=e; end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function api.subscribe_brief(text,text,int,text),api.confirm_brief(uuid) from public;
grant execute on function api.subscribe_brief(text,text,int,text),api.confirm_brief(uuid) to anon,authenticated;

alter default privileges in schema api revoke execute on functions from public;
alter default privileges in schema core revoke execute on functions from public;

do $net$
declare f record;
begin
  if exists (select 1 from pg_namespace where nspname = 'net') then
    for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net' loop
      execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    end loop;
  end if;
end $net$;
