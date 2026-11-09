-- =============================================================================
-- Element: ranking v3 for For you (the formula plus a bounded per-reader term) (2026-11-12)
--
-- Shipped OFF. Nothing a reader sees changes until core.rank_params foryou_ml_mode is set to 3 by hand
-- (after Drew approves; ships at 0). Modes 0, 1 and 2 behave exactly as in 20261109000000_ranking_v2.sql
-- (one fix: a statement timeout inside v6 now also falls back to v5; PL/pgSQL "others" does not catch it).
-- Mode 3 needs no trained weights and no weekly job: everything is computed from the reader's own events.
-- api.feed (guest Trending / Latest) is not touched.
--
-- The formula, in plain words (spec: ml/v3-findings.md, Python: ml/elementml/v3/policy.py):
--   For each card the reader viewed in the last v3_window_days (30) days:
--     r_i  = the card's reward (like +1, detail +.5, source +.5, long look +.25, quick skip -.15,
--            dislike -1, capped -1 .. 1.5: the existing w_* rows, same as ranking v2)
--     f_i  = fade, half-life v3_half_life_days (14)
--     rbar = sum f r / (sum f + v3_k0)           the reader's usual reward, shrunk toward 0 by k0 = 3 cards
--     d_i  = r_i - rbar                         better or worse than usual
--   Per feature j (topic c:, story type t:, source s:, tag g:; core.card_features from ranking v2):
--     b_j  = sum f d [j on i] / (v3_lambda + sum f [j on i])      no population prior: 0 without evidence
--   Per candidate card:
--     hours = clamp(v3_hours_per_reward x sum_j g(j) b_j, +-v3_cap_hours)   (x v3_neg_mult when negative)
--     score = the v5 formula score (follow, affinity, explore, trend, card links, seen penalty) + hours
--   then v5's same-topic step, plus v3_step_extra (2.5 h) when the reader has any evidence, and
--   core.diversify. A reader with no evidence (new, or after delete_my_data) gets exactly the v5 order.
--   (Python applies the extra step to cold readers too. Gating it on evidence keeps NDCG the same in the
--   simulation but makes topic recovery about 1 day slower in the normal world, which fails that gate
--   line; v3_step_extra_cold = 1 restores the Python behaviour. See ml/ml.md.)
--   Tags: a card with no g: tag gets no tag term at all (real headlines get a tag only ~29% of the time,
--   mostly rates and recalls); its hours come from its topic, type and source only. A card none of whose
--   features the reader has evidence on gets exactly 0 hours, i.e. its v5 score.
--
-- Cost: one GROUP BY over the reader's own events (index user_events_user_time_idx, at most
-- v3_max_evidence_cards cards), precomputed card features (core.card_features, filled at publish by the v2
-- triggers), and v5's own candidate scan. More than v3_max_candidates cards in the window, or any error or
-- statement timeout in v3, serves v5 for that page.
--
-- Privacy: no new per-reader table; nothing is stored except the usual ml_pages log row (ml_terms = each
-- card's v3 hours). delete_my_data / delete_account are unchanged and reset a reader to cold start.
--
--   B  settings (core.rank_params v3_*, on conflict do nothing) and their range checks
--   D  core.v3_reader_weights(user, as_of): the reader's b_j (Python mirror: ml/elementml/v3/reference.py)
--   E  core.v3_scores(user, as_of, gen): v5's score per candidate plus the v3 hours and the page key
--   F  core.feed_for_you_v7(cursor, limit): v5's paging and breadth rules over core.v3_scores
--   G  api.feed_for_you: same signature and grants; modes 0/1/2 as before; mode 3 = v7 with a holdout.
--        v3 pages cursor  score|id|gen|as_of|state|carry||page_no|3
--   I  api.ml_v3_check(): daily kill switch (mode 3 -> 0 on a dislike spike), pg_cron where installed;
--      api.ml_v2_check() now counts only mode-2 holdout pages.
--
-- Idempotent. Run after 20261111000000_finance_sources_cron.sql. Check: supabase/tests/ranking_v3_check.sql
-- =============================================================================


-- =============================================================================
-- B. SETTINGS (change with UPDATE core.rank_params; mirrored in ml/elementml/v3/reference.py)
-- =============================================================================

insert into core.rank_params (key, value) values
  ('v3_hours_per_reward',     36),    -- H: one unit of centered reward on a card's features = 36 h of freshness
  ('v3_cap_hours',            30),    -- the per-reader term is clamped to +-30 h
  ('v3_lambda',                2),    -- pseudo-cards of prior (mean 0) per feature
  ('v3_k0',                    3),    -- pseudo-cards pulling the reader's usual reward toward 0
  ('v3_w_topic',               1),    -- group weights: topic c:
  ('v3_w_type',              0.5),    --                story type t:
  ('v3_w_source',            0.5),    --                source s:
  ('v3_w_tag',                 1),    --                tags g:
  ('v3_neg_mult',              1),    -- multiplier on negative card terms
  ('v3_step_extra',          2.5),    -- extra same-topic step (hours per better same-topic card ahead)
  ('v3_step_extra_cold',       0),    -- 1 = the extra step also for readers with no evidence (as in Python);
                                      -- 0 = a cold reader gets exactly the v5 order
  ('v3_window_days',          30),    -- evidence window
  ('v3_half_life_days',       14),    -- evidence fade
  ('v3_max_evidence_cards',  500),    -- at most this many of the reader's latest viewed cards count
  ('v3_max_candidates',     3000),    -- more cards in the For you window: serve v5 (request cost guard)
  ('v3_holdout_pct',          10),    -- % of readers (id hash) kept on the formula while mode 3 is on
  ('v3_kill_ratio',          1.2),    -- api.ml_v3_check: mode 3 -> 0 above this dislike ratio ...
  ('v3_kill_min_cards',      500)     -- ... with at least this many cards shown in each group
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_v3_range;
alter table core.rank_params add constraint rank_params_v3_range
  check ((key not in ('v3_half_life_days', 'v3_window_days', 'v3_max_evidence_cards', 'v3_max_candidates',
                      'v3_kill_ratio', 'v3_kill_min_cards') or value > 0)
     and (key not in ('v3_lambda', 'v3_k0', 'v3_cap_hours', 'v3_neg_mult', 'v3_hours_per_reward',
                      'v3_step_extra', 'v3_step_extra_cold', 'v3_holdout_pct') or value >= 0));


-- =============================================================================
-- D. core.v3_reader_weights(user, as_of): one row per feature the reader has evidence on
--    o_n = sum f, o_b = b_j, o_rbar = the reader's usual reward (same on every row). No rows = cold start.
-- =============================================================================

create or replace function core.v3_reader_weights(p_user uuid, p_asof timestamptz)
returns table (o_feature text, o_n double precision, o_b double precision, o_rbar double precision)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select coalesce(max(value) filter (where key = 'v3_window_days'), 30)                          as win,
           greatest(coalesce(max(value) filter (where key = 'v3_half_life_days'), 14), 0.01)::double precision as half,
           greatest(coalesce(max(value) filter (where key = 'v3_lambda'), 2), 0)::double precision  as lam,
           greatest(coalesce(max(value) filter (where key = 'v3_k0'), 3), 0)::double precision      as k0,
           greatest(coalesce(max(value) filter (where key = 'v3_max_evidence_cards'), 500), 1)::int as maxev,
           coalesce(max(value) filter (where key = 'w_like'), 1)::double precision          as w_like,
           coalesce(max(value) filter (where key = 'w_dislike'), -1)::double precision      as w_dislike,
           coalesce(max(value) filter (where key = 'w_open_detail'), 0.5)::double precision as w_detail,
           coalesce(max(value) filter (where key = 'w_open_source'), 0.5)::double precision as w_source,
           coalesce(max(value) filter (where key = 'w_dwell_long'), 0.25)::double precision as w_long,
           coalesce(max(value) filter (where key = 'w_dwell_skip'), -0.15)::double precision as w_skip,
           coalesce(max(value) filter (where key = 'w_view'), 0)::double precision          as w_view,
           coalesce(max(value) filter (where key = 'dwell_skip_ms'), 1500)            as skip_ms,
           coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000)      as walk,
           coalesce(max(value) filter (where key = 'card_cap_pos_hours'), 1.5)::double precision as cpos,
           coalesce(max(value) filter (where key = 'card_cap_neg_hours'), -1)::double precision  as cneg,
           coalesce(max(value) filter (where key = 'dwell_long_ms'), 8000)            as llmax,
           coalesce(max(value) filter (where key = 'dwell_long_min_ms'), 6000)        as llmin,
           coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150)         as llpw
      from core.rank_params
  ), ev as (                                               -- what the reader did per card in the window
    select e.blurb_id,
           bool_or(e.kind = 'like')        as liked,
           bool_or(e.kind = 'dislike')     as disliked,
           bool_or(e.kind = 'open_detail') as detail,
           bool_or(e.kind = 'open_source') as src,
           max(e.dwell_ms) filter (where e.dwell_ms <= p.walk) as max_dwell,
           max(e.created_at)               as last_at
      from p, core.user_events e
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => p.win::int)
     group by e.blurb_id
    having bool_or(e.kind = 'view')                        -- only cards the reader was shown
  ), evr as (                                              -- one evidence row per card: features, fade, reward
    select f.f,
           power(0.5::double precision, (extract(epoch from (p_asof - ev.last_at)) / 86400.0)::double precision / p.half) as w,
           greatest(least(
               p.w_like * ev.liked::int + p.w_dislike * ev.disliked::int + p.w_detail * ev.detail::int
             + p.w_source * ev.src::int + p.w_view
             + case when ev.max_dwell >= least(p.llmax, greatest(p.llmin, coalesce(b.word_count, 0) * p.llpw))
                    then p.w_long else 0 end
             + case when ev.max_dwell <= p.skip_ms and not (ev.liked or ev.detail or ev.src)
                    then p.w_skip else 0 end,
             p.cpos), p.cneg) as r
      from p, ev
      join core.blurbs b on b.id = ev.blurb_id
      left join core.card_features cf on cf.blurb_id = b.id
      cross join lateral (select coalesce(cf.features,       -- precomputed at publish; computed only if missing
                                          core.v2_features(b.category, coalesce(b.event_type, b.kind),
                                                           case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end,
                                                           b.headline, b.macro)) as f) f
     where cardinality(f.f) > 0
     order by ev.last_at desc, ev.blurb_id desc
     limit (select p.maxev from p)
  ), mean as (
    select coalesce(sum(evr.w * evr.r) / nullif(sum(evr.w) + (select p.k0 from p), 0), 0) as rbar from evr
  ), st as (
    select u.j, sum(evr.w) as n, sum(evr.w * (evr.r - mean.rbar)) as s
      from evr cross join mean cross join unnest(evr.f) as u(j)
     group by u.j
  )
  select st.j, st.n, coalesce(st.s / nullif(p.lam + st.n, 0), 0), mean.rbar
    from st cross join p cross join mean;
$$;

revoke all on function core.v3_reader_weights(uuid, timestamptz) from public, anon, authenticated;


-- =============================================================================
-- E. core.v3_scores(user, as_of, gen): one row per candidate card
--   o_s0 = v5's score (= core.feed_for_you_v5's s0, same code), o_v3 = the v3 hours (6 places),
--   o_ps = (o_s0 + o_v3) - step x (better cards of the same topic), 6 places (the page key).
--   Candidates and every v5 term are v5's (section E2 of 20261019010000_ml_shadow.sql, copied).
-- =============================================================================

create or replace function core.v3_scores(p_user uuid, p_asof timestamptz, p_gen bigint)
returns table (o_id uuid, o_category text, o_s0 numeric, o_v3 numeric, o_ps numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fol     text[];
  v_hid     text[];
  v_hsrc    text[];
  v_taste   jsonb;
  v_window numeric; v_seen numeric; v_seenv numeric;
  v_explore numeric; v_exmin numeric; v_step numeric; v_days numeric; v_scale numeric;
  v_chalf   numeric; v_ch numeric; v_chalfs numeric; v_th numeric; v_capc numeric;
  v_llmax   numeric; v_llmin numeric; v_llpw numeric; v_walk numeric;
  v_h       numeric; v_cold numeric; v_coldn numeric;
  v_nev     int;
  v_fj      text[];
  v_fw      double precision[];
  v_hpr     double precision; v_cap double precision; v_neg double precision; v_xstep numeric; v_xcold numeric;
begin
  select followed_categories, hidden_categories, hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs where user_id = p_user;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  select coalesce(max(value) filter (where key = 'for_you_window_days'), 30),
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100),
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24),
         coalesce(max(value) filter (where key = 'foryou_explore_hours'), 1),
         coalesce(max(value) filter (where key = 'foryou_explore_min_events'), 5),
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.75),
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
         coalesce(max(value) filter (where key = 'dwell_walkaway_ms'), 120000),
         coalesce(max(value) filter (where key = 'half_life_hours'), 8),
         coalesce(max(value) filter (where key = 'foryou_cold_step_hours'), 4),
         coalesce(max(value) filter (where key = 'foryou_cold_events'), 5),
         coalesce(max(value) filter (where key = 'v3_hours_per_reward'), 36)::double precision,
         greatest(coalesce(max(value) filter (where key = 'v3_cap_hours'), 30), 0)::double precision,
         coalesce(max(value) filter (where key = 'v3_neg_mult'), 1)::double precision,
         coalesce(max(value) filter (where key = 'v3_step_extra'), 2.5),
         coalesce(max(value) filter (where key = 'v3_step_extra_cold'), 0)
    into v_window, v_seen, v_seenv, v_explore, v_exmin, v_step, v_days, v_scale,
         v_chalf, v_ch, v_chalfs, v_th, v_capc, v_llmax, v_llmin, v_llpw, v_walk,
         v_h, v_cold, v_coldn, v_hpr, v_cap, v_neg, v_xstep, v_xcold
    from core.rank_params;

  select count(*) into v_nev from core.user_events e
   where e.user_id = p_user and e.created_at < p_asof
     and e.created_at > p_asof - make_interval(days => v_days::int);
  if cardinality(v_fol) = 0 then                         -- cold start: v5's extra topic spread
    v_step := v_step + greatest(v_cold, 0) * greatest(1 - v_nev::numeric / greatest(v_coldn, 1), 0);
  end if;
  v_taste := core.user_taste(p_user, p_asof);

  -- the reader's per-feature weights, already times the group weight (empty = cold start: v5 exactly)
  select array_agg(w.o_feature),
         array_agg(w.o_b * coalesce((select r.value from core.rank_params r
                                      where r.key = case split_part(w.o_feature, ':', 1)
                                                      when 'c' then 'v3_w_topic' when 't' then 'v3_w_type'
                                                      when 's' then 'v3_w_source' else 'v3_w_tag' end),
                                     case split_part(w.o_feature, ':', 1) when 't' then 0.5 when 's' then 0.5 else 1 end)::double precision)
    into v_fj, v_fw
    from core.v3_reader_weights(p_user, p_asof) w;
  if v_fj is not null or v_xcold > 0 then v_step := v_step + greatest(v_xstep, 0); end if;

  return query
  with hl as materialized (                              -- freshness half-life per topic
    select substr(r.key, length('foryou_half_life_') + 1) as category, greatest(r.value, 0.5) as h
      from core.rank_params r where r.key like 'foryou\_half\_life\_%'
  ), sig as materialized (
    select distinct b.category
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => v_days::int)
  ), shown as materialized (                             -- long look = core.long_look_ms(words), inlined
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw)))) as was_read
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), seeds as materialized (                             -- my positive cards, faded
    select e.blurb_id,
           power(0.5::numeric, (extract(epoch from (p_asof - max(e.created_at))) / 86400.0)::numeric
                               / greatest(v_chalf, 0.01)) as w
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => v_days::int)
     group by e.blurb_id
    having bool_or(e.kind in ('like', 'open_detail', 'open_source')
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(v_llmax, greatest(v_llmin, coalesce(b.word_count, 0) * v_llpw))
                       and e.dwell_ms <= v_walk))
       and not bool_or(e.kind = 'dislike')
  ), co as materialized (
    select n.neighbor_id, sum(n.sim * s.w) as x
      from seeds s join core.collab_cards n on n.gen = p_gen and n.blurb_id = s.blurb_id
     group by n.neighbor_id
  ), mytopics as materialized (
    select k, max(w) as w from (
      select unnest(v_fol) as k, 1::numeric as w
      union all
      select t.key, least(t.value::numeric / greatest(v_capc, 0.01), 1)
        from jsonb_each_text(v_taste -> 'c') t where t.value::numeric > 0
    ) t group by k
  ), crowd as materialized (
    select c.topic_b as category, sum(m.w * c.lift) / sum(m.w) as lift
      from mytopics m join core.collab_topics c on c.gen = p_gen and c.topic_a = m.k and c.topic_b <> m.k
     group by c.topic_b
  ), crowd_all as materialized (
    select c.topic_b as category, c.lift from core.collab_topics c where c.gen = p_gen and c.topic_a = '*'
  ), srckey as materialized (
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from core.blurb_sources s
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), cand as materialized (
    select b.id, b.category, b.rank_score, b.sort_at, coalesce(b.event_type, b.kind) as typ,
           case when b.kind = 'data' then 'fred' else sk.key end as skey,
           b.headline, b.macro
      from core.blurbs b
      left join srckey sk on sk.blurb_id = b.id
     where b.status = 'published'
       and b.published_at <= p_asof
       and b.sort_at > p_asof - make_interval(days => v_window::int)
       and not (b.category = any (v_hid))
       and not exists (select 1 from core.user_events d
                        where d.user_id = p_user and d.blurb_id = b.id and d.kind = 'dislike')
  ), base as (
    select b.id, b.category,
           b.rank_score + coalesce(t.boost, 0)
             - greatest(extract(epoch from (p_asof - b.sort_at)) / 3600.0, 0)::numeric
               * (v_h / coalesce(hl.h, v_h) - 1)
             + v_scale * (
                 core.taste_hours(v_taste, b.category, b.typ, b.skey)
               + case when v_nev >= v_exmin and not (b.category = any (v_fol))
                           and not exists (select 1 from sig where sig.category = b.category)
                      then v_explore else 0 end
               + v_th * coalesce(cr.lift, ca.lift, 0) * (1 - coalesce((v_taste -> 'k' ->> b.category)::numeric, 0)))
             + coalesce(v_ch * co.x / (co.x + greatest(v_chalfs, 0.0001)), 0)
             - case when sh.was_read then v_seen
                    when sh.blurb_id is not null then v_seenv else 0 end as s0
      from cand b
      left join hl        on hl.category = b.category
      left join core.trend_boosts t on t.gen = p_gen and t.blurb_id = b.id
      left join co        on co.neighbor_id = b.id
      left join crowd cr  on cr.category = b.category
      left join crowd_all ca on ca.category = b.category
      left join shown sh  on sh.blurb_id = b.id
     where (cardinality(v_hsrc) = 0 or not (b.skey = any (v_hsrc)))
  ), w as materialized (
    select u.j, u.w from unnest(coalesce(v_fj, '{}'), coalesce(v_fw, '{}')) as u(j, w)
  ), v3 as (                                             -- only when the reader has evidence
    select c.id,
           round(greatest(least(case when v_hpr * sum(w.w) < 0 then v_hpr * sum(w.w) * v_neg
                                     else v_hpr * sum(w.w) end, v_cap), -v_cap)::numeric, 6) as h
      from cand c
      left join core.card_features cf on cf.blurb_id = c.id
      cross join lateral unnest(coalesce(cf.features,           -- precomputed; computed only if missing
                                         core.v2_features(c.category, c.typ, c.skey, c.headline, c.macro))) as u(j)
      join w on w.j = u.j
     where v_fj is not null
     group by c.id
  ), tot as (
    select x.id, x.category, x.s0, coalesce(v3.h, 0) as h, x.s0 + coalesce(v3.h, 0) as s
      from base x left join v3 on v3.id = x.id
  )
  select t.id, t.category, t.s0, t.h,
         round(t.s - v_step * (row_number() over (partition by t.category order by t.s desc, t.id desc) - 1), 6)
    from tot t;
end;
$$;

revoke all on function core.v3_scores(uuid, timestamptz, bigint) from public, anon, authenticated;


-- =============================================================================
-- F. core.feed_for_you_v7(cursor, limit): core.feed_for_you_v5's cursor (fields 1-6), carry, keyset and
--    core.diversify over core.v3_scores. Returns {items, next_cursor, terms} (terms = each returned card's
--    v3 hours, for the ml_pages log; the wrapper removes it). The as-of time is frozen in the cursor, so
--    the same cursor gives the same page even if the reader reacts mid-scroll.
-- =============================================================================

create or replace function core.feed_for_you_v7(p_cursor text, p_limit int)
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
  v_hid     text[];
  v_hsrc    text[];
  v_ids     uuid[];
  v_keys    text[];
  v_hall    jsonb;
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

  select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

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

  with s as materialized (
    select x.o_id, x.o_ps, x.o_v3 from core.v3_scores(v_uid, v_asof, v_gen) x
  ), pg as (
    select s.o_id, s.o_ps from s
     where (s.o_ps, s.o_id) < (v_key, v_id)
     order by s.o_ps desc, s.o_id desc
     limit v_fetch + 1
  )
  select (select array_agg(pg.o_id order by pg.o_ps desc, pg.o_id desc) from pg),
         (select array_agg(pg.o_ps::text order by pg.o_ps desc, pg.o_id desc) from pg),
         (select jsonb_object_agg(s.o_id::text, s.o_v3) from s
           where s.o_id in (select pg.o_id from pg) or s.o_id = any (v_carry))
    into v_ids, v_keys, v_hall;

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

  return jsonb_build_object('items', core.cards_json(v_out, v_uid), 'next_cursor', v_next,
                            'terms', to_jsonb(array(select coalesce((v_hall ->> u.id::text)::numeric, 0)
                                                      from unnest(v_out) with ordinality as u(id, o) order by u.o)));
end;
$$;

revoke all on function core.feed_for_you_v7(text, int) from public, anon, authenticated;


-- =============================================================================
-- G. api.feed_for_you (same signature and grants). Modes 0, 1 and 2: exactly 20261109000000's wrapper.
--   Mode 3, reader not in the v3 holdout: a new scroll is served by core.feed_for_you_v7 and logged as ranker
--   'fy-v3', ml_mode 3, ml_terms = the v3 hours. A v3 cursor (field 9 = 3) stays on v7 to the end of its
--   scroll whatever the mode is now (no repeats or gaps); a mode change applies from the next new scroll.
--   Holdout readers get v5, logged with holdout = true and ml_mode 3. Cost guard: more than
--   v3_max_candidates cards in the window, or any error or statement timeout in v7, serves v5 for that page.
-- =============================================================================

create or replace function api.feed_for_you(p_cursor text default null, p_limit int default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r      jsonb;
  v_uid    uuid := auth.uid();
  v_raw    numeric;
  v_mode   int;
  v_cmode  int;
  v_tmp    int;
  v_pno    int := 0;
  v_gen    bigint;
  v_asof   timestamptz;
  v_ids    uuid[];
  v_max    numeric;
  v_n      int;
  v_page   uuid;
  v_v6     boolean := false;
  v_v7     boolean := false;
  v_hold   boolean := false;
  v_hmode  int := 2;
  v_model  bigint;
  v_crun   bigint;
  v_seed   bigint;
  v_cseed  bigint;
  v_terms  jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  select coalesce(max(value), 0) into v_raw from core.rank_params where key = 'foryou_ml_mode';
  v_mode  := case when v_raw = 0 then 0 else 1 end;
  v_cmode := v_mode;
  if p_cursor is not null then                                           -- fields 7-10 (absent = old cursor)
    begin
      v_pno   := coalesce(nullif(split_part(p_cursor, '|', 8), '')::int, 0);
      v_tmp   := nullif(split_part(p_cursor, '|', 9), '')::int;
      v_cmode := case when v_tmp is null then v_mode when v_tmp = 0 then 0 else 1 end;
    exception when others then v_pno := 0; v_cmode := v_mode; v_tmp := null;
    end;
    if v_pno < 0 then v_pno := 0; end if;
    begin
      v_crun  := nullif(split_part(p_cursor, '|', 7), '')::bigint;
      v_cseed := nullif(split_part(p_cursor, '|', 10), '')::bigint;
    exception when others then v_crun := null; v_cseed := null;
    end;
  end if;

  -- a v6 or v7 cursor keeps its algorithm (and v6 its model and seed) to the end of its scroll
  if p_cursor is not null and v_tmp = 2 and v_crun is not null and v_cseed is not null
     and exists (select 1 from core.ml_models m where m.model_id = v_crun) then
    v_v6 := true; v_model := v_crun; v_seed := v_cseed;
  elsif p_cursor is not null and v_tmp = 3 then
    v_v7 := true;
  elsif p_cursor is null and v_raw = 2 then
    v_model := core.v2_active_model();
    if v_model is not null and core.v2_holdout(v_uid) then
      v_hold := true;
    elsif v_model is not null then
      v_v6 := true; v_seed := floor(random() * 2147483647)::bigint;
    end if;
  elsif p_cursor is null and v_raw = 3 then
    if 100 * (core.v2_uniforms(v_uid::text || '|v3holdout'))[1]
       < coalesce((select r.value from core.rank_params r where r.key = 'v3_holdout_pct'), 10)::double precision then
      v_hold := true; v_hmode := 3;
    else
      v_v7 := true;
    end if;
  elsif v_raw = 2 and core.v2_active_model() is not null and core.v2_holdout(v_uid) then
    v_hold := true;                                                      -- later pages of a holdout scroll
  elsif v_raw = 3 and 100 * (core.v2_uniforms(v_uid::text || '|v3holdout'))[1]
                      < coalesce((select r.value from core.rank_params r where r.key = 'v3_holdout_pct'), 10)::double precision then
    v_hold := true; v_hmode := 3;
  end if;

  if (v_v6 or v_v7) and (select count(*) from core.blurbs b
                          where b.status = 'published'
                            and b.sort_at > clock_timestamp() - make_interval(days => coalesce(
                                  (select r.value from core.rank_params r where r.key = 'for_you_window_days'), 30)::int))
                        > coalesce((select r.value from core.rank_params r
                                     where r.key = case when v_v7 then 'v3_max_candidates' else 'v2_max_candidates' end), 3000) then
    v_v6 := false; v_v7 := false;                                        -- cost guard: too many cards
  end if;
  if v_v6 then
    begin
      v_r := core.feed_for_you_v6(p_cursor, p_limit, v_model, v_seed);
    exception
      when query_canceled then v_v6 := false; v_r := null;              -- statement timeout
      when others then v_v6 := false; v_r := null;
    end;
  elsif v_v7 then
    begin
      v_r := core.feed_for_you_v7(p_cursor, p_limit);
      v_terms := v_r -> 'terms';
      v_r := v_r - 'terms';
    exception
      when query_canceled then v_v7 := false; v_r := null;              -- statement timeout
      when others then v_v7 := false; v_r := null;
    end;
  end if;

  if v_v6 then
    if v_r ->> 'next_cursor' is not null then
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '|' || v_model || '|' || (v_pno + 1) || '|2|' || v_seed));
    end if;
  elsif v_v7 then
    if v_r ->> 'next_cursor' is not null then
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '||' || (v_pno + 1) || '|3'));
    end if;
  else
    if v_tmp in (2, 3) then v_cmode := v_mode; end if;                   -- a v6/v7 cursor that fell back: current mode
    v_r := core.feed_for_you_v5(p_cursor, p_limit);
    if v_r ->> 'next_cursor' is not null then                            -- field 7 (ml_run) stays empty
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '||' || (v_pno + 1) || '|' || v_cmode));
    end if;
  end if;

  if v_mode = 0 or jsonb_array_length(v_r -> 'items') = 0 then
    return v_r;
  end if;
  begin
    select coalesce(max(value), 60) into v_max from core.rank_params where key = 'ml_pages_max_per_hour';
    select count(*) into v_n from core.ml_pages where user_id = v_uid and shown_at > now() - interval '1 hour';
    if v_n < v_max then
      begin
        v_asof := nullif(split_part(coalesce(v_r ->> 'next_cursor', p_cursor), '|', 4), '')::timestamptz;
        v_gen  := nullif(split_part(coalesce(v_r ->> 'next_cursor', p_cursor), '|', 3), '')::bigint;
      exception when others then v_asof := null; v_gen := null;
      end;
      v_asof := least(coalesce(v_asof, now()), clock_timestamp());
      if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
        select coalesce(max(gen), 0) into v_gen from core.trend_generations;
      end if;
      v_ids := array(select (x.c ->> 'id')::uuid from jsonb_array_elements(v_r -> 'items') with ordinality as x(c, o) order by x.o);
      insert into core.ml_pages (user_id, surface, ranker, ml_mode, ml_run, holdout, page_no, gen, as_of, prefs_at,
                                 card_ids, live_scores, ml_terms)
      values (v_uid, 'for_you', case when v_v6 then 'fy-ts-v6' when v_v7 then 'fy-v3' else 'fy-formula-v4' end,
              case when v_v6 then 2 when v_v7 then 3 when v_hold then v_hmode else v_mode end,
              case when v_v6 then v_model end, v_hold, v_pno, v_gen, v_asof,
              (select p.updated_at from core.user_prefs p where p.user_id = v_uid),
              v_ids,
              array(select coalesce(b.rank_score + coalesce(t.boost, 0), 0)
                      from unnest(v_ids) with ordinality as u(id, o)
                      left join core.blurbs b on b.id = u.id
                      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = u.id
                     order by u.o),
              case when v_v7 and jsonb_typeof(v_terms) = 'array' and jsonb_array_length(v_terms) = cardinality(v_ids)
                   then array(select x::numeric from jsonb_array_elements_text(v_terms) with ordinality as t(x, o) order by o) end)
      returning page_id into v_page;
    end if;
  exception when others then
    v_page := null;                                                      -- never break the feed
  end;
  if v_page is not null then v_r := v_r || jsonb_build_object('page_id', v_page); end if;
  return v_r;
end;
$$;

revoke all on function api.feed_for_you(text, int) from public, anon;
grant execute on function api.feed_for_you(text, int) to authenticated;


-- =============================================================================
-- I. Daily kill switch for mode 3 (service role; pg_cron where installed)
--   api.ml_v3_check(): over the last 3 days, dislikes within 1 hour of a For you page per card shown:
--   v3 pages (ranker fy-v3) vs mode-3 holdout pages. Both groups >= v3_kill_min_cards cards and v3 above
--   v3_kill_ratio x holdout: foryou_ml_mode goes from 3 to 0 (the formula).
--   returns {treat_cards, treat_rate, hold_cards, hold_rate, dropped}
--   api.ml_v2_check(): as before, but its holdout group is mode-2 holdout pages only.
-- =============================================================================

create or replace function core.ml_kill_counts(p_treat text, p_mode int)
returns table (tc bigint, td bigint, hc bigint, hd bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with pg as (
    select m.user_id, m.shown_at, m.card_ids, (m.ranker = p_treat) as treat
      from core.ml_pages m
     where m.surface = 'for_you' and m.shown_at > now() - interval '3 days'
       and (m.ranker = p_treat or (m.holdout and m.ml_mode = p_mode))
  ), shown as (
    select pg.treat, pg.user_id, pg.shown_at, u.id as blurb_id from pg cross join unnest(pg.card_ids) as u(id)
  )
  select count(*) filter (where s.treat),
         count(*) filter (where s.treat and d.hit),
         count(*) filter (where not s.treat),
         count(*) filter (where not s.treat and d.hit)
    from shown s
    cross join lateral (select exists (select 1 from core.user_events e
                                        where e.user_id = s.user_id and e.blurb_id = s.blurb_id and e.kind = 'dislike'
                                          and e.created_at between s.shown_at and s.shown_at + interval '1 hour') as hit) d;
$$;
revoke all on function core.ml_kill_counts(text, int) from public, anon, authenticated;

create or replace function api.ml_v3_check()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ratio numeric;
  v_min   numeric;
  v_tc    bigint; v_td bigint; v_hc bigint; v_hd bigint;
  v_drop  boolean := false;
begin
  select coalesce(max(value) filter (where key = 'v3_kill_ratio'), 1.2),
         coalesce(max(value) filter (where key = 'v3_kill_min_cards'), 500)
    into v_ratio, v_min from core.rank_params;
  select k.tc, k.td, k.hc, k.hd into v_tc, v_td, v_hc, v_hd from core.ml_kill_counts('fy-v3', 3) k;
  if v_tc >= v_min and v_hc >= v_min and v_hd::numeric / v_hc * v_ratio < v_td::numeric / v_tc then
    update core.rank_params set value = 0 where key = 'foryou_ml_mode' and value = 3;
    v_drop := found;
  end if;
  return jsonb_build_object('treat_cards', v_tc, 'treat_rate', case when v_tc > 0 then round(v_td::numeric / v_tc, 5) end,
                            'hold_cards', v_hc, 'hold_rate', case when v_hc > 0 then round(v_hd::numeric / v_hc, 5) end,
                            'dropped', v_drop);
end;
$$;

create or replace function api.ml_v2_check()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ratio numeric;
  v_min   numeric;
  v_tc    bigint; v_td bigint; v_hc bigint; v_hd bigint;
  v_drop  boolean := false;
  v_age   numeric;
begin
  select coalesce(max(value) filter (where key = 'v2_kill_ratio'), 1.2),
         coalesce(max(value) filter (where key = 'v2_kill_min_cards'), 500)
    into v_ratio, v_min from core.rank_params;
  select k.tc, k.td, k.hc, k.hd into v_tc, v_td, v_hc, v_hd from core.ml_kill_counts('fy-ts-v6', 2) k;
  if v_tc >= v_min and v_hc >= v_min and v_hd::numeric / v_hc * v_ratio < v_td::numeric / v_tc then
    update core.rank_params set value = 1 where key = 'foryou_ml_mode' and value = 2;
    v_drop := found;
  end if;
  select extract(epoch from (now() - max(m.created_at))) / 86400.0 into v_age from core.ml_models m;
  return jsonb_build_object('treat_cards', v_tc, 'treat_rate', case when v_tc > 0 then round(v_td::numeric / v_tc, 5) end,
                            'hold_cards', v_hc, 'hold_rate', case when v_hc > 0 then round(v_hd::numeric / v_hc, 5) end,
                            'dropped', v_drop,
                            'model_age_days', round(v_age, 2),
                            'stale', v_age is null or v_age > coalesce((select r.value from core.rank_params r where r.key = 'v2_model_stale_days'), 21));
end;
$$;

revoke all on function api.ml_v3_check() from public, anon, authenticated;
revoke all on function api.ml_v2_check() from public, anon, authenticated;
grant execute on function api.ml_v3_check() to service_role;
grant execute on function api.ml_v2_check() to service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job where jobname = 'element-ml-v3-check';
    perform cron.schedule('element-ml-v3-check', '23 6 * * *', 'select api.ml_v3_check()');
  else
    raise notice 'pg_cron not installed: element-ml-v3-check not scheduled (run api.ml_v3_check() daily by hand while mode 3 is on)';
  end if;
end
$cron$;

-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/ranking_v3_check.sql, ranking_v2_check.sql, ml_shadow_check.sql and every older check.
