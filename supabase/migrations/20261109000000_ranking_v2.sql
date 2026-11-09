-- =============================================================================
-- Element: ranking v2 for For you (Thompson sampling over card features) (2026-11-09)
--
-- Shipped OFF. Nothing a reader sees changes until BOTH hold:
--   * core.rank_params foryou_ml_mode = 2 (set by hand after Drew approves; ships at 0), and
--   * core.ml_models has a row with gate_passed = true (written by the weekly training job only when the
--     offline and real-data gates pass).
-- Otherwise api.feed_for_you serves core.feed_for_you_v5 exactly as before (modes 0 and 1 unchanged;
-- mode 2 without a passed model behaves like mode 1, as in 20261019010000_ml_shadow.sql).
-- api.feed (guest Trending / Latest) changes only when trending_ml_mode = 2 and a passed model exists
-- (ships at 0): then the Trending buzz uses a Bayesian average (section H).
--
-- The formula, in plain words: a card has a few features (topic c:, story type t:, source s:, tags g:
-- from core.tag_rules). For each feature a reader has a belief, an average reward mu and an uncertainty
-- sigma, built from the population prior (core.ml_weights) and the reader's own last 30 days of events.
-- Each scroll takes one random draw per feature (fixed by reader, feature and the scroll's seed, which
-- is frozen in the cursor) and adds the result, in hours, to rank_score:
--   n_j     = sum w x^2,   mu_j = (lambda_g mu0_j + sum w x r) / (lambda_g + n_j),   sigma_j = tau / sqrt(lambda_g + n_j)
--   theta_j = mu_j + v2_explore sigma_j z_j
--   score   = rank_score + clamp(v2_hours_per_reward sum_j x theta_j, +-v2_cap_hours) - seen penalty
--   then the topic step (+ cold step) and core.diversify, as in v5.
-- x = 1/sqrt(active features). r = like 1, detail .5, source .5, long look .25, quick skip -.15,
-- dislike -1 (the w_* rows, clipped -1 .. 1.5). w = 14-day fade x min(1/propensity(slot), 3).
-- A follow = v2_follow_pseudo (3) pseudo-rewards of v2_follow_reward (0.5) on its topic.
-- Lean: mu0 + v2_prior_lean (0.15) for tags with a v2_lean_tag_<tag> row <> 0 (rates, inflation, jobs,
-- growth, markets); a reader's own signals outweigh it after about lambda events.
--
-- Privacy: no new per-reader table. Beliefs are computed per request from the reader's own
-- core.user_events. core.ml_weights holds population averages only (no user ids; a feature row needs
-- v2_min_readers readers). delete_my_data / delete_account are unchanged and reset a reader to cold start.
--
--   A  tables core.tag_rules, core.ml_models, core.ml_weights (RLS on, no policies)
--   B  settings (core.rank_params, on conflict do nothing)
--   C  tag rule seed
--   D  helpers: core.v2_features, core.v2_uniforms, core.v2_normal, core.v2_holdout, core.v2_active_model,
--      core.v2_card_prior
--   E  core.v2_scores(user, as_of, model, seed): every candidate's score (a Python mirror is in ml/)
--   F  core.feed_for_you_v6: v5's paging and breadth rules over core.v2_scores
--   G  api.feed_for_you: same signature, grants and v5 output in modes 0/1; mode 2 switch with a 10%
--      holdout. Cursor (fields added at the end; old cursors work):
--        v5 pages  score|id|gen|as_of|state|carry||page_no|mode          (as before)
--        v6 pages  score|id|gen|as_of|state|carry|model|page_no|2|seed
--   H  core.refresh_trending: same as 20261017080000 plus the v2 Bayesian average when switched on
--   I  service-role RPCs: api.ml_export_cards, api.ml_v2_params, api.ml_write_weights, api.ml_v2_check
--
-- Idempotent. Run after 20261019060000_my_brief_subscriptions.sql. Check: supabase/tests/ranking_v2_check.sql
-- =============================================================================


-- =============================================================================
-- A. TABLES
-- =============================================================================

-- how cards get tags: a category or event type equal to pattern, a FRED series id on the card,
-- or a whole word / phrase in the headline (keyword patterns: lowercase letters, digits, single spaces)
create table if not exists core.tag_rules (
  id         bigint generated always as identity primary key,
  match_kind text not null check (match_kind in ('category', 'event_type', 'series', 'keyword')),
  pattern    text not null check (char_length(pattern) between 1 and 60),
  tag        text not null check (tag ~ '^[a-z0-9-]{1,30}$'),
  unique (match_kind, pattern, tag),
  constraint tag_rules_keyword_check check (match_kind <> 'keyword' or pattern ~ '^[a-z0-9]+( [a-z0-9]+)*$')
);

-- one row per weekly training run (written only by api.ml_write_weights)
create table if not exists core.ml_models (
  model_id    bigint generated always as identity primary key,
  version     text not null check (char_length(version) between 1 and 200),
  created_at  timestamptz not null default now(),
  n_readers   int not null default 0,
  n_events    int not null default 0,
  gate_passed boolean not null default false,       -- offline + real-data gates; the feed also needs mode 2
  gate        jsonb not null default '{}',
  report      jsonb not null default '{}'
);

-- population weights of one model: feature mu0 (n_readers >= v2_min_readers), group lambda,
-- global tau, slot propensity. No user ids. Fewer than 300 rows per model.
create table if not exists core.ml_weights (
  model_id  bigint not null references core.ml_models (model_id) on delete cascade,
  kind      text   not null check (kind in ('feature', 'group', 'global', 'slot')),
  key       text   not null check (char_length(key) between 1 and 100),
  value     double precision not null,
  n_readers int    not null default 0 check (n_readers >= 0),
  primary key (model_id, kind, key)
);

alter table core.tag_rules  enable row level security;
alter table core.ml_models  enable row level security;
alter table core.ml_weights enable row level security;
revoke all on table core.tag_rules, core.ml_models, core.ml_weights from public, anon, authenticated;


-- =============================================================================
-- B. SETTINGS (change with UPDATE core.rank_params; mirrored in ml/elementml/bandit/params.py)
-- =============================================================================

insert into core.rank_params (key, value) values
  ('v2_hours_per_reward',          12),    -- one unit of reward (one like) = 12 h of freshness
  ('v2_cap_hours',                 18),    -- personal term clamped to +-18 h
  ('v2_explore',                    1),    -- draw width (0 = no exploration: posterior mean only)
  ('v2_follow_pseudo',              3),    -- a follow = 3 pseudo-observations ...
  ('v2_follow_reward',            0.5),    -- ... of reward 0.5 on the followed topic
  ('v2_prior_lean',              0.15),    -- lean added to mu0 of the lean tags (0 = neutral)
  ('v2_min_readers',               20),    -- a trained feature weight needs this many readers
  ('v2_propensity_cap',             3),    -- 1/propensity(slot) capped at 3
  ('v2_holdout_pct',               10),    -- % of readers (id hash) kept on the formula while v2 is on
  ('v2_kill_ratio',               1.2),    -- api.ml_v2_check: back to mode 1 above this dislike ratio
  ('v2_kill_min_cards',           500),    -- ... only with at least this many cards shown in each group
  ('v2_lambda_default',             5),    -- prior strength when the model has no group value
  ('v2_tau_default',              0.5),    -- reward noise when the model has none
  ('v2_reader_weight_cap',         20),    -- training: one reader adds at most this weight to a population mean
  ('v2_trend_prior_n',             10),    -- Trending v2: prior strength m (readers)
  ('v2_trend_points_per_reward',    3),    -- Trending v2: one reward unit = 3 buzz points
  ('v2_lean_tag_rates',             1),
  ('v2_lean_tag_inflation',         1),
  ('v2_lean_tag_jobs',              1),
  ('v2_lean_tag_growth',            1),
  ('v2_lean_tag_markets',           1)
on conflict (key) do nothing;


-- =============================================================================
-- C. TAG RULES (same list as ml/elementml/bandit/features.py TAG_RULES; a test compares them)
-- =============================================================================

insert into core.tag_rules (match_kind, pattern, tag) values
  ('category', 'markets', 'markets'),
  ('category', 'economy', 'growth'),
  ('event_type', 'fed', 'rates'),
  ('series', 'DFF', 'rates'), ('series', 'DGS10', 'rates'), ('series', 'DGS2', 'rates'),
  ('series', 'CPIAUCSL', 'inflation'),
  ('series', 'UNRATE', 'jobs'), ('series', 'PAYEMS', 'jobs'), ('series', 'ICSA', 'jobs'),
  ('series', 'A191RL1Q225SBEA', 'growth'), ('series', 'RSAFS', 'growth'),
  ('series', 'HOUST', 'housing'),
  ('series', 'DCOILWTICO', 'energy'), ('series', 'GASREGW', 'energy'),
  ('keyword', 'interest rate', 'rates'), ('keyword', 'interest rates', 'rates'), ('keyword', 'rates', 'rates'),
  ('keyword', 'rate cut', 'rates'), ('keyword', 'rate hike', 'rates'), ('keyword', 'fed', 'rates'),
  ('keyword', 'fomc', 'rates'), ('keyword', 'federal reserve', 'rates'), ('keyword', 'treasury', 'rates'),
  ('keyword', 'yield', 'rates'), ('keyword', 'yields', 'rates'), ('keyword', 'bond', 'rates'),
  ('keyword', 'bonds', 'rates'),
  ('keyword', 'inflation', 'inflation'), ('keyword', 'cpi', 'inflation'), ('keyword', 'consumer prices', 'inflation'),
  ('keyword', 'jobs', 'jobs'), ('keyword', 'payrolls', 'jobs'), ('keyword', 'unemployment', 'jobs'),
  ('keyword', 'jobless', 'jobs'), ('keyword', 'hiring', 'jobs'), ('keyword', 'layoffs', 'jobs'),
  ('keyword', 'wages', 'jobs'),
  ('keyword', 'gdp', 'growth'), ('keyword', 'recession', 'growth'), ('keyword', 'retail sales', 'growth'),
  ('keyword', 'stocks', 'markets'), ('keyword', 'stock market', 'markets'), ('keyword', 'dow', 'markets'),
  ('keyword', 'nasdaq', 'markets'), ('keyword', 'wall street', 'markets'), ('keyword', 'selloff', 'markets'),
  ('keyword', 'oil', 'energy'), ('keyword', 'crude', 'energy'), ('keyword', 'opec', 'energy'),
  ('keyword', 'gasoline', 'energy'),
  ('keyword', 'ai', 'ai'), ('keyword', 'chips', 'ai'), ('keyword', 'gpu', 'ai'),
  ('keyword', 'bitcoin', 'crypto'), ('keyword', 'crypto', 'crypto'),
  ('keyword', 'housing', 'housing'), ('keyword', 'mortgage', 'housing'), ('keyword', 'home sales', 'housing'),
  ('keyword', 'recall', 'recalls'), ('keyword', 'recalls', 'recalls'),
  ('keyword', 'earthquake', 'disaster'), ('keyword', 'hurricane', 'disaster'), ('keyword', 'wildfire', 'disaster'),
  ('keyword', 'flood', 'disaster'),
  ('keyword', 'nasa', 'space'), ('keyword', 'rocket', 'space'), ('keyword', 'telescope', 'space')
on conflict (match_kind, pattern, tag) do nothing;


-- =============================================================================
-- D. HELPERS (private)
-- =============================================================================

-- sorted distinct features of one card: c:<category>, t:<type>, s:<source key>, g:<tag>
create or replace function core.v2_features(p_category text, p_typ text, p_skey text, p_headline text, p_macro jsonb)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.f order by x.f), '{}') from (
    select 'c:' || p_category as f where p_category is not null
    union all select 't:' || p_typ  where p_typ  is not null
    union all select 's:' || p_skey where p_skey is not null
    union all
    select 'g:' || r.tag
      from core.tag_rules r
     where (r.match_kind = 'category'   and r.pattern = p_category)
        or (r.match_kind = 'event_type' and r.pattern = p_typ)
        or (r.match_kind = 'series' and exists (
              select 1 from jsonb_array_elements(case when jsonb_typeof(p_macro) = 'array' then p_macro else '[]'::jsonb end) m
               where upper(m ->> 'series_id') = upper(r.pattern)))
        or (r.match_kind = 'keyword' and coalesce(p_headline, '') ~* ('\m' || r.pattern || '\M'))
  ) x;
$$;

-- two uniforms in (0, 1) from md5(text): hex digits 1-8 and 9-16 (Python: bandit.policy.md5_uniforms)
create or replace function core.v2_uniforms(p_text text)
returns double precision[]
language sql
immutable
set search_path = ''
as $$
  select array[((('x' || lpad(substr(s.h, 1, 8), 16, '0'))::bit(64)::bigint + 0.5) / 4294967296.0)::double precision,
               ((('x' || lpad(substr(s.h, 9, 8), 16, '0'))::bit(64)::bigint + 0.5) / 4294967296.0)::double precision]
    from (select md5(p_text) as h) s;
$$;

-- Box-Muller normal fixed by (reader, feature, seed) (Python: bandit.policy.normal_draw)
create or replace function core.v2_normal(p_user uuid, p_feature text, p_seed bigint)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select sqrt(-2 * ln(u[1])) * cos(2 * pi() * u[2])
    from (select core.v2_uniforms(p_user::text || '|' || p_feature || '|' || p_seed::text) as u) s;
$$;

-- true for the v2_holdout_pct % of readers who keep the formula while v2 is on (stable per reader)
create or replace function core.v2_holdout(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select 100 * (core.v2_uniforms(p_user::text || '|v2holdout'))[1]
         < coalesce((select r.value from core.rank_params r where r.key = 'v2_holdout_pct'), 10)::double precision;
$$;

-- the newest model that passed the gate (null = none; then v2 never runs)
create or replace function core.v2_active_model()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$ select max(m.model_id) from core.ml_models m where m.gate_passed; $$;

-- a card's prior reward sum_j x (mu0_j + lean) under a model (Trending v2)
create or replace function core.v2_card_prior(p_blurb uuid, p_model bigint)
returns double precision
language sql
stable
security definer
set search_path = ''
as $$
  with f as (
    select core.v2_features(b.category, coalesce(b.event_type, b.kind),
                            case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end,
                            b.headline, b.macro) as f
      from core.blurbs b where b.id = p_blurb
  ), lean as (
    select substr(r.key, length('v2_lean_tag_') + 1) as tag from core.rank_params r
     where r.key like 'v2\_lean\_tag\_%' and r.value <> 0
  )
  select coalesce(sum((coalesce(w.value, 0)
                       + case when split_part(u.j, ':', 1) = 'g' and substr(u.j, 3) in (select lean.tag from lean)
                              then coalesce((select r.value from core.rank_params r where r.key = 'v2_prior_lean'), 0.15)::double precision
                              else 0 end) / sqrt(cardinality(f.f)::double precision)), 0)
    from f cross join unnest(f.f) as u(j)
    left join core.ml_weights w on w.model_id = p_model and w.kind = 'feature' and w.key = u.j;
$$;

revoke all on function core.v2_features(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function core.v2_uniforms(text)                         from public, anon, authenticated;
revoke all on function core.v2_normal(uuid, text, bigint)              from public, anon, authenticated;
revoke all on function core.v2_holdout(uuid)                           from public, anon, authenticated;
revoke all on function core.v2_active_model()                          from public, anon, authenticated;
revoke all on function core.v2_card_prior(uuid, bigint)                from public, anon, authenticated;


-- =============================================================================
-- E. core.v2_scores(user, as_of, model, seed): one row per candidate card
--   o_s0     = rank_score + o_bandit - seen penalty
--   o_bandit = the personal term in hours (rounded to 6 places)
--   o_ps     = o_s0 - step x (better cards of the same topic), rounded to 6 places (the page key)
-- Candidates are v5's: published by as_of, sort_at in the For you window, topic and source not hidden,
-- not disliked. Mirror: ml/elementml/bandit/policy.py score_reference (parity test in ml/tests).
-- =============================================================================

create or replace function core.v2_scores(p_user uuid, p_asof timestamptz, p_model bigint, p_seed bigint)
returns table (o_id uuid, o_category text, o_s0 numeric, o_bandit numeric, o_ps numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fol  text[];
  v_hid  text[];
  v_hsrc text[];
  v_nev  int;
  v_step numeric;
  p      record;
begin
  select u.followed_categories, u.hidden_categories, u.hidden_sources into v_fol, v_hid, v_hsrc
    from core.user_prefs u where u.user_id = p_user;
  v_fol  := coalesce(v_fol, '{}');
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  select coalesce(max(value) filter (where key = 'for_you_window_days'), 30)        as win,
         coalesce(max(value) filter (where key = 'affinity_days'), 30)              as days,
         coalesce(max(value) filter (where key = 'signal_half_life_days'), 14)::double precision as half,
         coalesce(max(value) filter (where key = 'seen_penalty_hours'), 100)        as seen,
         coalesce(max(value) filter (where key = 'seen_view_penalty_hours'), 24)    as seenv,
         coalesce(max(value) filter (where key = 'foryou_category_step_hours'), 0.75) as step,
         coalesce(max(value) filter (where key = 'foryou_cold_step_hours'), 4)      as cold,
         coalesce(max(value) filter (where key = 'foryou_cold_events'), 5)          as coldn,
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
         coalesce(max(value) filter (where key = 'dwell_ms_per_word'), 150)         as llpw,
         coalesce(max(value) filter (where key = 'v2_hours_per_reward'), 12)::double precision as hpr,
         coalesce(max(value) filter (where key = 'v2_cap_hours'), 18)::double precision        as cap,
         coalesce(max(value) filter (where key = 'v2_explore'), 1)::double precision           as explore,
         coalesce(max(value) filter (where key = 'v2_follow_pseudo'), 3)::double precision     as fpseudo,
         coalesce(max(value) filter (where key = 'v2_follow_reward'), 0.5)::double precision   as freward,
         coalesce(max(value) filter (where key = 'v2_prior_lean'), 0.15)::double precision     as lean,
         coalesce(max(value) filter (where key = 'v2_propensity_cap'), 3)::double precision    as pcap,
         coalesce(max(value) filter (where key = 'v2_lambda_default'), 5)::double precision    as lamd,
         coalesce(max(value) filter (where key = 'v2_tau_default'), 0.5)::double precision     as taud
    into p
    from core.rank_params;

  select count(*) into v_nev from core.user_events e
   where e.user_id = p_user and e.created_at < p_asof
     and e.created_at > p_asof - make_interval(days => p.days::int);
  v_step := p.step;
  if cardinality(v_fol) = 0 then                         -- cold start: v5's extra topic spread
    v_step := v_step + greatest(p.cold, 0) * greatest(1 - v_nev::numeric / greatest(p.coldn, 1), 0);
  end if;

  return query
  with mw as materialized (
    select w.kind, w.key, w.value from core.ml_weights w where w.model_id = p_model
  ), lean as materialized (
    select substr(r.key, length('v2_lean_tag_') + 1) as tag
      from core.rank_params r where r.key like 'v2\_lean\_tag\_%' and r.value <> 0
  ), ev as materialized (                                 -- the reader's cards in the last affinity_days
    select e.blurb_id,
           bool_or(e.kind = 'like')        as liked,
           bool_or(e.kind = 'dislike')     as disliked,
           bool_or(e.kind = 'open_detail') as detail,
           bool_or(e.kind = 'open_source') as src,
           bool_or(e.kind = 'view')        as viewed,
           max(e.dwell_ms) filter (where e.dwell_ms <= p.walk) as max_dwell,
           max(e.created_at)               as last_at,
           min(e.slot) filter (where e.kind = 'view') as slot
      from core.user_events e
     where e.user_id = p_user and e.created_at < p_asof
       and e.created_at > p_asof - make_interval(days => p.days::int)
     group by e.blurb_id
  ), srckey as materialized (                             -- = core.source_key_of for all cards at once
    select distinct on (s.blurb_id) s.blurb_id, k.key
      from core.blurb_sources s
      join core.source_keys k on s.name = any (k.match_names)
     order by s.blurb_id, s.is_primary desc, s.position, s.id
  ), allc as materialized (                               -- candidates plus the reader's event cards
    select b.id, b.category, b.rank_score, b.status, b.published_at, b.sort_at, b.word_count,
           case when b.kind = 'data' then 'fred' else sk.key end as skey,
           core.v2_features(b.category, coalesce(b.event_type, b.kind),
                            case when b.kind = 'data' then 'fred' else sk.key end, b.headline, b.macro) as f
      from core.blurbs b
      left join srckey sk on sk.blurb_id = b.id
     where (b.status = 'published' and b.published_at <= p_asof
            and b.sort_at > p_asof - make_interval(days => p.win::int))
        or b.id in (select ev.blurb_id from ev)
  ), rw as (                                              -- one evidence row per card: weight and reward
    select a.f, 1 / sqrt(cardinality(a.f)::double precision) as x,
           power(0.5::double precision, (extract(epoch from (p_asof - ev.last_at)) / 86400.0)::double precision / greatest(p.half, 0.01))
             * least(1 / greatest(coalesce(sl.value, 1), 1e-9), p.pcap) as w,
           greatest(least(
               p.w_like * ev.liked::int + p.w_dislike * ev.disliked::int + p.w_detail * ev.detail::int
             + p.w_source * ev.src::int + p.w_view * ev.viewed::int
             + case when ev.max_dwell >= least(p.llmax, greatest(p.llmin, coalesce(a.word_count, 0) * p.llpw))
                    then p.w_long else 0 end
             + case when ev.max_dwell <= p.skip_ms and not (ev.liked or ev.detail or ev.src)
                    then p.w_skip else 0 end,
             p.cpos), p.cneg) as r
      from ev
      join allc a on a.id = ev.blurb_id
      left join mw sl on sl.kind = 'slot' and sl.key = least(ev.slot, 20)::text
     where cardinality(a.f) > 0
  ), st as (                                              -- the reader's evidence per feature (+ follows)
    select u.j, sum(u.n) as n, sum(u.sxr) as sxr from (
      select f1.j, rw.w * rw.x * rw.x as n, rw.w * rw.x * rw.r as sxr from rw cross join unnest(rw.f) as f1(j)
      union all
      select 'c:' || fc, p.fpseudo, p.fpseudo * p.freward from (select distinct unnest(v_fol) as fc) fl
    ) u group by u.j
  ), cand as materialized (
    select a.* from allc a
     where a.status = 'published' and a.published_at <= p_asof
       and a.sort_at > p_asof - make_interval(days => p.win::int)
       and not (a.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (a.skey = any (v_hsrc)))
       and not exists (select 1 from core.user_events d
                        where d.user_id = p_user and d.blurb_id = a.id and d.kind = 'dislike')
  ), th as (                                              -- one Thompson draw per feature
    select q.j,
           (q.lam * q.mu0 + q.sxr) / (q.lam + q.n)
           + p.explore * coalesce((select g.value from mw g where g.kind = 'global' and g.key = 'tau'), p.taud)
             / sqrt(q.lam + q.n) * core.v2_normal(p_user, q.j, p_seed) as theta
      from (
        select t.j,
               coalesce(fw.value, 0)
                 + case when split_part(t.j, ':', 1) = 'g' and substr(t.j, 3) in (select lean.tag from lean)
                        then p.lean else 0 end as mu0,
               coalesce(gw.value, p.lamd) as lam,
               coalesce(st.n, 0) as n, coalesce(st.sxr, 0) as sxr
          from (select distinct unnest(c.f) as j from cand c) t
          left join mw fw on fw.kind = 'feature' and fw.key = t.j
          left join mw gw on gw.kind = 'group'   and gw.key = split_part(t.j, ':', 1)
          left join st    on st.j = t.j
      ) q
  ), bh as (
    select c.id, round(greatest(least(p.hpr * sum(th.theta / sqrt(cardinality(c.f)::double precision)), p.cap), -p.cap)::numeric, 6) as b
      from cand c cross join unnest(c.f) as u(j) join th on th.j = u.j
     group by c.id
  ), shown as materialized (                              -- seen penalty: v5's rule, all time before as of
    select e.blurb_id,
           bool_or(e.kind = 'open_detail'
                   or (e.kind = 'dwell'
                       and e.dwell_ms >= least(p.llmax, greatest(p.llmin, coalesce(b.word_count, 0) * p.llpw)))) as was_read
      from core.user_events e join core.blurbs b on b.id = e.blurb_id
     where e.user_id = p_user and e.created_at < p_asof
       and e.kind in ('view', 'dwell', 'open_detail', 'open_source')
     group by e.blurb_id
  ), base as (
    select c.id, c.category, coalesce(bh.b, 0) as b,
           c.rank_score + coalesce(bh.b, 0)
             - case when sh.was_read then p.seen when sh.blurb_id is not null then p.seenv else 0 end as s0
      from cand c
      left join bh on bh.id = c.id
      left join shown sh on sh.blurb_id = c.id
  )
  select x.id, x.category, x.s0, x.b,
         round(x.s0 - v_step * (row_number() over (partition by x.category order by x.s0 desc, x.id desc) - 1), 6)
    from base x;
end;
$$;

revoke all on function core.v2_scores(uuid, timestamptz, bigint, bigint) from public, anon, authenticated;


-- =============================================================================
-- F. core.feed_for_you_v6(cursor, limit, model, seed): v5's cursor (fields 1-6), carry, keyset and
--    core.diversify, over core.v2_scores. Returns {items, next_cursor} like v5 (6-field cursor; the
--    wrapper adds model|page_no|2|seed). Stable: the seed comes in, so the same cursor = the same page.
-- =============================================================================

create or replace function core.feed_for_you_v6(p_cursor text, p_limit int, p_model bigint, p_seed bigint)
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

  select array_agg(s.o_id order by s.o_ps desc, s.o_id desc),
         array_agg(s.o_ps::text order by s.o_ps desc, s.o_id desc)
    into v_ids, v_keys
    from (
      select x.o_id, x.o_ps from core.v2_scores(v_uid, v_asof, p_model, p_seed) x
       where (x.o_ps, x.o_id) < (v_key, v_id)
       order by x.o_ps desc, x.o_id desc
       limit v_fetch + 1
    ) s;

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

revoke all on function core.feed_for_you_v6(text, int, bigint, bigint) from public, anon, authenticated;


-- =============================================================================
-- G. api.feed_for_you (same signature and grants). Modes 0 and 1: exactly 20261019010000's wrapper.
--   Mode 2 + a passed model + reader not in the holdout: a new scroll gets a random seed and the newest
--   passed model; its pages are served by core.feed_for_you_v6 and logged as ranker 'fy-ts-v6',
--   ml_mode 2, ml_run = model id. A v6 cursor keeps its model and seed while the mode stays 2 (if the mode
--   is switched off mid-scroll, the next page comes from the formula). Holdout readers get v5, logged
--   with holdout = true and ml_mode 2. Mode 2 without a passed model: exactly like mode 1.
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
  v_hold   boolean := false;
  v_model  bigint;
  v_crun   bigint;
  v_seed   bigint;
  v_cseed  bigint;
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

  if v_raw = 2 then
    v_model := core.v2_active_model();
    if v_model is not null and core.v2_holdout(v_uid) then
      v_hold := true;
    elsif p_cursor is null and v_model is not null then
      v_v6 := true; v_seed := floor(random() * 2147483647)::bigint;
    elsif p_cursor is not null and v_tmp = 2 and v_crun is not null and v_cseed is not null
          and exists (select 1 from core.ml_models m where m.model_id = v_crun and m.gate_passed) then
      v_v6 := true; v_model := v_crun; v_seed := v_cseed;
    end if;
  end if;

  if v_v6 then
    v_r := core.feed_for_you_v6(p_cursor, p_limit, v_model, v_seed);
    if v_r ->> 'next_cursor' is not null then
      v_r := jsonb_set(v_r, '{next_cursor}', to_jsonb((v_r ->> 'next_cursor') || '|' || v_model || '|' || (v_pno + 1) || '|2|' || v_seed));
    end if;
  else
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
      insert into core.ml_pages (user_id, surface, ranker, ml_mode, ml_run, holdout, page_no, gen, as_of, prefs_at, card_ids, live_scores)
      values (v_uid, 'for_you', case when v_v6 then 'fy-ts-v6' else 'fy-formula-v4' end,
              case when v_v6 or v_hold then 2 else v_mode end,
              case when v_v6 then v_model end, v_hold, v_pno, v_gen, v_asof,
              (select p.updated_at from core.user_prefs p where p.user_id = v_uid),
              v_ids,
              array(select coalesce(b.rank_score + coalesce(t.boost, 0), 0)
                      from unnest(v_ids) with ordinality as u(id, o)
                      left join core.blurbs b on b.id = u.id
                      left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = u.id
                     order by u.o))
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
-- H. core.refresh_trending = 20261017080000 section D, plus (only when trending_ml_mode = 2 and a
--    passed model exists) the Bayesian average of the buzz points:
--      pts' = n x (pts + m x p0) / (n + m),   p0 = v2_trend_points_per_reward x the card's prior reward
--    n = distinct readers, m = v2_trend_prior_n. Two lucky likes (pts 6, n 2) give 1.5 points instead of
--    6, while 20 readers keep about 3/4 of theirs. Every other value and path is unchanged.
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
  v_tm   bigint;
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
         coalesce(max(value) filter (where key = 'collab_quality_hours'),   2)   as qh,
         coalesce(max(value) filter (where key = 'trending_ml_mode'),       0)   as tmode,
         coalesce(max(value) filter (where key = 'v2_trend_prior_n'),       10)  as tm,
         coalesce(max(value) filter (where key = 'v2_trend_points_per_reward'), 3) as tppr
    into p
    from core.rank_params;
  v_tm := case when p.tmode = 2 then core.v2_active_model() end;         -- null = the formula as before

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
          select y.blurb_id,
                 case when v_tm is null then y.pts
                      else (y.nu * (y.pts + p.tm * p.tppr * core.v2_card_prior(y.blurb_id, v_tm)::numeric) / (y.nu + p.tm))::numeric
                 end as pts
            from (
              select e.blurb_id,
                       p.w_like    * count(distinct e.user_id) filter (where e.kind = 'like')
                     + p.w_detail  * count(distinct e.user_id) filter (where e.kind = 'open_detail')
                     + p.w_source  * count(distinct e.user_id) filter (where e.kind = 'open_source')
                     + p.w_long    * count(distinct e.user_id) filter (where e.kind = 'dwell'
                                         and e.dwell_ms >= core.long_look_ms(b.word_count)
                                         and e.dwell_ms <= p.walk)
                     + p.w_view    * count(distinct e.user_id) filter (where e.kind = 'view')
                     - p.w_dislike * count(distinct e.user_id) filter (where e.kind = 'dislike') as pts,
                     count(distinct e.user_id) as nu
                from core.user_events e
                join core.blurbs b on b.id = e.blurb_id and b.status = 'published'
               where e.created_at > now() - make_interval(hours => p.win::int)
               group by e.blurb_id
              having count(distinct e.user_id) >= p.minu
            ) y
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
-- I. SERVICE-ROLE RPCs for the weekly training job (no email, no text a reader wrote)
-- =============================================================================

-- I1. api.ml_export_cards(since, next, limit): cards with sort_at >= since, keyset (sort_at, id),
--     at most 5000 per call: {rows: [{id, category, typ, skey, features, word_count, rank_score,
--     sort_at, published_at}], next}
create or replace function api.ml_export_cards(p_since timestamptz, p_next text default null, p_limit int default 5000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
  v_ts   timestamptz := '-infinity';
  v_id   uuid := '00000000-0000-0000-0000-000000000000';
  v_rows jsonb;
  v_n    int;
  v_next text;
begin
  if p_since is null then raise exception 'invalid_since' using errcode = 'PT422'; end if;
  if p_next is not null then
    begin
      v_ts := split_part(p_next, '|', 1)::timestamptz;
      v_id := split_part(p_next, '|', 2)::uuid;
    exception when others then raise exception 'invalid_next' using errcode = 'PT422';
    end;
  end if;
  with page as (
    select b.id, b.category, coalesce(b.event_type, b.kind) as typ,
           case when b.kind = 'data' then 'fred' else core.source_key_of(b.kind, b.id) end as skey,
           b.word_count, b.rank_score, b.sort_at, b.published_at, b.headline, b.macro
      from core.blurbs b
     where b.sort_at >= p_since and (b.sort_at, b.id) > (v_ts, v_id)
     order by b.sort_at, b.id
     limit v_lim + 1
  ), numbered as (
    select page.*, row_number() over (order by page.sort_at, page.id) as rn from page
  )
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', n.id, 'category', n.category, 'typ', n.typ, 'skey', n.skey,
             'features', to_jsonb(core.v2_features(n.category, n.typ, n.skey, n.headline, n.macro)),
             'word_count', n.word_count, 'rank_score', n.rank_score,
             'sort_at', to_char(n.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'published_at', to_char(n.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
           order by n.sort_at, n.id) filter (where n.rn <= v_lim), '[]'),
         count(*),
         max(to_char(n.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || n.id) filter (where n.rn = v_lim)
    into v_rows, v_n, v_next
    from numbered n;
  return jsonb_build_object('rows', v_rows, 'next', case when v_n > v_lim then v_next end);
end;
$$;

-- I2. api.ml_v2_params(): every core.rank_params row as {key: value} (settings only)
create or replace function api.ml_v2_params()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(jsonb_object_agg(r.key, r.value), '{}'::jsonb) from core.rank_params r; $$;

-- I3. api.ml_write_weights(p_model, p_rows): one new core.ml_models row and its weights, atomically.
--   p_model {version, n_readers, n_events, gate_passed, gate, report}; p_rows [{kind, key, value, n_readers}]
--   (at most 300). Rows out of range are skipped: feature value -1.5 .. 1.5 with n_readers >= v2_min_readers;
--   group key c/t/s/g value 0.1 .. 1000; global key tau value 0.01 .. 5; slot key 0..20 value (0, 1].
--   returns {model_id, written, skipped}
create or replace function api.ml_write_weights(p_model jsonb, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_total int;
  v_w     int;
  v_id    bigint;
  v_minr  numeric;
begin
  if p_model is null or jsonb_typeof(p_model) <> 'object' then raise exception 'invalid_model' using errcode = 'PT422'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows' using errcode = 'PT422'; end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 300 then raise exception 'too_many_rows' using errcode = 'PT422'; end if;
  if coalesce(length(p_model ->> 'version'), 0) not between 1 and 200 then
    raise exception 'invalid_version' using errcode = 'PT422';
  end if;
  select coalesce(max(value), 20) into v_minr from core.rank_params where key = 'v2_min_readers';

  insert into core.ml_models (version, n_readers, n_events, gate_passed, gate, report)
  values (p_model ->> 'version',
          greatest(coalesce((p_model ->> 'n_readers')::int, 0), 0),
          greatest(coalesce((p_model ->> 'n_events')::int, 0), 0),
          coalesce((p_model ->> 'gate_passed')::boolean, false),
          coalesce(case when jsonb_typeof(p_model -> 'gate') = 'object' then p_model -> 'gate' end, '{}'),
          coalesce(case when jsonb_typeof(p_model -> 'report') = 'object' then p_model -> 'report' end, '{}'))
  returning model_id into v_id;

  insert into core.ml_weights (model_id, kind, key, value, n_readers)
  select v_id, x.kind, x.key, x.value, coalesce(x.n_readers, 0)
    from jsonb_to_recordset(p_rows) as x(kind text, key text, value double precision, n_readers int)
   where x.key is not null and char_length(x.key) between 1 and 100
     and x.value is not null and x.value <> 'NaN'::double precision
     and case x.kind
           when 'feature' then x.key ~ '^[ctsg]:' and coalesce(x.n_readers, 0) >= v_minr and x.value between -1.5 and 1.5
           when 'group'   then x.key in ('c', 't', 's', 'g') and x.value between 0.1 and 1000
           when 'global'  then x.key = 'tau' and x.value between 0.01 and 5
           when 'slot'    then x.key = any (array(select g::text from generate_series(0, 20) g)) and x.value > 0 and x.value <= 1
           else false end
  on conflict (model_id, kind, key) do nothing;
  get diagnostics v_w = row_count;
  return jsonb_build_object('model_id', v_id, 'written', v_w, 'skipped', v_total - v_w);
end;
$$;

-- I4. api.ml_v2_check(): the daily kill switch. Over the last 3 days, dislikes within 1 hour of a
--   For you page per card shown: treatment pages (ranker fy-ts-v6) vs holdout pages. If both groups
--   showed >= v2_kill_min_cards cards and treatment > v2_kill_ratio x holdout, foryou_ml_mode goes
--   from 2 to 1. returns {treat_cards, treat_rate, hold_cards, hold_rate, dropped}
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
begin
  select coalesce(max(value) filter (where key = 'v2_kill_ratio'), 1.2),
         coalesce(max(value) filter (where key = 'v2_kill_min_cards'), 500)
    into v_ratio, v_min from core.rank_params;
  with pg as (
    select m.page_id, m.user_id, m.shown_at, m.card_ids, (m.ranker = 'fy-ts-v6') as treat
      from core.ml_pages m
     where m.surface = 'for_you' and m.shown_at > now() - interval '3 days'
       and (m.ranker = 'fy-ts-v6' or m.holdout)
  ), shown as (
    select pg.treat, pg.user_id, pg.shown_at, u.id as blurb_id from pg cross join unnest(pg.card_ids) as u(id)
  )
  select count(*) filter (where s.treat),
         count(*) filter (where s.treat and d.hit),
         count(*) filter (where not s.treat),
         count(*) filter (where not s.treat and d.hit)
    into v_tc, v_td, v_hc, v_hd
    from shown s
    cross join lateral (select exists (select 1 from core.user_events e
                                        where e.user_id = s.user_id and e.blurb_id = s.blurb_id and e.kind = 'dislike'
                                          and e.created_at between s.shown_at and s.shown_at + interval '1 hour') as hit) d;
  if v_tc >= v_min and v_hc >= v_min and v_hd::numeric / v_hc * v_ratio < v_td::numeric / v_tc then
    update core.rank_params set value = 1 where key = 'foryou_ml_mode' and value = 2;
    v_drop := found;
  end if;
  return jsonb_build_object('treat_cards', v_tc, 'treat_rate', case when v_tc > 0 then round(v_td::numeric / v_tc, 5) end,
                            'hold_cards', v_hc, 'hold_rate', case when v_hc > 0 then round(v_hd::numeric / v_hc, 5) end,
                            'dropped', v_drop);
end;
$$;

revoke all on function api.ml_export_cards(timestamptz, text, int) from public, anon, authenticated;
revoke all on function api.ml_v2_params()                          from public, anon, authenticated;
revoke all on function api.ml_write_weights(jsonb, jsonb)          from public, anon, authenticated;
revoke all on function api.ml_v2_check()                           from public, anon, authenticated;
grant execute on function api.ml_export_cards(timestamptz, text, int) to service_role;
grant execute on function api.ml_v2_params()                          to service_role;
grant execute on function api.ml_write_weights(jsonb, jsonb)          to service_role;
grant execute on function api.ml_v2_check()                           to service_role;

-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/ranking_v2_check.sql, ml_shadow_check.sql and every older check (they must still pass).
