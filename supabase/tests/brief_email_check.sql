do $$
declare r jsonb; tok uuid; sid uuid; n int; d jsonb; w jsonb; mid uuid; i int;
begin
 r:=api.subscribe_brief('BadEmail','daily',7,'America/New_York');
 if r->>'status'<>'invalid' then raise exception 'bad email validation'; end if;
 r:=api.subscribe_brief('nobody@example.com','daily',7,'America/New_York');
 if r->>'status'<>'pending' or r->>'ok'<>'true' then raise exception 'pending response'; end if;
 select token,id into tok,sid from core.brief_subscriptions where email='nobody@example.com';
 if has_function_privilege('service_role','api.pending_confirmations()','execute')=false then raise exception 'service role rpc denied'; end if;
 if has_function_privilege('anon','api.pending_confirmations()','execute') then raise exception 'anon service rpc granted'; end if;
 if api.confirm_brief(tok)->>'ok'<>'true' then raise exception 'confirm'; end if;
 if api.update_brief_subscription(tok,'both',9,'America/New_York')->>'ok'<>'true' then raise exception 'update'; end if;
 -- Send-hour due check uses each row's timezone and weekly due only Monday.
 if exists(select 1 from api.due_brief_subscriptions('2026-10-19 12:00:00+00') where id=sid) then raise exception 'subscription due before local hour'; end if;
 if not exists(select 1 from api.due_brief_subscriptions('2026-10-19 14:00:00+00') where id=sid) then raise exception 'daily due at local hour'; end if;
 perform api.update_brief_subscription(tok,'weekly',9,'America/New_York');
 if exists(select 1 from api.due_brief_subscriptions('2026-10-18 14:00:00+00') where id=sid) then raise exception 'weekly due on Sunday'; end if;
 if not exists(select 1 from api.due_brief_subscriptions('2026-10-19 14:00:00+00') where id=sid) then raise exception 'weekly not due Monday'; end if;
 perform api.unsubscribe_brief(tok); perform api.unsubscribe_brief(tok);
 if exists(select 1 from core.brief_subscriptions where email='nobody@example.com') or not exists(select 1 from core.brief_email_suppressions where email='nobody@example.com') then raise exception 'unsubscribe suppression'; end if;
 r:=api.subscribe_brief('nobody@example.com','daily',7,'America/New_York');
 if r->>'status'<>'pending' or (select status from core.brief_subscriptions where email='nobody@example.com')<>'pending' then raise exception 'resubscribe must reconfirm'; end if;
 for i in 1..3 loop perform api.subscribe_brief('nobody@example.com','daily',7,'America/New_York'); end loop;
 if api.subscribe_brief('nobody@example.com','daily',7,'America/New_York')->>'status'<>'limited' then raise exception 'per-email daily cap'; end if;
 for i in 1..195 loop perform api.subscribe_brief('global'||i||'@example.com','daily',7,'America/New_York'); end loop;
 if api.subscribe_brief('global-cap@example.com','daily',7,'America/New_York')->>'status'<>'limited' then raise exception 'global hourly cap'; end if;
 for i in 1..2 loop
   insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,rank_score)
   values('mail-market:'||i,'summary','Market fixture '||i,'Market test body.','markets','published','[]',now(),now(),now(),2000000-i) returning id into mid;
   insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values(mid,'Fixture source','news','https://example.com/mail-market/'||i,'company_filing',true);
 end loop;
 perform api.put_brief_summary('daily',(now() at time zone 'America/New_York')::date,'Fixture summary','fixture-model');
 d:=api.daily_brief(); w:=api.weekly_brief();
 if not (d ? 'summary' and d ? 'markets' and w ? 'summary' and w ? 'markets') then raise exception 'brief additions missing'; end if;
 if jsonb_typeof(d->'markets'->'cards')<>'array' or jsonb_typeof(d->'markets'->'numbers')<>'array' then raise exception 'markets shape'; end if;
 if jsonb_array_length(d->'markets'->'cards')<>2 or (d->'markets'->>'total')::int<>2 then raise exception 'market card selection/total'; end if;
 if exists(select 1 from jsonb_array_elements(d->'sections') s where s->>'category' in ('markets','earnings','deals')) then raise exception 'market topic duplicated in sections'; end if;
 if d->'summary'->>'text'<>'Fixture summary' then raise exception 'daily summary selection'; end if;
 raise exception 'ALL BRIEF EMAIL CHECKS PASSED (test rows rolled back on purpose)';
end $$;
