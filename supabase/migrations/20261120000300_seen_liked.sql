-- For you: a liked card no longer comes back (Drew's rule "a card seen in For you is not in For you again").
-- Must run after 20261113000000_seen_exclusion.sql. Idempotent. NOT applied.
--
-- Why (offline evaluation, supabase/tests/eval/feed-eval.mjs, 2026-11-09): 20261113 exempted liked cards from the
-- seen exclusion ("may come back"). The liked card keeps its topic boost, and its 100 h read penalty is not enough
-- when the 30-day window holds few fresh cards (the live supply was 4 cards in 24 h), so liked cards climbed back
-- to the top: a reader who likes rates news saw 6 already-liked cards in the top 10 of their 4th For you visit
-- (novelty 20%). With this change every viewed card counts as seen, liked or not.
-- Setting: core.rank_params seen_liked_comeback = 0 (new default; liked cards are seen like any other);
-- 1 = the old behaviour. Updated stories (changed after the last view) and followed stories still come back.
-- Only core.seen_ids is replaced (same signature; its body is 20261113's apart from the liked line).
-- Guests: lib/feed/seenFilter.ts SEEN_LIKED_COMEBACK mirrors the setting. Checked by tests/seen_liked_check.sql.

insert into core.rank_params (key, value) values
  ('seen_liked_comeback', 0)     -- 0 = a liked card counts as seen (not shown again in For you); 1 = liked cards may come back
on conflict (key) do nothing;
alter table core.rank_params drop constraint if exists rank_params_seen_liked_range;
alter table core.rank_params add constraint rank_params_seen_liked_range
  check (key <> 'seen_liked_comeback' or value in (0, 1));

create or replace function core.seen_ids(p_user uuid, p_asof timestamptz)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode numeric; v_days numeric; v_max numeric;
  v_ids  uuid[];
  v_ex   uuid[] := '{}';
  v_fmax numeric;
  v_like boolean;
begin
  if p_user is null then return '{}'; end if;
  select coalesce(max(value) filter (where key = 'seen_exclude_mode'), 0),
         greatest(coalesce(max(value) filter (where key = 'seen_exclude_days'), 14), 1),
         greatest(coalesce(max(value) filter (where key = 'seen_exclude_max'), 800), 1),
         greatest(coalesce(max(value) filter (where key = 'seen_followed_max'), 200), 0),
         coalesce(max(value) filter (where key = 'seen_liked_comeback'), 0) = 1
    into v_mode, v_days, v_max, v_fmax, v_like
    from core.rank_params;
  if v_mode = 0 then return '{}'; end if;

  -- Followed stories are exempt (and their linked updates). The ids come with the request (api.feed_for_you's
  -- p_followed, put in the transaction setting element.seen_exempt): follows live on the device, not on the server.
  -- Bounded: only the first seen_followed_max ids count; a malformed list counts as empty.
  begin
    v_ex := coalesce((string_to_array(nullif(current_setting('element.seen_exempt', true), ''), ',')::uuid[])[1:v_fmax::int], '{}');
  exception when others then v_ex := '{}';
  end;
  if cardinality(v_ex) > 0 then
    v_ex := v_ex || array(select l.related_id from core.story_links l where l.card_id = any (v_ex) and l.kind = 'update')
                 || array(select l.card_id from core.story_links l where l.related_id = any (v_ex) and l.kind = 'update');
  end if;

  select coalesce(array_agg(s.blurb_id order by s.last_at desc), '{}') into v_ids
    from (
      select x.blurb_id, x.last_at
        from (
          select r.blurb_id, max(r.created_at) as last_at     -- the latest view rows only (index range scan + limit)
            from (select e.blurb_id, e.created_at
                    from core.user_events e
                   where e.user_id = p_user and e.kind = 'view'
                     and e.created_at <= p_asof
                     and e.created_at > p_asof - make_interval(secs => v_days * 86400)
                   order by e.created_at desc
                   limit v_max * 2) r
           group by r.blurb_id
        ) x
        join core.blurbs b on b.id = x.blurb_id
       where x.blurb_id <> all (v_ex)                                            -- followed story: exempt
         and (b.updated_at is null or b.updated_at <= x.last_at)             -- updated since: may come back
         and (not v_like                                                     -- liked: only with seen_liked_comeback = 1
              or not exists (select 1 from core.user_events l
                              where l.user_id = p_user and l.blurb_id = x.blurb_id and l.kind = 'like'))
       order by x.last_at desc
       limit v_max
    ) s;
  return v_ids;
exception
  when query_canceled then return '{}';      -- statement timeout: serve the feed without exclusion
  when others then return '{}';
end;
$$;
revoke all on function core.seen_ids(uuid, timestamptz) from public, anon, authenticated;
