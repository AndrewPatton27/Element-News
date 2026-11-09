-- =============================================================================
-- Element: macro/finance focus (2026-11-16; R-218, the CLAUDE.md standing content rule, Drew's tightened rule)
--
-- Problem (R-218, read-only prod queries 2026-11-09): 59% of the last 14 days' cards were CPSC recalls (a
-- 180-day backfill), so Trending's top 10 was about 50% macro/finance with recalls side by side.
-- Drew's rule: a recall (small/micro company news) is NOT shown in Trending, Latest or For you (guests
-- included) unless it is MATERIAL (it plausibly moves a public company's stock: big recall by units or by
-- units x price, deaths or serious injuries reported, stop-sale, a watch-list company) or the reader follows
-- the company. Everything stays reachable through the Recalls & Safety category, the company page and search.
-- Target: >= 80% macro/finance in the top 10 and >= 85% in the top 50, never a short feed.
--
--   A  event weights: recall 5 -> 1.5, science 3 -> 1.5, earnings 5 -> 6; importance and rank_score are then
--      recomputed for every existing card (core.refresh_all_ranks), all inside this file's one transaction.
--      A fresh macro release (8 x 1.25 = 10) now outranks a same-age recall by 8 x log2(10 / 1.875) = 19.3 h.
--   B  settings (core.rank_params): micro_max_per_10 = 1; 'micro_category:<slug>' = 1 (page cap only) or 2
--      (page cap + non-material cards left out of the three feeds): safety = 2, science = 1;
--      micro_gate_max_calls = 4 (bounded refill per page); micro_follow_days = 14, micro_follow_max = 30.
--   C  core.card_material (card id -> material flag, reasons, company tickers), written by the ingest through
--      api.set_card_material (service role). No row = not material. Cards published before this file get a
--      verdict from their own text (C2, core.backfill_recall_material, run once here; api.backfill_recall_material
--      re-runs it, e.g. after company-m8's tags land). A watch-list company's recall is material even when small
--      (micro_watch_material = 1, Drew's default). COMPANY LINK INTERFACE: tickers are the same key as
--      core.companies.ticker / core.card_companies.ticker (company-m8, 20261115000000). api.followed_micro reads
--      both card_material.tickers and, when that table exists, core.card_companies, so the tagging can arrive
--      later without a change here.
--   D  core.diversify(uuid[], jsonb, int): ISOLATED REDEFINITION. Body = main's 20261017071000_diversity_patch.sql
--      version plus the lines marked "-- MICRO" (soft page cap). Seen-exclusion (20261113000000), search
--      (20261114000000) and companies (20261115000000) do not redefine it. If another branch does, re-apply only
--      the "-- MICRO" lines onto that version.
--   E  WRAPPERS, not copies: core.feed_top and core.feed_for_you_v5 / v6 / v7 (whatever version is installed,
--      e.g. Albert's seen-exclusion bodies with their v_sx filter) are renamed *_base and wrapped. Bodies are
--      never copied, so the seen filter, seen_fill and seen_from stay exactly as installed. Each wrapped page:
--        1. calls the base (same cursor), drops non-material cards of a gated topic, and if that leaves the page
--           short calls the base again with its next cursor (at most micro_gate_max_calls calls per page);
--        2. applies the page cap (core.micro_cap_pick) over what is left, with the history from the cursor;
--        3. cards it could not show travel in the base cursor's own held-back field (Trending field 5, For you
--           field 6), which every base already reads back first in line: no card lost, none repeated.
--      Trending with a category (the Safety chip) and Latest with a category: no gate (every recall listed).
--      Latest: own cursor 'MC:<state>:<held-back ids>:<base cursor or END>'; older Latest cursors still work.
--      RE-RUN RULE: a migration that recreates one of the four functions after this file must be followed by a
--      re-run of this file (the DO block re-wraps a recreated function and is safe to run again).
--   F  api.followed_micro(tickers, limit): the left-out recalls of companies the reader follows (follows are
--      device-local today, for guests and signed-in readers alike), newest first, bounded. The app merges them
--      into its list (lib/feed/followedMicro.ts); server keyset paging is not touched.
--   G  api.macro_share(): service role. Macro/finance and micro share of the guest Trending / Latest top 10 / 50.
--      Macro/finance includes Federal Reserve cards and economic Federal Register cards (Drew decision 5; measuring
--      only, ranking weights unchanged): core.is_macro_card, core.fedreg_economic.
--
-- Idempotent (a re-run resets the three weights in A). Check: supabase/tests/macro_focus_check.sql.
-- =============================================================================

begin;

-- =============================================================================
-- A. EVENT WEIGHTS + RECOMPUTE
-- =============================================================================

insert into core.rank_event_weights (event_type, weight) values
  ('recall',   1.5),
  ('science',  1.5),
  ('earnings', 6)
on conflict (event_type) do update set weight = excluded.weight;

select core.refresh_all_ranks();


-- =============================================================================
-- B. SETTINGS
-- =============================================================================

insert into core.rank_params (key, value) values
  ('micro_max_per_10',        1),   -- at most this many micro cards in any 10 in a row (soft: never a short page); 10 = off
  ('micro_category:safety',   2),   -- Recalls & Safety: page cap + non-material recalls left out of the feeds
  ('micro_category:science',  1),   -- Science & Space (USGS, NASA): page cap only
  ('micro_gate_max_calls',    4),   -- base calls per wrapped page at most (bounded refill)
  ('micro_follow_days',      14),   -- api.followed_micro looks back this many days
  ('micro_follow_max',       30),   -- api.followed_micro returns at most this many cards
  ('micro_material_min_units', 100000),  -- backfill (card text): a recall of at least this many units is material
  ('micro_watch_material',    1)    -- 1 = a watch-list company's recall is material even when small (Drew's default); 0 = not
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_micro_range;
alter table core.rank_params add constraint rank_params_micro_range
  check ((key <> 'micro_max_per_10' or (value >= 0 and value <= 10 and value = trunc(value)))
     and (not starts_with(key, 'micro_category:') or value in (0, 1, 2))
     and (key not in ('micro_gate_max_calls', 'micro_follow_days', 'micro_follow_max') or (value >= 1 and value <= 100))
     and (key <> 'micro_material_min_units' or value >= 1)
     and (key <> 'micro_watch_material' or value in (0, 1)));


-- =============================================================================
-- C. core.card_material + api.set_card_material
-- =============================================================================

create table if not exists core.card_material (
  blurb_id  uuid primary key references core.blurbs (id) on delete cascade,
  material  boolean not null,
  reasons   text[]  not null default '{}',          -- e.g. {units_100000, deaths}; never source text
  tickers   text[]  not null default '{}',          -- company key = core.companies.ticker (company-m8)
  set_at    timestamptz not null default now(),
  check (cardinality(reasons) <= 10 and cardinality(tickers) <= 5)
);
create index if not exists card_material_tickers_gin on core.card_material using gin (tickers);
alter table core.card_material enable row level security;   -- no policies: private
revoke all on core.card_material from public, anon, authenticated;

-- p: {id, material, reasons[], tickers[]}. Returns {status: 'set' | 'not_found', id}.
create or replace function api.set_card_material(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_t  text[];
begin
  begin v_id := (p ->> 'id')::uuid; exception when others then raise exception 'invalid_id' using errcode = 'PT422'; end;
  if jsonb_typeof(p -> 'material') <> 'boolean' then raise exception 'invalid_material' using errcode = 'PT422'; end if;
  if not exists (select 1 from core.blurbs where id = v_id) then
    return jsonb_build_object('status', 'not_found', 'id', v_id);
  end if;
  v_t := array(select distinct upper(x) from jsonb_array_elements_text(coalesce(p -> 'tickers', '[]')) x
                where upper(x) ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$' limit 5);
  insert into core.card_material (blurb_id, material, reasons, tickers, set_at)
  values (v_id, (p ->> 'material')::boolean,
          array(select left(x, 40) from jsonb_array_elements_text(coalesce(p -> 'reasons', '[]')) x limit 10),
          v_t, now())
  on conflict (blurb_id) do update
     set material = excluded.material, reasons = excluded.reasons, tickers = excluded.tickers, set_at = excluded.set_at;
  return jsonb_build_object('status', 'set', 'id', v_id);
end;
$$;
revoke all on function api.set_card_material(jsonb) from public, anon, authenticated;
grant execute on function api.set_card_material(jsonb) to service_role;

-- Which of p_ids are left out of the feeds: category with micro_category = 2 and no material = true row.
create or replace function core.micro_gated_ids(p_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id), '{}')
    from unnest(coalesce(p_ids, '{}')) u(id)
    join core.blurbs b on b.id = u.id
   where b.category in (select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value = 2)
     and not coalesce((select m.material from core.card_material m where m.blurb_id = b.id), false);
$$;
revoke all on function core.micro_gated_ids(uuid[]) from public, anon, authenticated;

-- C2. BACKFILL: a verdict for recalls published before this file, from the card's own text (headline, body,
--     detail paragraphs; the CPSC JSON is not stored). Same rules as ingest/src/sources/cpsc.ts classifyRecall,
--     as far as the card text allows: units ("about 110,550 ..." >= micro_material_min_units), reported deaths or
--     serious injuries (sentences that are negated or only describe a risk do not count), stop-sale, and a
--     watch-list company (card tickers, plus company-m8's core.card_companies tags when installed) when
--     micro_watch_material = 1. Reasons start with 'text:' so they are told apart from ingest verdicts.
create or replace function core.recall_text_verdict(p_text text, p_tickers text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_min   numeric;
  v_watch numeric;
  v_units numeric := 0;
  v_n     numeric;
  v_r     text[] := '{}';
  m       text[];
  v_s     text;
  v_death boolean := false;
  v_ser   boolean := false;
  t       text;
begin
  select coalesce(max(value) filter (where key = 'micro_material_min_units'), 100000),
         coalesce(max(value) filter (where key = 'micro_watch_material'), 1)
    into v_min, v_watch from core.rank_params;
  for m in select regexp_matches(coalesce(p_text, ''),
                    '(?:about|approximately|nearly|more than|over|some)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*(million|thousand)?', 'gi') loop
    v_n := replace(m[1], ',', '')::numeric * case lower(coalesce(m[2], '')) when 'million' then 1000000 when 'thousand' then 1000 else 1 end;
    if v_n > v_units then v_units := v_n; end if;
  end loop;
  for v_s in select s from regexp_split_to_table(coalesce(p_text, ''), '[.;!?]\s+') s loop
    -- negated, or only describing a possible harm (checked on the prod snapshot: "creates a danger of ... death",
    -- "to prevent injury or death" are warnings, not reports)
    continue when v_s ~* '\m(no|none|not|without)\M'
               or v_s ~* '\m(risk|risks|can|could|may|might|pose|poses|posing|hazard|hazards|danger|dangers|dangerous|deadly|prevent|avoid|threat|includes)\M';
    if v_s ~* '\m(died|death|deaths|killed|fatal|fatality|fatalities)\M' then v_death := true; end if;
    if v_s ~* '(serious(ly)? injur|hospitali[sz]|fractur|amputat|concussion|head injur|(second|third)[- ]degree burn)' then v_ser := true; end if;
  end loop;
  if v_units >= v_min then v_r := v_r || ('text:units_' || trunc(v_units)::text); end if;
  if v_death then v_r := v_r || 'text:deaths'::text; end if;
  if v_ser then v_r := v_r || 'text:serious_injuries'::text; end if;
  if coalesce(p_text, '') ~* 'stop[- ]sale|stop(ped)? selling' then v_r := v_r || 'text:stop_sale'::text; end if;
  if v_watch = 1 then
    foreach t in array coalesce(p_tickers, '{}') loop v_r := v_r || ('text:watch_company_' || t); end loop;
  end if;
  return jsonb_build_object('material', cardinality(v_r) > 0,
                            'reasons', to_jsonb(case when cardinality(v_r) > 0 then v_r[1:10] else array['text:minor'] end));
end;
$$;
revoke all on function core.recall_text_verdict(text, text[]) from public, anon, authenticated;

-- Gives every card of a gated topic without a verdict one (p_overwrite: also redo earlier 'text:' verdicts; an
-- ingest verdict is never touched). Bounded: at most 5000 cards per call. Returns {checked, set, material}.
create or replace function core.backfill_recall_material(p_overwrite boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r      record;
  v_t    text[];
  v_more text[];
  v_v    jsonb;
  v_n    int := 0;
  v_set  int := 0;
  v_mat  int := 0;
  v_cc   boolean := to_regclass('core.card_companies') is not null;
begin
  for r in
    select b.id, b.tickers,
           concat_ws('. ', b.headline, b.body,
                     (select string_agg(x, ' ') from jsonb_array_elements_text(
                        case when jsonb_typeof(b.detail -> 'paragraphs') = 'array' then b.detail -> 'paragraphs' else '[]'::jsonb end) x)) as txt
      from core.blurbs b
      left join core.card_material m on m.blurb_id = b.id
     where b.category in (select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value = 2)
       and (m.blurb_id is null or (p_overwrite and not exists (select 1 from unnest(m.reasons) x where not starts_with(x, 'text:'))))
     order by b.sort_at desc, b.id
     limit 5000
  loop
    v_n := v_n + 1;
    v_t := array(select upper(t ->> 'symbol') from jsonb_array_elements(coalesce(r.tickers, '[]'::jsonb)) t
                  where upper(t ->> 'symbol') ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$');
    if v_cc then
      execute 'select coalesce(array_agg(ticker order by ticker), ''{}'') from core.card_companies where blurb_id = $1' into v_more using r.id;
      v_t := array(select distinct x from unnest(v_t || v_more) x order by x);
    end if;
    v_t := v_t[1:5];
    v_v := core.recall_text_verdict(r.txt, v_t);
    insert into core.card_material (blurb_id, material, reasons, tickers, set_at)
    values (r.id, (v_v ->> 'material')::boolean, array(select jsonb_array_elements_text(v_v -> 'reasons')), coalesce(v_t, '{}'), now())
    on conflict (blurb_id) do update
       set material = excluded.material, reasons = excluded.reasons, tickers = excluded.tickers, set_at = excluded.set_at;
    v_set := v_set + 1;
    if (v_v ->> 'material')::boolean then v_mat := v_mat + 1; end if;
  end loop;
  return jsonb_build_object('checked', v_n, 'set', v_set, 'material', v_mat);
end;
$$;
revoke all on function core.backfill_recall_material(boolean) from public, anon, authenticated;

-- service role: re-run after company-m8's tagging lands (p_overwrite true redoes only 'text:' verdicts)
create or replace function api.backfill_recall_material(p_overwrite boolean default false)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select core.backfill_recall_material(p_overwrite); $$;
revoke all on function api.backfill_recall_material(boolean) from public, anon, authenticated;
grant execute on function api.backfill_recall_material(boolean) to service_role;

-- every recall published before this file gets a verdict now (idempotent: only cards without one)
select core.backfill_recall_material(false);


-- =============================================================================
-- D. core.diversify (3-argument form). Main's body + "-- MICRO" lines. The 2-argument form is unchanged
--    (it calls this one).
-- =============================================================================

create or replace function core.diversify(p_ids uuid[], p_state jsonb, p_take int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_maxrun int;
  v_look   int;
  v_maxsrc int;
  v_win    int;
  v_cat    text   := coalesce(p_state ->> 'c', '');
  v_run    int    := coalesce((p_state ->> 'r')::int, 0);
  v_clu    text   := coalesce(p_state ->> 'k', '');
  v_scl    text   := coalesce(p_state ->> 's', '');
  v_tick   text[] := coalesce(array(select jsonb_array_elements_text(
                        case when jsonb_typeof(p_state -> 't') = 'array' then p_state -> 't' else '[]'::jsonb end)), '{}');
  v_recent text[] := coalesce(array(select jsonb_array_elements_text(
                        case when jsonb_typeof(p_state -> 'w') = 'array' then p_state -> 'w' else '[]'::jsonb end)), '{}');
  v_ids    uuid[];
  v_cats   text[];
  v_clus   text[];
  v_ticks  jsonb[];
  v_skeys  text[];
  v_scls   text[];
  v_n      int;
  v_used   boolean[];
  v_out    uuid[] := '{}';
  v_pick   int;
  v_seen   int;
  v_force  text;
  v_ok_cat boolean;
  v_ok_typ boolean;
  v_ok_tik boolean;
  v_ok_scl boolean;
  v_ok_win boolean;
  v_mcap   int;                                                           -- MICRO: micro_max_per_10 (null = off)
  v_mcats  text[];                                                        -- MICRO: micro topics
  v_micro  boolean[];                                                     -- MICRO: card j is in a micro topic
  v_mh     text := right(regexp_replace(coalesce(p_state ->> 'mh', ''), '[^01]', '', 'g'), 9);   -- MICRO: last 9 cards, '1' = micro
  v_mfull  boolean;                                                       -- MICRO: the last 9 already hold the cap
  v_ok_mic boolean;                                                       -- MICRO
begin
  select coalesce(max(value) filter (where key = 'diversity_max_run'), 2)::int,
         coalesce(max(value) filter (where key = 'diversity_lookahead'), 8)::int,
         coalesce(max(value) filter (where key = 'diversity_max_per_source'), 2)::int,
         coalesce(max(value) filter (where key = 'diversity_window'), 5)::int,
         max(value) filter (where key = 'micro_max_per_10')::int          -- MICRO
    into v_maxrun, v_look, v_maxsrc, v_win, v_mcap
    from core.rank_params;
  v_mcats := array(select substr(key, 16) from core.rank_params            -- MICRO: 'micro_category:' is 15 characters
                    where starts_with(key, 'micro_category:') and value > 0);

  select array_agg(b.id order by u.o),
         array_agg(b.category order by u.o),
         array_agg(b.category || '/' || coalesce(b.event_type, ':none') order by u.o),
         array_agg(coalesce((select jsonb_agg(t ->> 'symbol') from jsonb_array_elements(b.tickers) t
                              where t ->> 'symbol' is not null), '[]'::jsonb) order by u.o),
         array_agg(sk.k order by u.o),
         array_agg(case when sk.k = 'fedreg'
                        then 'fedreg:' || lower(coalesce(nullif(b.attribution, ''), sk.attr, ''))
                        else sk.k end order by u.o),
         array_agg(coalesce(b.category = any (v_mcats), false) order by u.o)   -- MICRO
    into v_ids, v_cats, v_clus, v_ticks, v_skeys, v_scls, v_micro
    from unnest(p_ids) with ordinality as u(id, o)
    join core.blurbs b on b.id = u.id
    cross join lateral (
      select coalesce(core.source_key_of(b.kind, b.id),
                      'name:' || coalesce((select s.name from core.blurb_sources s where s.blurb_id = b.id
                                            order by s.is_primary desc, s.position, s.id limit 1), '?')) as k,
             (select s.attribution from core.blurb_sources s where s.blurb_id = b.id
               order by s.is_primary desc, s.position, s.id limit 1) as attr
    ) sk;

  v_n := coalesce(cardinality(v_ids), 0);
  v_used := array_fill(false, array[greatest(v_n, 1)]);
  for slot in 1 .. least(v_n, greatest(coalesce(p_take, v_n), 0)) loop
    v_pick := null;
    v_mfull := v_mcap is not null and length(replace(v_mh, '0', '')) >= v_mcap;   -- MICRO

    -- spread a crowded story type (only with a card that passes rules 2-5)
    select x.k into v_force
      from (select v_clus[j] as k, count(*) as c, min(j) as first_j
              from generate_series(1, v_n) j
             where not v_used[j] and v_clus[j] <> v_clu
             group by v_clus[j]) x
     where 2 * x.c - 1 >= least(v_n, coalesce(p_take, v_n)) - slot + 1
     order by x.c desc, x.first_j
     limit 1;
    if found then
      select j into v_pick from generate_series(1, v_n) j
       where not v_used[j] and v_clus[j] = v_force
         and v_scls[j] <> v_scl
         and (select count(*) from unnest(v_recent[greatest(cardinality(v_recent) - (v_win - 2), 1):]) r where r = v_skeys[j]) < v_maxsrc
         and not exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick))
         and not (v_mfull and v_micro[j])                                   -- MICRO
       order by j
       limit 1;
    end if;

    -- tiers 1-3 as before plus the micro cap; 4 = micro cap only (lookahead); 5 = micro cap only (whole page:
    -- reaches past the lookahead for a non-micro card). Only when every card left is a micro card and the cap
    -- is full (soft cap: never a short page): 6-8 = main's tiers 1-3 without the cap, 9 = best remaining card.
    -- With no micro card in play tier 4 equals main's tier 4 and tiers 5-9 are never reached.      -- MICRO
    for tier in 1 .. 9 loop                                                -- MICRO (was 1 .. 4)
      exit when v_pick is not null;
      v_seen := 0;
      for j in 1 .. v_n loop
        continue when v_used[j];
        v_seen := v_seen + 1;
        exit when v_seen > greatest(v_look, 1) and tier <> 5;             -- MICRO (tier 5 looks at the whole page)
        v_ok_cat := v_cats[j] <> v_cat or v_run < v_maxrun;
        v_ok_typ := v_clus[j] <> v_clu;
        v_ok_tik := not exists (select 1 from jsonb_array_elements_text(v_ticks[j]) s where s = any (v_tick));
        v_ok_scl := v_scls[j] <> v_scl;
        v_ok_win := (select count(*) from unnest(v_recent[greatest(cardinality(v_recent) - (v_win - 2), 1):]) r
                      where r = v_skeys[j]) < v_maxsrc;
        v_ok_mic := not (v_mfull and v_micro[j]);                          -- MICRO
        if (tier = 1 and v_ok_mic and v_ok_cat and v_ok_typ and v_ok_tik and v_ok_scl and v_ok_win)
           or (tier = 2 and v_ok_mic and v_ok_typ and v_ok_tik and v_ok_scl)
           or (tier = 3 and v_ok_mic and v_ok_typ and v_ok_tik)
           or (tier in (4, 5) and v_ok_mic)                                -- MICRO
           or (tier = 6 and v_ok_cat and v_ok_typ and v_ok_tik and v_ok_scl and v_ok_win)   -- MICRO
           or (tier = 7 and v_ok_typ and v_ok_tik and v_ok_scl)            -- MICRO
           or (tier = 8 and v_ok_typ and v_ok_tik)                         -- MICRO
           or tier = 9 then                                                -- MICRO (was tier = 4)
          v_pick := j; exit;
        end if;
      end loop;
    end loop;

    v_used[v_pick] := true;
    v_out := v_out || v_ids[v_pick];
    if v_cats[v_pick] = v_cat then v_run := v_run + 1; else v_cat := v_cats[v_pick]; v_run := 1; end if;
    v_clu    := v_clus[v_pick];
    v_scl    := v_scls[v_pick];
    v_tick   := coalesce(array(select jsonb_array_elements_text(v_ticks[v_pick])), '{}');
    v_recent := (v_recent || v_skeys[v_pick]);
    v_recent := v_recent[greatest(cardinality(v_recent) - (greatest(v_win, 2) - 2), 1):];   -- keep the last window-1
    v_mh     := right(v_mh || case when v_micro[v_pick] then '1' else '0' end, 9);   -- MICRO
  end loop;

  return jsonb_build_object('ids', to_jsonb(v_out),
                            'left', to_jsonb(coalesce(array(select v_ids[j] from generate_series(1, v_n) j
                                                             where not v_used[j] order by j), '{}')),
                            'state', jsonb_build_object('c', v_cat, 'r', v_run, 'k', v_clu, 't', to_jsonb(v_tick),
                                                        's', v_scl, 'w', to_jsonb(v_recent),
                                                        'mh', v_mh));                -- MICRO
end;
$$;

revoke all on function core.diversify(uuid[], jsonb, int) from public, anon, authenticated;


-- Page cap alone (no other breadth rule), used by the wrappers in section E.
-- Micro cap alone (no other breadth rule): from p_cards (JSON cards, best first) place p_take cards, each the
-- first card that keeps "at most micro_max_per_10 micro cards in any 10 in a row", else the first card left.
-- Returns {picked: [index], left: [index], mh: last-9 history, soft: a micro card had to be placed over the cap}. Indexes are 1-based positions in p_cards.
create or replace function core.micro_cap_pick(p_cards jsonb, p_mh text, p_take int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mcap  int;
  v_mcats text[];
  v_mh    text := right(regexp_replace(coalesce(p_mh, ''), '[^01]', '', 'g'), 9);
  v_n     int := coalesce(jsonb_array_length(p_cards), 0);
  v_micro boolean[];
  v_used  boolean[];
  v_out   int[] := '{}';
  v_pick  int;
  v_full  boolean;
  v_soft  boolean := false;
begin
  select max(value)::int into v_mcap from core.rank_params where key = 'micro_max_per_10';
  v_mcats := array(select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value > 0);
  v_micro := array(select coalesce(c ->> 'category' = any (v_mcats), false)
                     from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) with ordinality as x(c, o) order by o);
  v_used  := array_fill(false, array[greatest(v_n, 1)]);
  for slot in 1 .. least(v_n, greatest(coalesce(p_take, v_n), 0)) loop
    v_full := v_mcap is not null and length(replace(v_mh, '0', '')) >= v_mcap;
    v_pick := null;
    for j in 1 .. v_n loop
      if not v_used[j] and not (v_full and v_micro[j]) then v_pick := j; exit; end if;
    end loop;
    if v_pick is null then                                                -- soft: only micro cards left
      v_soft := true;
      for j in 1 .. v_n loop
        if not v_used[j] then v_pick := j; exit; end if;
      end loop;
    end if;
    v_used[v_pick] := true;
    v_out := v_out || v_pick;
    v_mh  := right(v_mh || case when v_micro[v_pick] then '1' else '0' end, 9);
  end loop;
  return jsonb_build_object('picked', to_jsonb(v_out),
                            'left', to_jsonb(coalesce(array(select j from generate_series(1, v_n) j where not v_used[j] order by j), '{}')),
                            'mh', v_mh, 'soft', v_soft);
end;
$$;
revoke all on function core.micro_cap_pick(jsonb, text, int) from public, anon, authenticated;


-- =============================================================================
-- E. WRAPPERS: gate + page cap around the installed feed functions
-- =============================================================================

-- Sets field p_field (1-based) of a '|' cursor, padding with empty fields.
create or replace function core.mf_field_set(p text, p_field int, p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  a text[] := string_to_array(coalesce(p, ''), '|');
begin
  while coalesce(cardinality(a), 0) < p_field loop a := a || ''::text; end loop;
  a[p_field] := coalesce(p_value, '');
  return array_to_string(a, '|');
end;
$$;
revoke all on function core.mf_field_set(text, int, text) from public, anon, authenticated;

-- Rename each installed function to *_base (first run), or re-wrap one that a later migration recreated (its
-- body has no 'macro_focus_wrapper' marker). On an already wrapped database this does nothing.
do $$
declare
  f     record;
  v_src text;
begin
  for f in select * from (values ('feed_top', 'text,text,integer,text'), ('feed_for_you_v5', 'text,integer'),
                                 ('feed_for_you_v6', 'text,integer,bigint,bigint'), ('feed_for_you_v7', 'text,integer')) v(n, a) loop
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('core.' || f.n || '(' || f.a || ')');
    if v_src is null then
      raise exception 'macro_focus: core.%(%) is missing; apply the earlier migrations first', f.n, f.a;
    end if;
    continue when v_src like '%macro_focus_wrapper%';
    if to_regprocedure('core.' || f.n || '_base(' || f.a || ')') is not null then
      execute format('drop function core.%I(%s)', f.n || '_base', f.a);   -- stale base: the function was recreated
    end if;
    execute format('alter function core.%I(%s) rename to %I', f.n, f.a, f.n || '_base');
    execute format('revoke all on function core.%I(%s) from public, anon, authenticated', f.n || '_base', f.a);
  end loop;
end;
$$;

-- Trending (p_fn 'top') and For you (v5, v6, v7): gate + refill + page cap over the base. Carry field = 5
-- (Trending) or 6 (For you); the breadth state is the field before it and gains the page-cap history 'mh'.
create or replace function core.micro_fill(p_fn text, p_cursor text, p_limit int, p_category text, p_model bigint, p_seed bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_cf     int  := case when p_fn = 'top' then 5 else 6 end;
  v_max    int;
  v_mh     text := '';
  v_cur    text := p_cursor;
  v_r      jsonb;
  v_next   text;
  v_last   text;
  v_acc    jsonb := '[]';
  v_terms  jsonb := '[]';
  v_hast   boolean := false;
  v_calls  int := 0;
  v_ngated int := 0;
  v_gated  uuid[];
  v_items  jsonb;
  v_t      jsonb;
  v_pick   jsonb;
  v_left   uuid[];
  v_old    text;
  v_out    text;
begin
  select coalesce(max(value), 4)::int into v_max from core.rank_params where key = 'micro_gate_max_calls';
  if p_cursor is not null then
    begin
      v_mh := coalesce(core.state_from_text(nullif(split_part(p_cursor, '|', v_cf - 1), '')) ->> 'mh', '');
    exception when others then v_mh := '';
    end;
  end if;

  loop
    -- first call: the page size asked for; refill calls: 30 (so 4 calls look at up to 100 cards)
    v_r := case p_fn when 'top' then core.feed_top_base('top', v_cur, case when v_calls = 0 then p_limit else 30 end, p_category)
                     when 'v5'  then core.feed_for_you_v5_base(v_cur, case when v_calls = 0 then p_limit else 30 end)
                     when 'v6'  then core.feed_for_you_v6_base(v_cur, case when v_calls = 0 then p_limit else 30 end, p_model, p_seed)
                     else            core.feed_for_you_v7_base(v_cur, case when v_calls = 0 then p_limit else 30 end) end;
    v_calls := v_calls + 1;
    if v_r ? 'terms' then v_hast := true; end if;
    v_gated  := core.micro_gated_ids(array(select (x.c ->> 'id')::uuid from jsonb_array_elements(coalesce(v_r -> 'items', '[]')) x(c)));
    v_ngated := v_ngated + cardinality(v_gated);
    select coalesce(jsonb_agg(x.c order by x.o) filter (where not ((x.c ->> 'id')::uuid = any (v_gated))), '[]'),
           coalesce(jsonb_agg(coalesce(v_r -> 'terms' -> (x.o::int - 1), '0'::jsonb) order by x.o)
                      filter (where not ((x.c ->> 'id')::uuid = any (v_gated))), '[]')
      into v_items, v_t
      from jsonb_array_elements(coalesce(v_r -> 'items', '[]')) with ordinality as x(c, o);
    v_acc   := v_acc || v_items;
    v_terms := v_terms || v_t;
    v_next  := v_r ->> 'next_cursor';
    if v_next is not null then v_last := v_next; end if;
    exit when v_next is null or v_calls >= greatest(v_max, 1);
    -- enough cards, and the page cap holds without placing a micro card over it: done; else look further
    exit when jsonb_array_length(v_acc) >= v_lim and not (core.micro_cap_pick(v_acc, v_mh, v_lim) ->> 'soft')::boolean;
    v_cur := v_next;
  end loop;

  v_pick := core.micro_cap_pick(v_acc, v_mh, v_lim);
  -- nothing left out and nothing moved: the base page exactly
  if v_calls = 1 and v_ngated = 0 and jsonb_array_length(v_pick -> 'left') = 0
     and v_pick -> 'picked' = (select coalesce(jsonb_agg(i order by i), '[]') from generate_series(1, jsonb_array_length(v_acc)) i) then
    return v_r;
  end if;

  select coalesce(jsonb_agg(v_acc -> (i::int - 1) order by o), '[]'), coalesce(jsonb_agg(v_terms -> (i::int - 1) order by o), '[]')
    into v_items, v_t
    from jsonb_array_elements_text(v_pick -> 'picked') with ordinality as t(i, o);
  v_left := array(select (v_acc -> (i::int - 1) ->> 'id')::uuid
                    from jsonb_array_elements_text(v_pick -> 'left') with ordinality as t(i, o) order by o);

  if v_next is not null then
    v_old := split_part(v_next, '|', v_cf);
    v_out := core.mf_field_set(v_next, v_cf, array_to_string(v_left, ',')
                               || case when v_old <> '' and cardinality(v_left) > 0 then ',' else '' end || v_old);
  elsif cardinality(v_left) > 0 and v_last is not null then
    -- the base has no more cards: an empty keyset position, so the next page is just the held-back cards
    v_out := core.mf_field_set(core.mf_field_set(core.mf_field_set(v_last, 1, '-1e30'), 2, '00000000-0000-0000-0000-000000000000'),
                               v_cf, array_to_string(v_left, ','));
  end if;
  if v_out is not null then
    v_out := core.mf_field_set(v_out, v_cf - 1, core.state_to_text(
               core.state_from_text(nullif(split_part(v_out, '|', v_cf - 1), '')) || jsonb_build_object('mh', v_pick ->> 'mh')));
  end if;

  return jsonb_build_object('items', v_items, 'next_cursor', v_out)
         || case when v_hast then jsonb_build_object('terms', v_t) else '{}'::jsonb end;
end;
$$;
revoke all on function core.micro_fill(text, text, int, text, bigint, bigint) from public, anon, authenticated;

create or replace function core.feed_top(
  p_mode     text default 'top',
  p_cursor   text default null,
  p_limit    int  default 20,
  p_category text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
-- macro_focus_wrapper: Trending = core.micro_fill over core.feed_top_base; Latest = base + gate + page cap.
-- With a category (the topic chips) both are the base unchanged: every card of the topic is listed.
declare
  v_uid    uuid := auth.uid();
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_m      text[];
  v_base   text;                         -- cursor for core.feed_top_base; 'END' = base has no more cards
  v_mh     text := '';
  v_carry  uuid[] := '{}';
  v_hid    text[];
  v_hsrc   text[];
  v_extra  int;
  v_max    int;
  v_calls  int := 0;
  v_fetch  int;
  v_r      jsonb;
  v_gated  uuid[];
  v_cands  jsonb;
  v_pick   jsonb;
  v_items  jsonb;
  v_left   uuid[];
begin
  if p_category is not null then
    return core.feed_top_base(p_mode, p_cursor, p_limit, p_category);
  end if;
  if coalesce(p_mode, 'top') <> 'latest' then
    return core.micro_fill('top', p_cursor, p_limit, null, null, null);
  end if;
  -- cap off, no gated topic and not one of our cursors: plain Latest, byte for byte
  if coalesce((select max(value) from core.rank_params where key = 'micro_max_per_10'), 10) >= 10
     and not exists (select 1 from core.rank_params where starts_with(key, 'micro_category:') and value = 2)
     and coalesce(p_cursor, '') not like 'MC:%' then
    return core.feed_top_base(p_mode, p_cursor, p_limit, null);
  end if;

  if coalesce(p_cursor, '') like 'MC:%' then
    v_m := regexp_match(p_cursor, '^MC:([A-Za-z0-9+/=]*):([0-9a-fA-F,-]*):(.*)$');
    if v_m is null then raise exception 'invalid_cursor' using errcode = 'PT422'; end if;
    begin
      v_mh    := coalesce(core.state_from_text(v_m[1]) ->> 'mh', '');
      v_carry := coalesce(string_to_array(nullif(v_m[2], ''), ',')::uuid[], '{}');
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
    v_base := nullif(v_m[3], '');
  else
    v_base := p_cursor;                                                   -- null (first page) or an older Latest cursor
  end if;

  -- held-back cards still visible to this reader keep their place (first in line)
  if cardinality(v_carry) > 0 then
    if v_uid is not null then
      select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
    end if;
    v_hid  := coalesce(v_hid, '{}');
    v_hsrc := coalesce(v_hsrc, '{}');
    select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
      from unnest(v_carry) with ordinality as u(id, o)
      join core.blurbs b on b.id = u.id
     where b.status = 'published'
       and not (b.category = any (v_hid))
       and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)));
  end if;
  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb) into v_cands
    from jsonb_array_elements(core.cards_json(v_carry, null)) with ordinality as x(c, o);

  select coalesce(max(value) filter (where key = 'diversity_carry'), 3)::int,
         coalesce(max(value) filter (where key = 'micro_gate_max_calls'), 4)::int
    into v_extra, v_max from core.rank_params;
  v_extra := greatest(v_extra, 0);
  v_fetch := least(greatest(v_limit + v_extra - cardinality(v_carry), 10), 30);
  while v_base is distinct from 'END' and v_calls < greatest(v_max, 1)
        and (jsonb_array_length(v_cands) < v_limit + v_extra
             or (core.micro_cap_pick(v_cands, v_mh, v_limit) ->> 'soft')::boolean) loop
    v_r := core.feed_top_base('latest', v_base, v_fetch, null);
    v_calls := v_calls + 1;
    v_gated := core.micro_gated_ids(array(select (x.c ->> 'id')::uuid from jsonb_array_elements(coalesce(v_r -> 'items', '[]')) x(c)));
    v_cands := v_cands || coalesce((select jsonb_agg(x.c order by x.o) from jsonb_array_elements(coalesce(v_r -> 'items', '[]')) with ordinality as x(c, o)
                                     where not ((x.c ->> 'id')::uuid = any (v_gated))), '[]');
    v_base  := coalesce(v_r ->> 'next_cursor', 'END');
    v_fetch := 30;
  end loop;

  v_pick := core.micro_cap_pick(v_cands, v_mh, v_limit);
  select coalesce(jsonb_agg(v_cands -> (i::int - 1) order by o), '[]'::jsonb) into v_items
    from jsonb_array_elements_text(v_pick -> 'picked') with ordinality as t(i, o);
  v_left := array(select (v_cands -> (i::int - 1) ->> 'id')::uuid
                    from jsonb_array_elements_text(v_pick -> 'left') with ordinality as t(i, o) order by o);

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', case when v_base is distinct from 'END' or cardinality(v_left) > 0
                        then 'MC:' || core.state_to_text(jsonb_build_object('mh', v_pick ->> 'mh')) || ':'
                             || array_to_string(v_left, ',') || ':' || coalesce(v_base, 'END') end);
end;
$$;
revoke all on function core.feed_top(text, text, int, text) from public, anon, authenticated;

create or replace function core.feed_for_you_v5(p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$ begin -- macro_focus_wrapper
  return core.micro_fill('v5', p_cursor, p_limit, null, null, null); end; $$;
create or replace function core.feed_for_you_v6(p_cursor text, p_limit int, p_model bigint, p_seed bigint)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$ begin -- macro_focus_wrapper
  return core.micro_fill('v6', p_cursor, p_limit, null, p_model, p_seed); end; $$;
create or replace function core.feed_for_you_v7(p_cursor text, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$ begin -- macro_focus_wrapper
  return core.micro_fill('v7', p_cursor, p_limit, null, null, null); end; $$;
revoke all on function core.feed_for_you_v5(text, int)                from public, anon, authenticated;
revoke all on function core.feed_for_you_v6(text, int, bigint, bigint) from public, anon, authenticated;
revoke all on function core.feed_for_you_v7(text, int)                from public, anon, authenticated;

-- Seen-cards tail (seen-exclusion, 20261113000000; optional): a card the reader saw in the Safety chip must not
-- come back in a feed's "all caught up" tail. Wrapped only when the function exists; same re-run rule.
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('core.seen_tail(uuid,text,text,integer,boolean)');
  if v_src is null or v_src like '%macro_focus_wrapper%' then return; end if;
  if to_regprocedure('core.seen_tail_base(uuid,text,text,integer,boolean)') is not null then
    drop function core.seen_tail_base(uuid, text, text, integer, boolean);
  end if;
  alter function core.seen_tail(uuid, text, text, integer, boolean) rename to seen_tail_base;
  revoke all on function core.seen_tail_base(uuid, text, text, integer, boolean) from public, anon, authenticated;
  execute $f$
    create function core.seen_tail(p_user uuid, p_category text, p_cursor text, p_limit int, p_for_you boolean)
    returns jsonb language plpgsql stable security definer set search_path = ''
    as $b$
    declare v_r jsonb; v_g uuid[];
    begin -- macro_focus_wrapper: the base tail minus left-out cards (none left out under a category)
      v_r := core.seen_tail_base(p_user, p_category, p_cursor, p_limit, p_for_you);
      if p_category is not null then return v_r; end if;
      v_g := core.micro_gated_ids(array(select (x.c ->> 'id')::uuid from jsonb_array_elements(coalesce(v_r -> 'items', '[]')) x(c)));
      if cardinality(v_g) = 0 then return v_r; end if;
      return jsonb_set(v_r, '{items}', coalesce((select jsonb_agg(x.c order by x.o)
                                                   from jsonb_array_elements(v_r -> 'items') with ordinality as x(c, o)
                                                  where not ((x.c ->> 'id')::uuid = any (v_g))), '[]'));
    end;
    $b$ $f$;
  revoke all on function core.seen_tail(uuid, text, text, integer, boolean) from public, anon, authenticated;
end;
$$;


-- =============================================================================
-- F. api.followed_micro(tickers, limit): left-out recalls of followed companies (newest first, bounded)
--    Company link: core.card_material.tickers, plus core.card_companies when company-m8 is installed.
--    Only cards the feeds leave out (material ones are already in the feeds). Hidden topics/sources respected.
-- =============================================================================

create or replace function api.followed_micro(p_tickers text[], p_limit int default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_t     text[] := array(select distinct upper(x) from unnest(coalesce(p_tickers, '{}')) x
                           where upper(x) ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$' limit 20);
  v_days  numeric;
  v_max   int;
  v_lim   int;
  v_since timestamptz;
  v_ids   uuid[] := '{}';
  v_more  uuid[];
  v_hid   text[];
  v_hsrc  text[];
begin
  if cardinality(v_t) = 0 then return jsonb_build_object('items', '[]'::jsonb); end if;
  select coalesce(max(value) filter (where key = 'micro_follow_days'), 14),
         coalesce(max(value) filter (where key = 'micro_follow_max'), 30)::int
    into v_days, v_max from core.rank_params;
  v_lim   := least(greatest(coalesce(p_limit, 10), 1), v_max);
  v_since := now() - make_interval(secs => v_days * 86400);

  v_ids := array(select m.blurb_id from core.card_material m join core.blurbs b on b.id = m.blurb_id
                  where m.tickers && v_t and b.sort_at > v_since
                  order by b.sort_at desc, b.id desc limit v_max * 2);
  if to_regclass('core.card_companies') is not null then                  -- company-m8 tags (optional)
    execute 'select coalesce(array_agg(blurb_id), ''{}'') from (select blurb_id from core.card_companies
              where ticker = any ($1) and sort_at > $2 order by sort_at desc limit $3) z'
      into v_more using v_t, v_since, v_max * 2;
    v_ids := v_ids || v_more;
  end if;
  if v_uid is not null then
    select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  end if;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_ids := array(select b.id from core.blurbs b
                  where b.id = any (core.micro_gated_ids(v_ids))
                    and b.status = 'published' and b.sort_at > v_since
                    and not (b.category = any (v_hid))
                    and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
                  order by b.sort_at desc, b.id desc limit v_lim);
  return jsonb_build_object('items', (select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
                                        from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o)));
end;
$$;
revoke all on function api.followed_micro(text[], int) from public;
grant execute on function api.followed_micro(text[], int) to anon, authenticated, service_role;


-- =============================================================================
-- G. api.macro_share(): what guests see at the top of Trending and Latest (service role only)
--    macro/finance (core.is_macro_card, Drew decision 5) = a data card, a card in one of p_macro_categories
--    (default: economy, money, business, earnings, deals, energy, insider trades), a Federal Reserve card (any
--    source named "Federal Reserve ..."), or an ECONOMIC Federal Register card (core.fedreg_economic).
--    micro = a card in a micro_category topic (cap or gate). Measuring only: ranking does not use these.
--    Also: published cards of gated topics in the last 14 days, material vs left out.
-- =============================================================================

-- A Federal Register card is economic when its issuing agency (the attribution after "Federal Register ...,")
-- is an economic agency, or its HEADLINE has an economic word (whole words; the body is not read: an FCC robocall
-- rule that mentions banks in passing is not economic). Checked on real snapshot cards in macro_focus_check.sql.
create or replace function core.fedreg_economic(p_headline text, p_attribution text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_attribution, '') ~* ('\m(Treasury|Internal Revenue Service|Securities and Exchange Commission|Commodity Futures Trading Commission|'
              || 'Federal Deposit Insurance Corporation|Comptroller of the Currency|Federal Energy Regulatory Commission|Commerce Department|'
              || 'Department of Commerce|International Trade Administration|International Trade Commission|Labor Department|Department of Labor|'
              || 'Bureau of Labor Statistics|Bureau of Economic Analysis|Consumer Financial Protection Bureau|Federal Reserve System|'
              || 'Federal Housing Finance Agency|Trade Representative|Small Business Administration|National Credit Union Administration|'
              || 'Census Bureau|Fiscal Service)\M')
      or coalesce(p_headline, '') ~* ('\m(rates?|interest|tariffs?|inflation|banks?|banking|securities|tax|taxes|trade|trading|prices?|'
              || 'wages?|employment|jobs|mortgages?|credit|loans?|lending|exports?|stablecoins?|currency|dollar|debt|budget|'
              || 'subsid(y|ies)|payments?|investors?|stocks?|bonds?)\M');
$$;
revoke all on function core.fedreg_economic(text, text) from public, anon, authenticated;

-- One card (core.cards_json shape) counts as macro/finance for the share metric.
create or replace function core.is_macro_card(p jsonb, p_macro_categories text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p ->> 'kind' = 'data'
      or p ->> 'category' = any (p_macro_categories)
      or exists (select 1 from jsonb_array_elements(coalesce(p -> 'sources', '[]')) s where s ->> 'name' ~ '^Federal Reserve')
      or (exists (select 1 from jsonb_array_elements(coalesce(p -> 'sources', '[]')) s where s ->> 'name' = 'Federal Register')
          and core.fedreg_economic(p ->> 'headline', p ->> 'attribution'));
$$;
revoke all on function core.is_macro_card(jsonb, text[]) from public, anon, authenticated;

create or replace function api.macro_share(
  p_macro_categories text[] default array['economy', 'personal-finance', 'markets', 'earnings', 'deals', 'energy', 'insider']
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mcats text[] := array(select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value > 0);
  v_out   jsonb := '{}';
  v_mode  text;
  v_r     jsonb;
  v_all   jsonb;
  v_top   int;
  v_stats jsonb;
  v_ids   uuid[];
begin
  foreach v_mode in array array['top', 'latest'] loop
    v_r   := core.feed_top(v_mode, null, 30, null);
    v_all := coalesce(v_r -> 'items', '[]'::jsonb);
    if v_r ->> 'next_cursor' is not null then
      v_all := v_all || coalesce(core.feed_top(v_mode, v_r ->> 'next_cursor', 20, null) -> 'items', '[]'::jsonb);
    end if;
    v_stats := '{}';
    foreach v_top in array array[10, 50] loop
      v_stats := v_stats || jsonb_build_object('top' || v_top, (
        select jsonb_build_object(
                 'n', count(*),
                 'macro', count(*) filter (where core.is_macro_card(x.c, p_macro_categories)),
                 'micro', count(*) filter (where x.c ->> 'category' = any (v_mcats)),
                 'macro_share', round(count(*) filter (where core.is_macro_card(x.c, p_macro_categories))::numeric
                                      / nullif(count(*), 0), 3),
                 'micro_share', round(count(*) filter (where x.c ->> 'category' = any (v_mcats))::numeric / nullif(count(*), 0), 3))
          from jsonb_array_elements(v_all) with ordinality as x(c, o)
         where x.o <= v_top));
    end loop;
    v_out := v_out || jsonb_build_object(case when v_mode = 'top' then 'trending' else 'latest' end, v_stats);
  end loop;
  v_ids := array(select b.id from core.blurbs b
                  where b.status = 'published' and b.sort_at > now() - interval '14 days'
                    and b.category in (select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value = 2));
  return v_out || jsonb_build_object(
    'gated_14d', jsonb_build_object('cards', cardinality(v_ids), 'left_out', cardinality(core.micro_gated_ids(v_ids))),
    'macro_categories', to_jsonb(p_macro_categories), 'macro_also', 'Federal Reserve cards; economic Federal Register cards',
    'micro_categories', to_jsonb(v_mcats),
    'targets', jsonb_build_object('top10', 0.8, 'top50', 0.85), 'at', now());
end;
$$;

revoke all on function api.macro_share(text[]) from public, anon, authenticated;
grant execute on function api.macro_share(text[]) to service_role;

commit;

-- ---------- for Drew -------------------------------------------------------------------------------
-- Paste this whole file into the Supabase SQL editor and run it, AFTER 20261113000000_seen_exclusion.sql,
-- 20261114000000 (search) and 20261115000000 (companies) if those are applied. Expected: "Success. No rows returned".
-- Check: select api.macro_share();   -> trending.top10.macro_share >= 0.8. See supabase/tests/cutover_compare.sql block 9.
-- Undo only the page cap:  update core.rank_params set value = 10 where key = 'micro_max_per_10';
-- Undo only the recall gate: update core.rank_params set value = 1 where key = 'micro_category:safety';
