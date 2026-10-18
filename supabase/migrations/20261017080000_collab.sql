-- =============================================================================
-- Element: For you learns from you over time AND from other readers (2026-10-17)
--
--   A  tunable values (core.rank_params)
--   B  personal affinity v3: per topic, per card type and per source, with confidence that
--      grows with the number of signals (a shrunk average: few signals -> close to zero)
--   C  crowd tables, one set per Trending generation (private, aggregate only, >= 3 users):
--        core.collab_cards   "readers who engaged with card X also engaged with card Y"
--        core.collab_topics  "readers who like topic K engage with topic L more / less than usual"
--      core.crowd_pairs(): one row per (user, card) in the last collab_window_days (private)
--   D  core.refresh_trending(): same buzz as before + a smoothed engagement rate per card
--      ("quality") + rebuilds the crowd tables in the same generation (same RPC, same lock)
--   E  api.feed_for_you v3: v2 + type/source affinity + card neighbours + crowd topic prior for
--      users with few signals. Cursor, card keys, breadth rules, hidden topics/sources unchanged.
--
-- Privacy: the crowd tables hold card pairs, topic pairs and numbers only (no user id, text,
-- IP or device data), each built from at least collab_min_users (3) different people, and are
-- readable only by the owner / security-definer functions (RLS on, no grants). A user's own
-- signals only shape that user's own feed. delete_my_data / delete_account: events are deleted
-- as before; the next refresh (end of the next ingest run) leaves that user out of every
-- aggregate, and old generations are trimmed (trend_keep_generations).
-- api.feed (guest Trending / Latest) is NOT recreated: Trending only changes through the boost
-- numbers (quality, switch off with trend_quality_hours = 0).
-- Requires 20261017070000_trending_foryou.sql and 20261017071000_diversity_patch.sql.
-- Idempotent: safe to run more than once.
-- =============================================================================


-- =============================================================================
-- A. TUNABLE VALUES
-- Personal (hours before foryou_personal_scale, which multiplies them by 3):
--   per dimension d (topic, card type, source), over the user's cards with signals:
--     raw_d  = clamp( sum(s x fade), -cap_d, +cap_d )            (topic: same number as before,
--              s = the card's signal score (like +1, detail +0.5, ...)   shown in api.get_prefs)
--     n_d    = sum(fade) over the user's cards in d with a non-zero score (evidence)
--     conf_d = n_d / (n_d + aff_prior_cards)                     aff_prior_cards = 0.25
--     For you uses conf_d x raw_d: 1 like -> 0.8 x 1, 3 likes -> 0.92 x 3, 9 likes -> 0.97 x 4.
--     (0.25, not 1: in the offline test a stronger pull toward zero cost precision, see
--     the results note; conf also hands each topic over from the crowd hint to the user.)
--     fade = 0.5 ^ (days / signal_half_life_days)
--   affinity_cap_hours 4 (topic), aff_cap_type_hours 1 (card type = event_type, else card kind),
--   aff_cap_source_hours 1 (source key: sec, fed, usgs, ...)
-- Crowd (last collab_window_days = 14, "positive" = like / detail / source tap / long look and
-- no dislike; fade 0.5 ^ (days / collab_half_life_days = 7)):
--   cards:   sim(i,j) = sum(w_i w_j) / (sqrt(sum w_i^2 x sum w_j^2) + collab_card_shrink 5),
--            only pairs with >= collab_min_users (3) people; top collab_card_neighbors (20) kept;
--            at most collab_max_per_user (50) newest positive cards per person
--            For you: x = sum over my positive cards of fade x sim;
--            boost = collab_card_hours (4) x x / (x + collab_card_half 0.5)        (< 4 h)
--   topics:  group G_k = people who follow topic k or were positive on >= collab_topic_min_pos (2)
--            cards in k; '*' = everyone. rate(G,l) = (pos + n0 x rate_G) / (shown + n0),
--            n0 = collab_topic_prior_n (20); lift = clamp(rate(G,l)/rate_G - 1, -1, 1);
--            cells need >= 3 people. For you: prior(l) = weighted average of lift(k,l) over my
--            topics k <> l (follows weight 1, liked topics weight conf x affinity / cap), else
--            lift('*', l) (everyone);
--            boost = foryou_personal_scale x collab_topic_hours (2) x prior x (1 - conf_l):
--            per topic, the crowd guess hands over to the user's own evidence as it comes in.
--   quality: q = (pos - dislikes + n0 x p_k) / (shown + n0), n0 = collab_quality_prior_n (10),
--            p_k = the topic's rate (floor 0.02); boost = clamp(collab_quality_hours (2) x
--            log2(q / p_k), -2, 2) when >= 3 people saw the card; added to the Trending boost
--            (total still trend_max_neg_hours .. trend_max_hours = -3 .. +6 h), so it reaches
--            Trending and For you. trend_quality_hours (1 = on, 0 = off) switches it.
-- =============================================================================

insert into core.rank_params (key, value) values
  ('aff_prior_cards',          0.25),
  ('aff_cap_type_hours',       1),
  ('aff_cap_source_hours',     1),
  ('collab_window_days',       14),
  ('collab_half_life_days',    7),
  ('collab_min_users',         3),
  ('collab_max_per_user',      50),
  ('collab_card_shrink',       5),
  ('collab_card_neighbors',    20),
  ('collab_card_hours',        4),
  ('collab_card_half',         0.5),
  ('collab_topic_min_pos',     2),
  ('collab_topic_prior_n',     20),
  ('collab_topic_hours',       2),
  ('collab_quality_prior_n',   10),
  ('collab_quality_hours',     2),
  ('trend_quality_hours',      1)
on conflict (key) do nothing;


-- =============================================================================
-- B. PERSONAL AFFINITY v3 (private)
-- core.user_affinity_dims(user, as_of) -> (dim 'category' | 'type' | 'source', key, hours, n, conf)
--   hours = the evidence sum, clamped (for 'category' exactly the 070000 number)
--   n     = faded number of the user's cards in that group with a non-zero score
--   conf  = n / (n + aff_prior_cards): how sure we are; For you uses conf x hours
-- core.user_affinity(user[, as_of]) keeps its old shape and numbers (category, hours) for
-- api.get_prefs and the app contract (affinity per topic, -4 .. +4).
-- =============================================================================

drop function if exists core.user_affinity_dims(uuid, timestamptz);   -- older draft had another shape

create or replace function core.user_affinity_dims(p_user uuid, p_asof timestamptz)
returns table (dim text, key text, hours numeric, n numeric, conf numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select coalesce(max(value) filter (where key = 'w_like'),             1)     as w_like,
           coalesce(max(value) filter (where key = 'w_dislike'),         -1)     as w_dislike,
           coalesce(max(value) filter (where key = 'w_open_detail'),      0.5)   as w_detail,
           coalesce(max(value) filter (where key = 'w_open_source'),      0.5)   as w_source,
           coalesce(max(value) filter (where key = 'w_dwell_long'),       0.25)  as w_long,
           coalesce(max(value) filter (where key = 'w_dwell_skip'),      -0.15)  as w_skip,
           coalesce(max(value) filter (where key = 'w_view'),             0)     as w_view,
           coalesce(max(value) filter (where key = 'dwell_skip_ms'),      1500)  as skip_ms,
           coalesce(max(value) filter (where key = 'dwell_walkaway_ms'),  120000) as walk_ms,
           coalesce(max(value) filter (where key = 'card_cap_pos_hours'), 1.5)   as card_pos,
           coalesce(max(value) filter (where key = 'card_cap_neg_hours'), -1)    as card_neg,
           coalesce(max(value) filter (where key = 'affinity_days'),      30)    as days,
           coalesce(max(value) filter (where key = 'signal_half_life_days'), 14) as half,
           coalesce(max(value) filter (where key = 'aff_prior_cards'),    0.25)  as k,
           coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4)     as c_cat,
           coalesce(max(value) filter (where key = 'aff_cap_type_hours'),  1)    as c_typ,
           coalesce(max(value) filter (where key = 'aff_cap_source_hours'),  1)  as c_src,
           coalesce(max(value) filter (where key = 'dwell_long_ms'),      8000)  as ll_max,
           coalesce(max(value) filter (where key = 'dwell_long_min_ms'),  6000)  as ll_min,
           coalesce(max(value) filter (where key = 'dwell_ms_per_word'),  150)   as ll_pw
      from core.rank_params
  ), ev as (
    select e.blurb_id,
           bool_or(e.kind = 'like')        as liked,
           bool_or(e.kind = 'dislike')     as disliked,
           bool_or(e.kind = 'open_detail') as detail,
           bool_or(e.kind = 'open_source') as src,
           bool_or(e.kind = 'view')        as viewed,
           max(e.dwell_ms) filter (where e.dwell_ms <= p.walk_ms) as max_dwell,   -- walked away = no look
           max(e.created_at)               as last_at
      from core.user_events e cross join p
     where e.user_id = p_user
       and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => p.days::int)
     group by e.blurb_id
  ), card as (
    select b.category,
           coalesce(b.event_type, b.kind) as typ,
           core.source_key_of(b.kind, b.id) as skey,
           greatest(least(
               case when ev.liked    then p.w_like   else 0 end
             + case when ev.disliked then p.w_dislike else 0 end
             + case when ev.detail   then p.w_detail else 0 end
             + case when ev.src      then p.w_source else 0 end
             + case when ev.viewed   then p.w_view   else 0 end
             + case when ev.max_dwell >= least(p.ll_max, greatest(p.ll_min, coalesce(b.word_count, 0) * p.ll_pw))   -- = core.long_look_ms
                    then p.w_long else 0 end
             + case when ev.max_dwell <= p.skip_ms
                     and not (ev.liked or ev.detail or ev.src) then p.w_skip else 0 end,
             p.card_pos), p.card_neg) as s,
           power(0.5::numeric, (extract(epoch from (p_asof - ev.last_at)) / 86400.0)::numeric / greatest(p.half, 0.01)) as f
      from ev
      join core.blurbs b on b.id = ev.blurb_id
      cross join p
  ), d as (
    select 'category'::text as dim, c.category as key, c.s, c.f from card c
    union all
    select 'type', c.typ, c.s, c.f from card c
    union all
    select 'source', c.skey, c.s, c.f from card c where c.skey is not null
  ), g as (
    select d.dim, d.key,
           greatest(least(sum(d.s * d.f),
             case d.dim when 'category' then max(p.c_cat) when 'type' then max(p.c_typ) else max(p.c_src) end),
             -case d.dim when 'category' then max(p.c_cat) when 'type' then max(p.c_typ) else max(p.c_src) end) as hours,
           coalesce(sum(d.f) filter (where d.s <> 0), 0) as n,
           max(p.k) as k
      from d cross join p
     group by d.dim, d.key
  )
  select g.dim, g.key, g.hours, round(g.n, 6), round(g.n / greatest(g.n + g.k, 0.000001), 6)
    from g;
$$;

create or replace function core.user_affinity(p_user uuid, p_asof timestamptz)
returns table (category text, hours numeric)
language sql
stable
security definer
set search_path = ''
as $$ select a.key, a.hours from core.user_affinity_dims(p_user, p_asof) a where a.dim = 'category'; $$;

revoke all on function core.user_affinity_dims(uuid, timestamptz) from public, anon, authenticated;
revoke all on function core.user_affinity(uuid, timestamptz)      from public, anon, authenticated;


-- =============================================================================
-- C. CROWD TABLES (private; one set per Trending generation, trimmed with it)
-- =============================================================================

create table if not exists core.collab_cards (
  gen         bigint  not null references core.trend_generations (gen) on delete cascade,
  blurb_id    uuid    not null references core.blurbs (id) on delete cascade,
  neighbor_id uuid    not null references core.blurbs (id) on delete cascade,
  sim         numeric not null,
  primary key (gen, blurb_id, neighbor_id)
);

create table if not exists core.collab_topics (
  gen        bigint  not null references core.trend_generations (gen) on delete cascade,
  topic_a    text    not null,          -- '*' = everyone
  topic_b    text    not null,
  lift       numeric not null,          -- -1 .. +1
  primary key (gen, topic_a, topic_b)
);

alter table core.collab_cards  enable row level security;   -- no policies: private
alter table core.collab_topics enable row level security;
revoke all on core.collab_cards, core.collab_topics from public, anon, authenticated;

-- one row per (user, published card) with any event in the last p_days:
-- pos = like / detail / source tap / long look (not walked away) and no dislike
create or replace function core.crowd_pairs(p_days numeric)
returns table (user_id uuid, blurb_id uuid, category text, pos boolean, disliked boolean, last_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select coalesce(max(value) filter (where key = 'dwell_long_ms'),     8000)   as ll_max,
           coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000)   as ll_min,
           coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150)    as ll_pw,
           coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000) as walk
      from core.rank_params
  )
  select e.user_id, e.blurb_id, min(b.category),
         bool_or(e.kind in ('like', 'open_detail', 'open_source')
                 or (e.kind = 'dwell'   -- long look = core.long_look_ms(words), inlined (one rank_params read)
                     and e.dwell_ms >= least(p.ll_max, greatest(p.ll_min, coalesce(b.word_count, 0) * p.ll_pw))
                     and e.dwell_ms <= p.walk))
           and not bool_or(e.kind = 'dislike'),
         bool_or(e.kind = 'dislike'),
         max(e.created_at)
    from core.user_events e
    join core.blurbs b on b.id = e.blurb_id and b.status = 'published'
    cross join p
   where e.created_at > now() - make_interval(days => greatest(p_days, 1)::int)
   group by e.user_id, e.blurb_id;
$$;
revoke all on function core.crowd_pairs(numeric) from public, anon, authenticated;


-- =============================================================================
-- D. REFRESH (same function name, same RPC api.refresh_trending, same lock)
-- returns {generation, boosted, top_boost, card_links, topic_cells}
-- =============================================================================

create or replace function core.refresh_trending()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gen  bigint;
  v_n    int;
  v_top  numeric;
  v_cl   int;
  v_tc   int;
  p      record;
begin
  perform pg_advisory_xact_lock(hashtext('element.refresh_trending'));

  select coalesce(max(value) filter (where key = 'trend_window_hours'),     48)  as win,
         coalesce(max(value) filter (where key = 'trend_max_hours'),        6)   as maxh,
         coalesce(max(value) filter (where key = 'trend_max_neg_hours'),    3)   as maxneg,
         coalesce(max(value) filter (where key = 'trend_half_points'),      8)   as half,
         coalesce(max(value) filter (where key = 'trend_min_users'),        2)   as minu,
         coalesce(max(value) filter (where key = 'trend_w_like'),           3)   as w_like,
         coalesce(max(value) filter (where key = 'trend_w_open_detail'),    2)   as w_detail,
         coalesce(max(value) filter (where key = 'trend_w_open_source'),    2)   as w_source,
         coalesce(max(value) filter (where key = 'trend_w_dwell_long'),     1)   as w_long,
         coalesce(max(value) filter (where key = 'trend_w_view'),           0.2) as w_view,
         coalesce(max(value) filter (where key = 'trend_w_dislike'),        3)   as w_dislike,
         coalesce(max(value) filter (where key = 'trend_keep_generations'), 6)   as keep,
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'),      120000) as walk,
         coalesce(max(value) filter (where key = 'trend_quality_hours'),    1)   as q_on,
         coalesce(max(value) filter (where key = 'collab_window_days'),     14)  as cwin,
         coalesce(max(value) filter (where key = 'collab_half_life_days'),  7)   as chalf,
         coalesce(max(value) filter (where key = 'collab_min_users'),       3)   as cminu,
         coalesce(max(value) filter (where key = 'collab_max_per_user'),    50)  as cmaxper,
         coalesce(max(value) filter (where key = 'collab_card_shrink'),     5)   as cshrink,
         coalesce(max(value) filter (where key = 'collab_card_neighbors'),  20)  as ctop,
         coalesce(max(value) filter (where key = 'collab_topic_min_pos'),   2)   as tminpos,
         coalesce(max(value) filter (where key = 'collab_topic_prior_n'),   20)  as tn0,
         coalesce(max(value) filter (where key = 'collab_quality_prior_n'), 10)  as qn0,
         coalesce(max(value) filter (where key = 'collab_quality_hours'),   2)   as qh
    into p
    from core.rank_params;

  select coalesce(max(gen), 0) + 1 into v_gen from core.trend_generations;
  insert into core.trend_generations (gen) values (v_gen);

  -- Trending boost = buzz (as before) + quality (smoothed engagement rate), kept in -maxneg .. maxh
  insert into core.trend_boosts (gen, blurb_id, boost)
  select v_gen, z.blurb_id, z.boost
    from (
      select coalesce(x.blurb_id, q.blurb_id) as blurb_id,
             round(greatest(least(
                 coalesce(case when x.pts > 0 then  p.maxh   * x.pts  / (x.pts  + p.half)
                               else                -p.maxneg * (-x.pts) / (-x.pts + p.half) end, 0)
               + coalesce(q.boost, 0) * greatest(p.q_on, 0),
               p.maxh), -p.maxneg), 6) as boost
        from (
          select e.blurb_id,
                   p.w_like    * count(distinct e.user_id) filter (where e.kind = 'like')
                 + p.w_detail  * count(distinct e.user_id) filter (where e.kind = 'open_detail')
                 + p.w_source  * count(distinct e.user_id) filter (where e.kind = 'open_source')
                 + p.w_long    * count(distinct e.user_id) filter (where e.kind = 'dwell'
                                     and e.dwell_ms >= core.long_look_ms(b.word_count)
                                     and e.dwell_ms <= p.walk)
                 + p.w_view    * count(distinct e.user_id) filter (where e.kind = 'view')
                 - p.w_dislike * count(distinct e.user_id) filter (where e.kind = 'dislike') as pts
            from core.user_events e
            join core.blurbs b on b.id = e.blurb_id and b.status = 'published'
           where e.created_at > now() - make_interval(hours => p.win::int)
           group by e.blurb_id
          having count(distinct e.user_id) >= p.minu
        ) x
        full join (
          with cp as (select * from core.crowd_pairs(p.cwin)),
          tk as (                                        -- topic rate (floor 0.02)
            select cp.category,
                   greatest((count(*) filter (where cp.pos) - count(*) filter (where cp.disliked))::numeric
                            / count(*), 0.02) as pk
              from cp group by cp.category
          )
          select cp.blurb_id,
                 greatest(least(p.qh * log(2::numeric,
                   greatest((count(*) filter (where cp.pos) - count(*) filter (where cp.disliked) + p.qn0 * max(tk.pk))
                            / (count(*) + p.qn0), 0.001) / max(tk.pk)), p.qh), -p.qh) as boost
            from cp join tk on tk.category = cp.category
           group by cp.blurb_id
          having count(*) >= p.cminu
        ) q on q.blurb_id = x.blurb_id
    ) z
   where z.boost <> 0;
  get diagnostics v_n = row_count;

  -- card neighbours: distinct-user co-engagement, faded, >= cminu people per pair, top ctop per card
  insert into core.collab_cards (gen, blurb_id, neighbor_id, sim)
  with lim as (
    select c.user_id, c.blurb_id,
           power(0.5::numeric, (extract(epoch from (now() - c.last_at)) / 86400.0)::numeric / greatest(p.chalf, 0.01)) as w
      from (select cp.*, row_number() over (partition by cp.user_id order by cp.last_at desc, cp.blurb_id) as rn
              from core.crowd_pairs(p.cwin) cp where cp.pos) c
     where c.rn <= p.cmaxper
  ), nn as (
    select l.blurb_id, sum(l.w * l.w) as nn from lim l group by l.blurb_id
  ), pr as (
    select a.blurb_id as i, b.blurb_id as j, sum(a.w * b.w) as dot
      from lim a join lim b on b.user_id = a.user_id and b.blurb_id <> a.blurb_id
     group by a.blurb_id, b.blurb_id
    having count(distinct a.user_id) >= p.cminu
  ), s as (
    select pr.i, pr.j, pr.dot / (sqrt(ni.nn * nj.nn) + p.cshrink) as sim
      from pr join nn ni on ni.blurb_id = pr.i join nn nj on nj.blurb_id = pr.j
  ), r as (
    select s.*, row_number() over (partition by s.i order by s.sim desc, s.j) as rn from s
  )
  select v_gen, r.i, r.j, round(r.sim, 6) from r where r.rn <= p.ctop and r.sim > 0;
  get diagnostics v_cl = row_count;

  -- topic lifts: per reader group (followers / likers of topic k, and '*' = everyone)
  insert into core.collab_topics (gen, topic_a, topic_b, lift)
  with cp as (
    select * from core.crowd_pairs(p.cwin)
  ), likes as (                                   -- (user, topic k) the user likes
    select up.user_id, f.k
      from core.user_prefs up cross join lateral unnest(up.followed_categories) as f(k)
    union
    select cp.user_id, cp.category from cp where cp.pos
     group by cp.user_id, cp.category having count(*) >= p.tminpos
  ), grp as (
    select '*'::text as k, cp.user_id, cp.category, cp.pos from cp
    union all
    select l.k, cp.user_id, cp.category, cp.pos from cp join likes l on l.user_id = cp.user_id
  ), gr as (
    select g.k, greatest(avg(case when g.pos then 1 else 0 end)::numeric, 0.01) as rate from grp g group by g.k
  ), cell as (
    select g.k, g.category, count(*) as shown, count(*) filter (where g.pos) as pos,
           count(distinct g.user_id) as users
      from grp g group by g.k, g.category
  )
  select v_gen, c.k, c.category,
         round(greatest(least(((c.pos + p.tn0 * gr.rate) / (c.shown + p.tn0)) / gr.rate - 1, 1), -1), 6)
    from cell c join gr on gr.k = c.k
   where c.users >= p.cminu and c.k <> c.category;
  get diagnostics v_tc = row_count;

  select max(boost) into v_top from core.trend_boosts where gen = v_gen;
  delete from core.trend_generations where gen <= v_gen - greatest(p.keep, 1);   -- boosts and crowd tables cascade

  return jsonb_build_object('generation', v_gen, 'boosted', v_n, 'top_boost', v_top,
                            'card_links', v_cl, 'topic_cells', v_tc);
end;
$$;

revoke all on function core.refresh_trending() from public, anon, authenticated;
-- api.refresh_trending() (service role only) is unchanged and calls this.


-- =============================================================================
-- E. api.feed_for_you v3 (same signature, cursor and card shape as 071000)
-- score = rank_score + trend boost (gen; buzz + smoothed quality)
--       + scale x (follow + conf x topic affinity + conf x type affinity + conf x source affinity
--                  + explore + collab_topic_hours x crowd prior x (1 - topic conf))
--       + card-neighbour boost (gen, < collab_card_hours)
--       - seen penalties, - 0.5 h per better same-topic card, then core.diversify (unchanged)
-- Every input is frozen by the cursor (as_of for the user's own signals, gen for the crowd),
-- so the order never changes while you scroll and pages never repeat.
-- =============================================================================

create or replace function api.feed_for_you(p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_limit   int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key     numeric;
  v_id      uuid;
  v_gen     bigint;
  v_asof    timestamptz;
  v_state   jsonb := '{}';
  v_div     jsonb;
  v_carry   uuid[] := '{}';
  v_left    uuid[];
  v_fetch   int;
  v_extra   int;
  v_more    boolean := false;
  v_lastkey text;
  v_lastid  uuid;
  v_fol     text[];
  v_hid     text[];
  v_hsrc    text[];
  v_follow  numeric; v_window numeric; v_seen numeric; v_seenv numeric;
  v_explore numeric; v_exmin numeric; v_step numeric; v_days numeric; v_scale numeric;
  v_chalf   numeric; v_ch numeric; v_chalfs numeric; v_th numeric; v_capc numeric;
  v_llmax   numeric; v_llmin numeric; v_llpw numeric; v_walk numeric;
  v_nev     int;
  v_ids     uuid[];
  v_keys    text[];
  v_out     uuid[];
  v_next    text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  if p_cursor is null then
    v_key := 1e12;
    v_id  := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_key  := split_part(p_cursor, '|', 1)::numeric;
      v_id   := split_part(p_cursor, '|', 2)::uuid;
      v_gen  := nullif(split_part(p_cursor, '|', 3), '')::bigint;
      v_asof := nullif(split_part(p_cursor, '|', 4), '')::timestamptz;
      v_state := core.state_from_text(split_part(p_cursor, '|', 5));
      v_carry := coalesce(string_to_array(nullif(split_part(p_cursor, '|', 6), ''), ',')::uuid[], '{}');
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;
  v_asof := least(coalesce(v_asof, clock_timestamp()), clock_timestamp());
  if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
    select coalesce(max(gen), 0) into v_gen from core.trend_generations;
  end if;

  select followed_categories, hidden_categories, hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs where user_id = v_uid;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  select coalesce(max(value) filter (where key = 'boost_followed_hours'), 2),
         coalesce(max(value) filter (where key = 'for_you_window_days'), 30),
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100),
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24),
         coalesce(max(value) filter (where key = 'foryou_explore_hours'), 1),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.5),
         coalesce(max(value) filter (where key = 'affinity_days'), 30),
         coalesce(max(value) filter (where key = 'foryou_personal_scale'), 3),
         coalesce(max(value) filter (where key = 'signal_half_life_days'), 14),
         coalesce(max(value) filter (where key = 'collab_card_hours'), 4),
         coalesce(max(value) filter (where key = 'collab_card_half'), 0.5),
         coalesce(max(value) filter (where key = 'collab_topic_hours'), 2),
         coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4),
         coalesce(max(value) filter (where key = 'dwell_long_ms'), 8000),
         coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000),
         coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150),
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000)
    into v_follow, v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale,
         v_chalf, v_ch, v_chalfs, v_th, v_capc, v_llmax, v_llmin, v_llpw, v_walk
    from core.rank_params;

  if cardinality(v_carry) > 0 then                       -- held back by the previous page
    select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
      from unnest(v_carry) with ordinality as u(id, o)
      join core.blurbs b on b.id = u.id
     where b.status = 'published'
       and not (b.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike');
  end if;
  select coalesce(max(value), 3)::int into v_extra from core.rank_params where key = 'diversity_carry';
  v_fetch := greatest(v_limit + greatest(v_extra, 0) - cardinality(v_carry), 1);

  select count(*) into v_nev from core.user_events e
   where e.user_id = v_uid and e.created_at < v_asof
     and e.created_at > v_asof - make_interval(days => v_days::int);

  with dims as materialized (
    select a.dim, a.key, a.hours, a.conf from core.user_affinity_dims(v_uid, v_asof) a
  ), sig as materialized (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
  ), shown as materialized (                             -- long look = core.long_look_ms(words), inlined
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw)))) as was_read
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), seeds as materialized (                                          -- my positive cards, faded
    select e.blurb_id,
           power(0.5::numeric, (extract(epoch from (v_asof - max(e.created_at))) / 86400.0)::numeric
                               / greatest(v_chalf, 0.01)) as w
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = v_uid and e.created_at < v_asof
       and e.created_at > v_asof - make_interval(days => v_days::int)
     group by e.blurb_id
    having bool_or(e.kind in ('like', 'open_detail', 'open_source')
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw))
                       and e.dwell_ms <= v_walk))
       and not bool_or(e.kind = 'dislike')
  ), co as materialized (                                             -- "readers who engaged with X also engaged with Y"
    select n.neighbor_id, sum(n.sim * s.w) as x
      from seeds s join core.collab_cards n on n.gen = v_gen and n.blurb_id = s.blurb_id
     group by n.neighbor_id
  ), mytopics as materialized (                                       -- my topics: follows (1) and liked topics (conf x aff/cap)
    select k, max(w) as w from (
      select unnest(v_fol) as k, 1::numeric as w
      union all
      select d.key, least(d.conf * d.hours / greatest(v_capc, 0.01), 1) from dims d where d.dim = 'category' and d.hours > 0
    ) t group by k
  ), crowd as materialized (                                          -- crowd guess per topic (lift -1 .. 1)
    select c.topic_b as category, sum(m.w * c.lift) / sum(m.w) as lift
      from mytopics m join core.collab_topics c on c.gen = v_gen and c.topic_a = m.k and c.topic_b <> m.k
     group by c.topic_b
  ), crowd_all as materialized (
    select c.topic_b as category, c.lift from core.collab_topics c where c.gen = v_gen and c.topic_a = '*'
  ), srckey as materialized (                            -- = core.source_key_of, worked out for all cards at once
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from core.blurb_sources s
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), cand as materialized (                              -- candidate cards
    select b.id, b.category, b.rank_score, coalesce(b.event_type, b.kind) as typ,
           case when b.kind = 'data' then 'fred' else sk.key end as skey
      from core.blurbs b
      left join srckey sk on sk.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= v_asof
       and b.sort_at > v_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = v_uid and d.blurb_id = b.id and d.kind = 'dislike')
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0)
             + v_scale * (
                 case when b.category = any (v_fol) then v_follow else 0 end
               + coalesce(ac.conf * ac.hours, 0) + coalesce(aty.conf * aty.hours, 0) + coalesce(asr.conf * asr.hours, 0)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce(ac.conf, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
      left join dims ac  on ac.dim = 'category' and ac.key = b.category
      left join dims aty on aty.dim = 'type'    and aty.key = b.typ
      left join dims asr on asr.dim = 'source'  and asr.key = b.skey
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
     where (cardinality(v_hsrc) = 0 or not (b.skey = any (v_hsrc)))
  ), scored as (
    select x.id, x.category,
           round(x.s0 - v_step * (row_number() over (partition by x.category order by x.s0 desc, x.id desc) - 1), 6) as ps
      from base x
  ), page as (
    select s.id, s.category, s.ps from scored s
     where (s.ps, s.id) < (v_key, v_id)
     order by s.ps desc, s.id desc
     limit v_fetch + 1
  )
  select array_agg(p.id order by p.ps desc, p.id desc),
         array_agg(p.ps::text order by p.ps desc, p.id desc)
    into v_ids, v_keys
    from page p;

  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_fetch then
    v_more := true; v_ids := v_ids[1:v_fetch]; v_keys := v_keys[1:v_fetch];
  end if;
  if cardinality(v_ids) > 0 then
    v_lastkey := v_keys[cardinality(v_ids)]; v_lastid := v_ids[cardinality(v_ids)];
  else
    v_lastkey := v_key::text; v_lastid := v_id;
  end if;
  v_ids := v_carry || v_ids;

  v_out := '{}';
  if cardinality(v_ids) > 0 then
    v_div  := core.diversify(v_ids, v_state, v_limit);
    v_out  := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
    v_left := array(select x::uuid from jsonb_array_elements_text(v_div -> 'left') with ordinality as t(x, o) order by o);
    if v_more or cardinality(v_left) > 0 then
      v_next := v_lastkey || '|' || v_lastid || '|' || v_gen || '|'
                || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                || '|' || core.state_to_text(v_div -> 'state') || '|' || array_to_string(v_left, ',');
    end if;
  end if;

  return jsonb_build_object('items', core.cards_json(v_out, v_uid), 'next_cursor', v_next);
end;
$$;

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste this file after 20261017071000_diversity_patch.sql (expected "Success. No
-- rows returned"; a second run gives the same), then run supabase/tests/collab_check.sql and the
-- older checks. As the service role: select api.refresh_trending();  -> now also reports
-- card_links and topic_cells (0 until at least 3 people engaged with the same cards / topics).
-- =============================================================================
