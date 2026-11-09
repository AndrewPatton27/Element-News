-- Checks for 20261113000000_security_fixes.sql. All rows roll back at the deliberate final error.
do $$
declare
  src uuid; tgt uuid; r jsonb; t1 uuid; t2 uuid; st text;
begin
  -- 1. related_cards: a hidden card that links to a published one must not be returned, and a published card
  --    must never appear in its own related list.
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('secfix:src','summary','Source story','Body','world','published','[]',now(),now(),now(),10) returning id into src;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('secfix:tgt','summary','Target story','Body','markets','published','[]',now(),now(),now(),10) returning id into tgt;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'Security check','news','https://example.com/secfix/'||dedupe_key,'company_filing',true
  from core.blurbs where dedupe_key like 'secfix:%';
  perform api.set_story_link(src,tgt,'update');

  r:=api.related_cards(src,5);
  if exists(select 1 from jsonb_array_elements(r) x where x->>'id'=src::text) then
    raise exception 'FAIL: related_cards returned the queried card itself: %',r;
  end if;
  if not exists(select 1 from jsonb_array_elements(r) x where x->>'id'=tgt::text and x->'story_link'->>'kind'='update') then
    raise exception 'FAIL: related_cards must return the linked target for a source card: %',r;
  end if;
  if (select x->>'id' from jsonb_array_elements(api.related_cards(tgt,5)) x limit 1)<>src::text then
    raise exception 'FAIL: related_cards must still return the linking card for a target card';
  end if;

  update core.blurbs set status='hidden' where id=src;
  r:=api.related_cards(src,5);
  if jsonb_array_length(r)<>0 then raise exception 'FAIL: hidden card must get an empty related list: %',r; end if;
  if exists(select 1 from jsonb_array_elements(api.related_cards(tgt,5)) x where x->>'id'=src::text) then
    raise exception 'FAIL: a hidden linking card must not be returned for its target';
  end if;

  -- 2. subscribe_brief must not reset an ACTIVE subscription, and must not lift a suppression before confirm.
  perform api.subscribe_brief('secfix-active@example.com','daily',7,'UTC');
  select token into t1 from core.brief_subscriptions where email='secfix-active@example.com' and kind='daily';
  perform api.confirm_brief(t1);
  r:=api.subscribe_brief('secfix-active@example.com','daily',9,'UTC');
  if r->>'status'<>'pending' then raise exception 'FAIL: response must stay uniform pending: %',r; end if;
  select status,token into st,t2 from core.brief_subscriptions where email='secfix-active@example.com' and kind='daily';
  if st<>'active' or t2<>t1 then raise exception 'FAIL: anon subscribe reset an active subscription (status %, token changed %)',st,t1<>t2; end if;
  if (select send_hour from core.brief_subscriptions where email='secfix-active@example.com' and kind='daily')<>7 then
    raise exception 'FAIL: anon subscribe changed an active subscription''s schedule';
  end if;

  perform api.unsubscribe_brief(t1);
  if not exists(select 1 from core.brief_email_suppressions where email='secfix-active@example.com') then
    raise exception 'FAIL: unsubscribe must suppress';
  end if;
  perform api.subscribe_brief('secfix-active@example.com','weekly',7,'UTC');
  if not exists(select 1 from core.brief_email_suppressions where email='secfix-active@example.com') then
    raise exception 'FAIL: unverified subscribe lifted the suppression';
  end if;
  select token into t2 from core.brief_subscriptions where email='secfix-active@example.com' and kind='weekly' and status='pending';
  if t2 is null then raise exception 'FAIL: resubscribe after unsubscribe must create a pending row'; end if;
  perform api.confirm_brief(t2);
  if exists(select 1 from core.brief_email_suppressions where email='secfix-active@example.com') then
    raise exception 'FAIL: confirm must lift the suppression';
  end if;

  -- 3. grants stay as designed.
  if not has_function_privilege('anon','api.related_cards(uuid,integer)','EXECUTE')
    or not has_function_privilege('anon','api.subscribe_brief(text,text,integer,text)','EXECUTE')
    or not has_function_privilege('anon','api.confirm_brief(uuid)','EXECUTE') then
    raise exception 'FAIL: anon lost a public RPC';
  end if;
  raise exception 'ALL SECURITY FIX CHECKS PASSED (test rows rolled back on purpose)';
end $$;
