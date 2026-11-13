-- =============================================================================
-- 20261211000000_ml_serve_hours.sql: serving path for the vector + LightGBM ranker (SHIPS OFF)
--
-- What it adds
--   core.ml_serve_hours        per-reader per-card "hours" written by the offline job (python -m elementml.cli serve-run).
--                              Positive = the model expects this reader to like the card more than the formula does.
--   core.ml_serve_active(uid)  true only for readers in the rollout share and outside the ML holdout (hash of the user id).
--   core.v3_scores             renamed to core.v3_scores_base; a thin wrapper of the same name and signature adds the
--                              reader's hours to o_ps (the paging key) and to o_v3 (the residual hours). Nothing else in
--                              the For you code changes: api.feed_for_you, v7_base, fy_post and the cursor are untouched.
--   api.ml_write_serve_hours   service role only: writes one batch (chunks allowed), keeps the two newest batches per reader.
--   api.ml_serve_status        service role only: counts for monitoring.
--
-- Switches (core.rank_params, all in context/settings.md; ship OFF)
--   ml_serve_pct          0   share of readers (0-100) that get the model's hours. 0 = off for everyone (the KILL SWITCH).
--   ml_serve_holdout_pct 20   share of readers (0-100) that never get them, even when ml_serve_pct is 100 (the control arm).
--   ml_serve_cap_h        6   largest hours the model may add or subtract for one card (the formula's own cap is 30).
--   ml_serve_min_events   5   explicit events (like, dislike, open_detail, open_source) a reader needs first.
--   ml_serve_max_age_h   24   a batch older than this is ignored (the reader falls back to plain v3).
--
-- Safety
--   - Works only while foryou_ml_mode = 3 (the v3 path is the only caller of core.v3_scores). Mode 0, 1, 2 are unchanged.
--   - Paging stays consistent: a scroll uses the newest batch written at or before its frozen as-of time, and two batches
--     are kept, so a batch written mid-scroll never changes the order of the scroll that is already running.
--   - A reader with no usable batch, too few events, or outside the share gets exactly core.v3_scores_base (v3 as before).
--   - The tables are private (RLS on, no policies, no grants to anon or authenticated).
--
-- Known limit: the category step inside v3_scores is computed before the hours are added, so the hours shift the final
-- order but not that step. Anything that later does `create or replace function core.v3_scores` replaces the wrapper and
-- turns this off; supabase/tests/ml_serve_hours_check.sql fails when that happens.
-- =============================================================================

-- ---- A. settings ----------------------------------------------------------------------------------------------------
insert into core.rank_params (key, value) values
  ('ml_serve_pct',         0),
  ('ml_serve_holdout_pct', 20),
  ('ml_serve_cap_h',       6),
  ('ml_serve_min_events',  5),
  ('ml_serve_max_age_h',   24)
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_ml_serve_range;
alter table core.rank_params add constraint rank_params_ml_serve_range check (
      (key not in ('ml_serve_pct', 'ml_serve_holdout_pct') or value between 0 and 100)
  and (key <> 'ml_serve_cap_h' or value between 0 and 30)
  and (key <> 'ml_serve_min_events' or value between 0 and 1000)
  and (key <> 'ml_serve_max_age_h' or value between 1 and 168));

-- ---- B. table -------------------------------------------------------------------------------------------------------
create table if not exists core.ml_serve_hours (
  user_id       uuid        not null references auth.users (id) on delete cascade,
  blurb_id      uuid        not null,
  batch_at      timestamptz not null,
  hours         real        not null check (hours between -30 and 30),
  model_version text        not null,
  primary key (user_id, batch_at, blurb_id)
);
create index if not exists ml_serve_hours_user_batch_idx on core.ml_serve_hours (user_id, batch_at desc);
alter table core.ml_serve_hours enable row level security;               -- no policies: private
revoke all on core.ml_serve_hours from public, anon, authenticated;

-- ---- C. who gets the model ------------------------------------------------------------------------------------------
create or replace function core.ml_serve_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select value from core.rank_params where key = 'ml_serve_pct'), 0) > 0
     and 100 * (core.v2_uniforms(p_user::text || '|mlserve'))[1]
         < (select value from core.rank_params where key = 'ml_serve_pct')::double precision
     and 100 * (core.v2_uniforms(p_user::text || '|mlholdout'))[1]
         >= coalesce((select value from core.rank_params where key = 'ml_serve_holdout_pct'), 20)::double precision;
$$;
revoke all on function core.ml_serve_active(uuid) from public, anon, authenticated;

-- ---- D. the wrapper around core.v3_scores ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('core.v3_scores_base(uuid,timestamp with time zone,bigint)') is null then
    if to_regprocedure('core.v3_scores(uuid,timestamp with time zone,bigint)') is null then
      raise exception 'core.v3_scores is missing: apply the For you migrations first';
    end if;
    alter function core.v3_scores(uuid, timestamptz, bigint) rename to v3_scores_base;
  end if;
end $$;

create or replace function core.v3_scores(p_user uuid, p_asof timestamptz, p_gen bigint)
returns table (o_id uuid, o_category text, o_s0 numeric, o_v3 numeric, o_ps numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch timestamptz;
  v_cap   numeric;
  v_n     bigint;
begin
  if core.ml_serve_active(p_user) then
    select max(h.batch_at) into v_batch
      from core.ml_serve_hours h
     where h.user_id = p_user
       and h.batch_at <= p_asof
       and h.batch_at > p_asof - make_interval(hours => coalesce(
             (select r.value from core.rank_params r where r.key = 'ml_serve_max_age_h'), 24)::int);
    if v_batch is not null then
      select count(*) into v_n
        from core.user_events e
       where e.user_id = p_user and e.created_at < p_asof and e.kind in ('like', 'dislike', 'open_detail', 'open_source');
      if v_n < coalesce((select r.value from core.rank_params r where r.key = 'ml_serve_min_events'), 5) then
        v_batch := null;
      end if;
    end if;
  end if;
  if v_batch is null then
    return query select * from core.v3_scores_base(p_user, p_asof, p_gen);
    return;
  end if;
  v_cap := greatest(coalesce((select r.value from core.rank_params r where r.key = 'ml_serve_cap_h'), 6), 0);
  return query
    select s.o_id, s.o_category, s.o_s0,                          -- coalesce BEFORE the clamp: least(null, cap) is cap
           s.o_v3 + greatest(least(coalesce(h.hours::numeric, 0), v_cap), -v_cap),
           s.o_ps + greatest(least(coalesce(h.hours::numeric, 0), v_cap), -v_cap)
      from core.v3_scores_base(p_user, p_asof, p_gen) s
      left join core.ml_serve_hours h on h.user_id = p_user and h.batch_at = v_batch and h.blurb_id = s.o_id;
end;
$$;
revoke all on function core.v3_scores(uuid, timestamptz, bigint) from public, anon, authenticated;
revoke all on function core.v3_scores_base(uuid, timestamptz, bigint) from public, anon, authenticated;

-- ---- E. write one batch (service role only) --------------------------------------------------------------------------
-- p_rows: [{"user_id": uuid, "blurb_id": uuid, "hours": number}, ...]  (at most 20000 per call; call again for more)
create or replace function api.ml_write_serve_hours(p_batch_at timestamptz, p_model text, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n   int;
  v_ins int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'p_rows must be a json array'; end if;
  v_n := jsonb_array_length(p_rows);
  if v_n > 20000 then raise exception 'at most 20000 rows per call'; end if;
  if p_batch_at is null or p_batch_at > now() + interval '1 minute' then raise exception 'p_batch_at must be set and not in the future'; end if;
  if coalesce(trim(p_model), '') = '' then raise exception 'p_model is required'; end if;

  with ins as (
    insert into core.ml_serve_hours (user_id, blurb_id, batch_at, hours, model_version)
    select x.user_id, x.blurb_id, p_batch_at, greatest(least(x.hours, 30), -30)::real, left(p_model, 120)
      from jsonb_to_recordset(p_rows) as x(user_id uuid, blurb_id uuid, hours double precision)
     where x.user_id is not null and x.blurb_id is not null and x.hours is not null and x.hours = x.hours   -- no NaN
       and exists (select 1 from auth.users u where u.id = x.user_id)
    on conflict do nothing
    returning user_id
  )
  select count(*) into v_ins from ins;

  -- keep the two newest batches per reader in this call, and nothing older than two days anywhere
  delete from core.ml_serve_hours d
   where d.batch_at < now() - interval '2 days'
      or (d.user_id in (select distinct x.user_id from jsonb_to_recordset(p_rows) as x(user_id uuid))
          and d.batch_at < (select b.batch_at from (select distinct h.batch_at from core.ml_serve_hours h
                                                      where h.user_id = d.user_id order by h.batch_at desc limit 2) b
                             order by b.batch_at asc limit 1));
  return jsonb_build_object('written', v_ins, 'skipped', v_n - v_ins);
end;
$$;
revoke all on function api.ml_write_serve_hours(timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function api.ml_write_serve_hours(timestamptz, text, jsonb) to service_role;

-- ---- F. status (service role only) -----------------------------------------------------------------------------------
create or replace function api.ml_serve_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ml_serve_pct',         coalesce((select value from core.rank_params where key = 'ml_serve_pct'), 0),
    'ml_serve_holdout_pct', coalesce((select value from core.rank_params where key = 'ml_serve_holdout_pct'), 20),
    'foryou_ml_mode',       coalesce((select value from core.rank_params where key = 'foryou_ml_mode'), 0),
    'readers_with_batch',   (select count(distinct user_id) from core.ml_serve_hours),
    'rows',                 (select count(*) from core.ml_serve_hours),
    'newest_batch',         (select max(batch_at) from core.ml_serve_hours),
    'model_versions',       coalesce((select jsonb_agg(distinct model_version) from core.ml_serve_hours), '[]'::jsonb));
$$;
revoke all on function api.ml_serve_status() from public, anon, authenticated;
grant execute on function api.ml_serve_status() to service_role;
