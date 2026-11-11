-- api.subscribe_brief limits (20261132000000_subscribe_brief_limits.sql). Ends with a deliberate "ALL ... PASSED" error.
do $$
declare r jsonb; n int; ok boolean; i int; h text;
begin
  -- bad input: rejected, nothing stored
  foreach h in array array['BadEmail', 'a@b', '', repeat('a', 250) || '@example.com'] loop
    r := api.subscribe_brief(h, 'daily', 7, 'UTC');
    if r->>'status' <> 'invalid' or (r->>'ok')::boolean then raise exception 'FAIL: bad email accepted: %', left(h, 20); end if;
  end loop;
  if api.subscribe_brief(null, 'daily', 7, 'UTC')->>'status' <> 'invalid' then raise exception 'FAIL: null email'; end if;
  if api.subscribe_brief('x@example.com', 'daily', 99, 'UTC')->>'status' <> 'invalid' then raise exception 'FAIL: bad hour'; end if;
  if (select count(*) from core.subscribe_attempts) <> 0 then raise exception 'FAIL: invalid input was logged'; end if;

  -- valid: normalized (trim, lower case), pending row, one attempt row, no raw address stored
  r := api.subscribe_brief('  Valid.User@Example.COM ', 'daily', 7, 'UTC');
  if r <> '{"ok": true, "status": "pending"}'::jsonb then raise exception 'FAIL: valid answer shape %', r; end if;
  if not exists (select 1 from core.brief_subscriptions where email = 'valid.user@example.com' and status = 'pending') then
    raise exception 'FAIL: valid subscribe did not create a pending row';
  end if;
  if (select count(*) from core.subscribe_attempts) <> 1 then raise exception 'FAIL: one attempt row expected'; end if;
  if exists (select 1 from core.subscribe_attempts a where a::text ilike '%valid.user%' or a::text ilike '%example.com%') then
    raise exception 'FAIL: the raw address is stored in the attempts table';
  end if;

  -- repeat inside 10 minutes (any case): silent success, same answer, no row change, no second confirmation email
  update core.brief_subscriptions set confirmation_sent_at = now() where email = 'valid.user@example.com';
  r := api.subscribe_brief('VALID.user@example.com', 'daily', 9, 'UTC');
  if r <> '{"ok": true, "status": "pending"}'::jsonb then raise exception 'FAIL: repeat answer differs: %', r; end if;
  if (select count(*) from core.subscribe_attempts) <> 1 then raise exception 'FAIL: silent repeat was logged'; end if;
  if (select confirmation_sent_at from core.brief_subscriptions where email = 'valid.user@example.com') is null
     or (select send_hour from core.brief_subscriptions where email = 'valid.user@example.com') <> 7 then
    raise exception 'FAIL: a repeat inside the window re-queued the confirmation email or changed the row';
  end if;
  -- an address that never subscribed gets the identical answer shape (no oracle)
  -- after the window the repeat is processed again
  update core.subscribe_attempts set created_at = created_at - interval '11 minutes';
  perform api.subscribe_brief('valid.user@example.com', 'daily', 9, 'UTC');
  if (select send_hour from core.brief_subscriptions where email = 'valid.user@example.com') <> 9 then
    raise exception 'FAIL: repeat after the window was not processed';
  end if;
  -- live pending row: the repeat keeps confirmation_sent_at (no second confirmation mail)
  if (select confirmation_sent_at from core.brief_subscriptions where email = 'valid.user@example.com') is null then
    raise exception 'FAIL: a repeat on a live pending row reset confirmation_sent_at';
  end if;
  -- per-address cap: 3 stored attempts per day (2 so far); the 3rd passes, the 4th is silent and stores nothing
  update core.subscribe_attempts set created_at = created_at - interval '11 minutes';
  perform api.subscribe_brief('valid.user@example.com', 'daily', 10, 'UTC');
  update core.subscribe_attempts set created_at = created_at - interval '11 minutes';
  select count(*) into n from core.subscribe_attempts;
  r := api.subscribe_brief('valid.user@example.com', 'daily', 11, 'UTC');
  if r <> '{"ok": true, "status": "pending"}'::jsonb or (select count(*) from core.subscribe_attempts) <> n
     or (select send_hour from core.brief_subscriptions where email = 'valid.user@example.com') <> 10 then
    raise exception 'FAIL: per-address daily cap did not hold';
  end if;

  -- x-forwarded-for is never trusted: six addresses behind a spoofed header must not trip the per-client limit
  perform set_config('request.headers', '{"x-forwarded-for": "203.0.113.50"}', true);
  delete from core.subscribe_attempts;
  for i in 1..6 loop perform api.subscribe_brief('spoof' || i || '@example.com', 'daily', 7, 'UTC'); end loop;
  if exists (select 1 from core.subscribe_attempts where client_key <> 'none') then
    raise exception 'FAIL: x-forwarded-for was used as a client key';
  end if;
  perform set_config('request.headers', '', true);

  -- per-address daily cap (review m9c): 3 processed attempts per address per UTC day, then silent success
  update core.subscribe_attempts set created_at = created_at - interval '11 minutes';
  perform api.subscribe_brief('valid.user@example.com', 'daily', 10, 'UTC');   -- 3rd processed attempt
  update core.subscribe_attempts set created_at = created_at - interval '11 minutes';
  r := api.subscribe_brief('valid.user@example.com', 'daily', 11, 'UTC');       -- 4th: silent
  if r <> '{"ok": true, "status": "pending"}'::jsonb then raise exception 'FAIL: daily cap answer differs: %', r; end if;
  if (select send_hour from core.brief_subscriptions where email = 'valid.user@example.com') <> 10 then
    raise exception 'FAIL: 4th attempt in a day was processed (confirmation email re-queued)';
  end if;

  -- per-client limit: 5 per hour per client key (this client already has 2), the 6th new address trips PT429
  perform set_config('request.headers', '{"cf-connecting-ip": "203.0.113.7, 10.0.0.1"}', true);
  delete from core.subscribe_attempts;
  for i in 1..5 loop perform api.subscribe_brief('client' || i || '@example.com', 'daily', 7, 'UTC'); end loop;
  ok := false;
  begin perform api.subscribe_brief('client6@example.com', 'daily', 7, 'UTC');
  exception when sqlstate 'PT429' then ok := true; end;
  if not ok then raise exception 'FAIL: per-client limit did not trip'; end if;
  if exists (select 1 from core.brief_subscriptions where email = 'client6@example.com') then
    raise exception 'FAIL: a limited call stored a subscription';
  end if;
  if exists (select 1 from core.subscribe_attempts where client_key like '%203.0.113.7%') then
    raise exception 'FAIL: raw client IP stored';
  end if;
  -- a different client is unaffected
  perform set_config('request.headers', '{"cf-connecting-ip": "198.51.100.9"}', true);
  r := api.subscribe_brief('client6@example.com', 'daily', 7, 'UTC');
  if r->>'status' <> 'pending' then raise exception 'FAIL: other client blocked: %', r; end if;
  -- a repeat by the limited client for an address already asked about is still silent success, not 429
  perform set_config('request.headers', '{"cf-connecting-ip": "203.0.113.7"}', true);
  r := api.subscribe_brief('client1@example.com', 'daily', 7, 'UTC');
  if r->>'status' <> 'pending' then raise exception 'FAIL: silent repeat answered %', r; end if;

  -- global cap: 80 new attempts per UTC day; then PT429 for any client
  delete from core.subscribe_attempts;
  insert into core.subscribe_attempts (email_hash, client_key, created_at)
    select md5(g::text) || md5(g::text || 'x'), 'k' || g, now() from generate_series(1, 80) g;
  perform set_config('request.headers', '{"cf-connecting-ip": "192.0.2.55"}', true);
  ok := false;
  begin perform api.subscribe_brief('global-cap@example.com', 'daily', 7, 'UTC');
  exception when sqlstate 'PT429' then ok := true; end;
  if not ok then raise exception 'FAIL: global cap did not trip'; end if;
  -- 79 is still under the cap
  delete from core.subscribe_attempts where client_key = 'k80';
  r := api.subscribe_brief('global-cap@example.com', 'daily', 7, 'UTC');
  if r->>'status' <> 'pending' then raise exception 'FAIL: 79 attempts must still pass: %', r; end if;
  -- attempts from yesterday do not count toward today's cap
  delete from core.subscribe_attempts;
  insert into core.subscribe_attempts (email_hash, client_key, created_at)
    select md5(g::text) || md5(g::text || 'x'), 'k' || g, date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '1 minute'
    from generate_series(1, 80) g;
  r := api.subscribe_brief('global-cap2@example.com', 'daily', 7, 'UTC');
  if r->>'status' <> 'pending' then raise exception 'FAIL: yesterday counted toward today: %', r; end if;

  -- purge keeps 2 days
  delete from core.subscribe_attempts;
  insert into core.subscribe_attempts (email_hash, client_key, created_at) values
    (md5('a') || md5('b'), 'old', now() - interval '3 days'), (md5('c') || md5('d'), 'new', now() - interval '1 day');
  n := core.prune_subscribe_attempts(2);
  if n <> 1 or (select count(*) from core.subscribe_attempts) <> 1 then
    raise exception 'FAIL: prune retention (deleted %)', n;
  end if;

  -- grants: anon and authenticated call the RPC, not the service functions; anon cannot read the attempts or salt tables
  if not has_function_privilege('anon', 'api.subscribe_brief(text,text,integer,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'api.subscribe_brief(text,text,integer,text)', 'EXECUTE') then
    raise exception 'FAIL: client roles lost api.subscribe_brief';
  end if;
  if has_function_privilege('anon', 'core.prune_subscribe_attempts(integer)', 'EXECUTE')
     or has_table_privilege('anon', 'core.subscribe_attempts', 'SELECT')
     or has_table_privilege('authenticated', 'core.subscribe_attempts', 'SELECT')
     or has_table_privilege('anon', 'core.subscribe_salt', 'SELECT') then
    raise exception 'FAIL: client role can reach the private tables';
  end if;
  perform set_config('role', 'anon', true);
  ok := false;
  begin perform count(*) from core.subscribe_attempts;
  exception when insufficient_privilege then ok := true; end;
  perform set_config('role', 'none', true);
  if not ok then raise exception 'FAIL: anon read core.subscribe_attempts'; end if;
  if not exists (select 1 from pg_class where oid = 'core.subscribe_attempts'::regclass and relrowsecurity)
     or not exists (select 1 from pg_class where oid = 'core.subscribe_salt'::regclass and relrowsecurity) then
    raise exception 'FAIL: RLS off';
  end if;
  if exists (select 1 from pg_policy where polrelid in ('core.subscribe_attempts'::regclass, 'core.subscribe_salt'::regclass)) then
    raise exception 'FAIL: a client policy exists';
  end if;
  if not exists (select 1 from pg_proc where oid = 'api.subscribe_brief(text,text,integer,text)'::regprocedure
                 and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: subscribe_brief must be security definer with an empty search_path';
  end if;

  raise exception 'ALL SUBSCRIBE LIMIT CHECKS PASSED (test rows rolled back on purpose)';
end $$;
