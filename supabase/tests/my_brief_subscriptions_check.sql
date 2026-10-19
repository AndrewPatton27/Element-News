do $$
declare a uuid; b uuid; u uuid; r jsonb; tok uuid;
begin
 select id into a from auth.users where email='element-test-a@example.com';
 select id into b from auth.users where email='element-test-b@example.com';
 insert into auth.users(email,email_confirmed_at) values('unverified@example.com',null) returning id into u;
 insert into core.brief_subscriptions(email,kind,send_hour,tz,status,confirmed_at) values
  ('element-test-a@example.com','daily',7,'America/New_York','active',now()),
  ('element-test-a@example.com','weekly',8,'America/Chicago','pending',null),
  ('element-test-b@example.com','both',9,'America/New_York','active',now()),
  ('unverified@example.com','daily',7,'America/New_York','active',now());

 -- anon denied
 if has_function_privilege('anon','api.my_brief_subscriptions()','execute') or has_function_privilege('anon','api.unsubscribe_my_brief(text)','execute')
    or has_function_privilege('anon','api.update_my_brief_time(text,int,text)','execute') then raise exception 'anon can execute'; end if;
 if not has_function_privilege('authenticated','api.my_brief_subscriptions()','execute') then raise exception 'authenticated cannot execute'; end if;

 -- user A sees only own rows
 perform set_config('request.jwt.claims',json_build_object('sub',a,'role','authenticated')::text,true);
 r:=api.my_brief_subscriptions();
 if jsonb_array_length(r)<>2 or exists(select 1 from jsonb_array_elements(r) x where x->>'kind' not in ('daily','weekly')) then raise exception 'A list shape %',r; end if;
 if (r->0->>'kind')<>'daily' or (r->0->>'status')<>'active' or (r->0->>'send_hour_local')::int<>7 or (r->0->>'timezone')<>'America/New_York' or (r->0->>'confirmed')<>'true' then raise exception 'A daily row %',r; end if;
 if (r->1->>'status')<>'pending' or (r->1->>'confirmed')<>'false' then raise exception 'A weekly row %',r; end if;
 -- time change
 if api.update_my_brief_time('daily',10,'America/Denver')<>'{"ok":true,"changed":true}'::jsonb then raise exception 'time change'; end if;
 if api.update_my_brief_time('daily',10,'America/Denver')->>'changed'<>'false' then raise exception 'time change idempotent'; end if;
 if api.update_my_brief_time('daily',24,'America/Denver')->>'ok'<>'false' or api.update_my_brief_time('daily',5,'Nope/Zone')->>'ok'<>'false' then raise exception 'time validation'; end if;
 if (select send_hour from core.brief_subscriptions where email='element-test-b@example.com')<>9 then raise exception 'A changed B time'; end if;
 -- cancel daily: idempotent, B untouched
 if api.unsubscribe_my_brief('daily')<>'{"ok":true,"changed":true}'::jsonb then raise exception 'cancel daily'; end if;
 if api.unsubscribe_my_brief('daily')<>'{"ok":true,"changed":false}'::jsonb then raise exception 'double cancel'; end if;
 if api.unsubscribe_my_brief('monthly')->>'ok'<>'false' then raise exception 'bad kind'; end if;
 if exists(select 1 from core.brief_subscriptions where email='element-test-a@example.com' and kind='daily') then raise exception 'daily not removed'; end if;
 if not exists(select 1 from core.brief_subscriptions where email='element-test-a@example.com' and kind='weekly') then raise exception 'weekly removed by daily cancel'; end if;
 if exists(select 1 from core.brief_email_suppressions where email='element-test-a@example.com') then raise exception 'suppressed while a kind remains'; end if;
 if not exists(select 1 from core.brief_subscriptions where email='element-test-b@example.com' and kind='both' and status='active') then raise exception 'B touched by A'; end if;
 perform api.unsubscribe_my_brief('weekly');
 if not exists(select 1 from core.brief_email_suppressions where email='element-test-a@example.com') then raise exception 'no suppression after last cancel'; end if;

 -- user B: 'both' shows as two entries; cancel weekly narrows to daily
 perform set_config('request.jwt.claims',json_build_object('sub',b,'role','authenticated')::text,true);
 if jsonb_array_length(api.my_brief_subscriptions())<>2 then raise exception 'B both expansion'; end if;
 if api.unsubscribe_my_brief('weekly')->>'changed'<>'true' then raise exception 'B weekly cancel'; end if;
 if (select kind from core.brief_subscriptions where email='element-test-b@example.com')<>'daily' then raise exception 'both not narrowed'; end if;
 if jsonb_array_length(api.my_brief_subscriptions())<>1 then raise exception 'B after narrow'; end if;

 -- unverified email gets nothing and cannot cancel
 perform set_config('request.jwt.claims',json_build_object('sub',u,'role','authenticated')::text,true);
 if api.my_brief_subscriptions()<>'[]'::jsonb then raise exception 'unverified sees rows'; end if;
 if api.unsubscribe_my_brief('daily')->>'ok'<>'false' or api.update_my_brief_time('daily',5,'UTC')->>'ok'<>'false' then raise exception 'unverified acted'; end if;
 if not exists(select 1 from core.brief_subscriptions where email='unverified@example.com') then raise exception 'unverified row removed'; end if;

 -- no session at all
 perform set_config('request.jwt.claims','',true);
 if api.my_brief_subscriptions()<>'[]'::jsonb then raise exception 'no-session sees rows'; end if;
 raise exception 'ALL MY BRIEF SUBSCRIPTION CHECKS PASSED (rolled back on purpose)';
end $$;
