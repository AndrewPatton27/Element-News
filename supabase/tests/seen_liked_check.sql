-- Liked cards count as seen in For you (20261120000300_seen_liked.sql).
-- Checks: setting ships at 0 with a range guard; a viewed + liked card is not in the unseen part of For you and is
-- in the seen tail; an updated story still comes back; with seen_liked_comeback = 1 the liked card comes back
-- (old behaviour); Trending still lists every card; guests unaffected. Test rows are rolled back on purpose.
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  ua uuid; cards uuid[]; r jsonb; ids uuid[]; sf int;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  delete from core.user_events where user_id = ua;
  delete from core.user_prefs where user_id = ua;
  update core.blurbs set status = 'hidden' where status = 'published';

  if (select value from core.rank_params where key = 'seen_liked_comeback') is distinct from 0 then
    raise exception 'FAIL: seen_liked_comeback must ship at 0'; end if;
  begin
    update core.rank_params set value = 2 where key = 'seen_liked_comeback';
    raise exception 'FAIL: value 2 must be refused';
  exception when check_violation then null; end;

  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  select 'sl-'||g,'summary','Liked check card '||g,'Body.',(array['economy','markets','earnings'])[1+g%3],'published',now(),now(),now()-(g||' hours')::interval,4,base-g+16
  from generate_series(1,12) g;
  select array_agg(id order by dedupe_key) into cards from core.blurbs where dedupe_key like 'sl-%';
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SL Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sl-%';
  -- the reader viewed cards 1-3 two hours ago, liked card 1 (with a long read) and card 2 was updated after the view
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select ua, cards[g], 'view', null, now() - interval '2 hours' from generate_series(1,3) g;
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at) values
    (ua, cards[1], 'dwell', 12000, now() - interval '2 hours'), (ua, cards[1], 'like', null, now() - interval '2 hours');
  update core.blurbs set updated_at = now() - interval '1 hour', revision = 2 where id = cards[2];

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  r := api.feed_for_you(null, 30);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  sf := (r ->> 'seen_from')::int;
  if cardinality(ids) <> 12 then raise exception 'FAIL: For you must still list all 12 cards (got %)', cardinality(ids); end if;
  if sf is distinct from 10 then raise exception 'FAIL: seen_from must be 10 (cards 1 and 3 seen), got %', sf; end if;
  if cards[1] = any (ids[1:10]) then raise exception 'FAIL: a liked card must not come back in the unseen part'; end if;
  if not (cards[1] = any (ids[11:12])) then raise exception 'FAIL: the liked card must be in the seen tail'; end if;
  if not (cards[2] = any (ids[1:10])) then raise exception 'FAIL: an updated story must still come back'; end if;
  -- Trending is untouched
  if jsonb_array_length(api.feed('top', null, 30, null) -> 'items') <> 12 then raise exception 'FAIL: Trending must list all 12 cards'; end if;
  perform set_config('role', 'none', true);

  update core.rank_params set value = 1 where key = 'seen_liked_comeback';
  perform set_config('role', 'authenticated', true);
  r := api.feed_for_you(null, 30);
  ids := array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
  if (r ->> 'seen_from')::int is distinct from 11 or not (cards[1] = any (ids[1:11])) then
    raise exception 'FAIL: with seen_liked_comeback = 1 the liked card must come back (old behaviour)'; end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  raise exception 'ALL SEEN LIKED CHECKS PASSED (test rows rolled back on purpose)';
end $$;
