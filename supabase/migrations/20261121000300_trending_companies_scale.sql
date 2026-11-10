-- Trending's page and the company RPCs scale to ~100x the cards (SQL scale audit, 2026-11-09). NOT applied.
-- Same results; only the work per call is bounded. Idempotent. Run after 20261121000200_search_v7.sql.
--
-- 1. core.feed_top_base (Trending / Latest before the macro_focus gate; 20261113000000_seen_exclusion.sql F1,
--    renamed by 20261116000000_macro_focus.sql): a Trending page sorted every published card below the cursor by
--    rank_score + trend boost (the first page: all of them). Now a lower bound on rank_score is worked out first:
--    take the L = page + 1 best cards by rank_score that surely sort below the cursor (rank_score + the largest
--    boost of the generation < key); each of them has a key of at least its rank_score + the smallest boost, so
--    no card with rank_score below r_L + smallest boost - largest boost can make the page. The page query then
--    reads only cards above that bound (index blurbs_rank_idx / blurbs_rank_cat_idx). Exact: same page, same
--    cursor. Latest is unchanged (already a keyset over blurbs_latest_idx). The wrapper core.feed_top
--    (macro_focus_wrapper) is not recreated and keeps calling the base by name.
-- 2. api.search_companies, api.company_cards, api.companies_directory: the visibility test
--    core.company_card_visible(id) ran once per card_companies row (a function call with two lookups each); it is
--    now a join (same conditions: published, live, link-out flag, has a source). Same responses and grants.
-- Checked by tests/trending_companies_scale_check.sql, macro_focus_check.sql, companies_check.sql.

do $$
begin
  if to_regprocedure('core.feed_top_base(text,text,integer,text)') is null then
    raise exception 'trending_companies_scale: core.feed_top_base missing; apply 20261116000000_macro_focus.sql first';
  end if;
end $$;

create or replace function core.feed_top_base(
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
declare
  v_uid      uuid := auth.uid();
  v_mode     text := coalesce(p_mode, 'top');
  v_limit    int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_hid      text[];
  v_hsrc     text[];
  v_gen      bigint;
  v_maxb     numeric;
  v_rank_key numeric;
  v_time_key timestamptz;
  v_id       uuid;
  v_ids      uuid[];
  v_keys     text[];
  v_next     text;
  v_items    jsonb;
  v_state    jsonb := '{}';
  v_div      jsonb;
  v_carry    uuid[] := '{}';
  v_left     uuid[];
  v_fetch    int;
  v_extra    int;
  v_more     boolean := false;
  v_lastkey  text;
  v_lastid   uuid;
  v_bmax     numeric;
  v_bmin     numeric;
  v_rl       numeric;
  v_nl       int;
  v_floor    numeric := -1e30;
begin
  if v_mode not in ('top', 'latest') then
    raise exception 'invalid_mode' using errcode = 'PT422';
  end if;

  if v_uid is not null then
    select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  end if;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');

  if p_cursor is null then
    v_rank_key := 1e12;
    v_time_key := 'infinity';
    v_id       := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_id := split_part(p_cursor, '|', 2)::uuid;
      if v_mode = 'top' then
        v_rank_key := split_part(p_cursor, '|', 1)::numeric;
        v_gen      := nullif(split_part(p_cursor, '|', 3), '')::bigint;
        v_state    := core.state_from_text(split_part(p_cursor, '|', 4));
        v_carry    := coalesce(string_to_array(nullif(split_part(p_cursor, '|', 5), ''), ',')::uuid[], '{}');
      else
        v_time_key := split_part(p_cursor, '|', 1)::timestamptz;
      end if;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;

  if v_mode = 'top' then
    -- the cursor's generation if it is still kept, else the newest (0 = no boosts yet)
    if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
      select coalesce(max(gen), 0) into v_gen from core.trend_generations;
    end if;
    -- a boost can be as low as -trend_max_neg_hours, so key < rank_score + that bound
    select coalesce(max(value), 3) into v_maxb from core.rank_params where key = 'trend_max_neg_hours';
    -- cards held back by the previous page (still published and not hidden) come first;
    -- the page looks at diversity_carry (3) extra cards so it has room to spread similar ones
    if cardinality(v_carry) > 0 then
      select coalesce(array_agg(u.id order by u.o), '{}') into v_carry
        from unnest(v_carry) with ordinality as u(id, o)
        join core.blurbs b on b.id = u.id
       where b.status = 'published'
         and (p_category is null or b.category = p_category)
         and not (b.category = any (v_hid))
         and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)));
    end if;
    select coalesce(max(value), 3)::int into v_extra from core.rank_params where key = 'diversity_carry';
    v_fetch := greatest(v_limit + greatest(v_extra, 0) - cardinality(v_carry), 1);

    -- 20261121000300: lower bound on rank_score for this page (see the header); exact
    select greatest(coalesce(max(t.boost), 0), 0), least(coalesce(min(t.boost), 0), 0) into v_bmax, v_bmin
      from core.trend_boosts t where t.gen = v_gen;
    select min(s.rank_score), count(*) into v_rl, v_nl
      from (
        select b.rank_score
          from core.blurbs b
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and not (b.category = any (v_hid))
           and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
           and b.rank_score + v_bmax < v_rank_key
         order by b.rank_score desc, b.id desc
         limit v_fetch + 1
      ) s;
    if v_nl >= v_fetch + 1 then
      v_floor := v_rl + v_bmin - v_bmax;
    end if;

    select array_agg(s.id order by s.k desc, s.id desc),
           array_agg(s.k::text order by s.k desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.rank_score + coalesce(t.boost, 0) as k
          from core.blurbs b
          left join core.trend_boosts t on t.gen = v_gen and t.blurb_id = b.id
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and not (b.category = any (v_hid))
           and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
           and b.rank_score < v_rank_key + greatest(v_maxb, 0) + 1        -- index-friendly prefilter (safe bound)
           and b.rank_score >= v_floor                                    -- 20261121000300: exact lower bound
           and (b.rank_score + coalesce(t.boost, 0), b.id) < (v_rank_key, v_id)
         order by 2 desc, b.id desc
         limit v_fetch + 1
      ) s;
  else
    select array_agg(s.id order by s.sort_at desc, s.id desc),
           array_agg(to_char(s.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                     order by s.sort_at desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.sort_at
          from core.blurbs b
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and not (b.category = any (v_hid))
           and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
           and (b.sort_at, b.id) < (v_time_key, v_id)
         order by b.sort_at desc, b.id desc
         limit v_limit + 1
      ) s;
  end if;

  v_ids := coalesce(v_ids, '{}');
  if v_mode = 'top' then
    if cardinality(v_ids) > v_fetch then
      v_more := true; v_ids := v_ids[1:v_fetch]; v_keys := v_keys[1:v_fetch];
    end if;
    if cardinality(v_ids) > 0 then
      v_lastkey := v_keys[cardinality(v_ids)]; v_lastid := v_ids[cardinality(v_ids)];
    else
      v_lastkey := v_rank_key::text; v_lastid := v_id;
    end if;
    v_ids := v_carry || v_ids;
    if cardinality(v_ids) > 0 then                                        -- breadth: pick the page's order
      v_div  := core.diversify(v_ids, v_state, v_limit);
      v_ids  := array(select x::uuid from jsonb_array_elements_text(v_div -> 'ids') with ordinality as t(x, o) order by o);
      v_left := array(select x::uuid from jsonb_array_elements_text(v_div -> 'left') with ordinality as t(x, o) order by o);
      if v_more or cardinality(v_left) > 0 then
        v_next := v_lastkey || '|' || v_lastid || '|' || v_gen || '|' || core.state_to_text(v_div -> 'state')
                  || '|' || array_to_string(v_left, ',');
      end if;
    end if;
  elsif cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit];                   -- Latest: plain keyset
    v_ids  := v_ids[1:v_limit];
  end if;

  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o);

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

revoke all on function core.feed_top_base(text, text, int, text) from public, anon, authenticated;


-- ---------- 2. company RPCs: visibility as a join ----------
create or replace function api.search_companies(p_q text, p_limit int default 5)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 5), 1), coalesce((select value from core.company_params where key = 'search_max'), 10)::int);
  v_days int := coalesce((select value from core.company_params where key = 'recent_days'), 30)::int;
begin
  -- Counting is the only per-company work, so it runs for at most 3 x limit candidates.
  return coalesce((
    select jsonb_agg(core.company_json(c, x.n, v_days) || jsonb_build_object('score', x.score, 'match', x.match)
                     order by x.score desc, x.n desc, x.ticker collate "C")
    from (
      select q.ticker, q.score, q.match,
             (select count(*) from core.card_companies cc
               join core.blurbs b on b.id = cc.blurb_id join core.app_config cfg on cfg.id
               where cc.ticker = q.ticker and cc.sort_at >= now() - make_interval(days => v_days)
                 and b.status = 'published' and b.published_at <= now() and (b.kind <> 'link_out' or cfg.linkout_cards)
                 and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)) as n
      from (select * from core.company_query_scores(p_q) q0 order by q0.score desc, q0.ticker collate "C" limit v_lim * 3) q
      order by q.score desc, n desc, q.ticker collate "C"
      limit v_lim) x
    join core.companies c on c.ticker = x.ticker), '[]'::jsonb);
end $$;

create or replace function api.company_cards(p_ticker text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_t    text := upper(btrim(coalesce(p_ticker, '')));
  v_lim  int  := least(greatest(coalesce(p_limit, 20), 1), coalesce((select value from core.company_params where key = 'cards_page_max'), 30)::int);
  v_days int  := coalesce((select value from core.company_params where key = 'recent_days'), 30)::int;
  v_sort timestamptz; v_id uuid;
  v_rows record; v_ids uuid[] := '{}'; v_more boolean := false; v_last_sort timestamptz; v_last_id uuid; v_i int := 0;
  v_company jsonb;
begin
  select core.company_json(c, (select count(*) from core.card_companies cc
                                join core.blurbs b on b.id = cc.blurb_id join core.app_config cfg on cfg.id
                                where cc.ticker = c.ticker and cc.sort_at >= now() - make_interval(days => v_days)
                                  and b.status = 'published' and b.published_at <= now() and (b.kind <> 'link_out' or cfg.linkout_cards)
                                  and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)), v_days)
    into v_company
  from core.companies c where c.ticker = v_t and c.enabled;
  if v_company is null then
    return jsonb_build_object('company', null, 'items', '[]'::jsonb, 'next_cursor', null);
  end if;
  if p_cursor is not null then
    begin
      v_sort := split_part(p_cursor, '|', 1)::timestamptz;
      v_id   := split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_cursor' using errcode = '22023';
    end;
    if v_sort is null or v_id is null then raise exception 'invalid_cursor' using errcode = '22023'; end if;
  end if;
  for v_rows in
    select cc.blurb_id, cc.sort_at
    from core.card_companies cc
    join core.blurbs b on b.id = cc.blurb_id
    join core.app_config cfg on cfg.id
    where cc.ticker = v_t
      and (p_cursor is null or (cc.sort_at, cc.blurb_id) < (v_sort, v_id))
      and b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or cfg.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
    order by cc.sort_at desc, cc.blurb_id desc
    limit v_lim + 1
  loop
    v_i := v_i + 1;
    if v_i > v_lim then v_more := true; exit; end if;
    v_ids := v_ids || v_rows.blurb_id;
    v_last_sort := v_rows.sort_at; v_last_id := v_rows.blurb_id;
  end loop;
  return jsonb_build_object(
    'company', v_company,
    'items', core.cards_json(v_ids, auth.uid()),
    'next_cursor', case when v_more then v_last_sort::text || '|' || v_last_id::text end);
end $$;

create or replace function api.companies_directory(p_days int default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select least(greatest(coalesce(p_days, (select value from core.company_params where key = 'recent_days')::int, 30), 1), 365) as days),
  n as (
    select cc.ticker, count(*) as n, max(cc.sort_at) as last_at
    from core.card_companies cc cross join d
    join core.blurbs b on b.id = cc.blurb_id join core.app_config cfg on cfg.id
    where cc.sort_at >= now() - make_interval(days => d.days)
      and b.status = 'published' and b.published_at <= now() and (b.kind <> 'link_out' or cfg.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
    group by cc.ticker)
  select coalesce(jsonb_agg(core.company_json(c, n.n, d.days) || jsonb_build_object('last_card_at', n.last_at)
                            order by c.sector, coalesce(n.n, 0) desc, c.short_name collate "C"), '[]'::jsonb)
  from core.companies c cross join d left join n on n.ticker = c.ticker
  where c.enabled
$$;

revoke all on function api.search_companies(text, int), api.company_cards(text, text, int), api.companies_directory(int) from public;
grant execute on function api.search_companies(text, int), api.company_cards(text, text, int), api.companies_directory(int)
  to anon, authenticated, service_role;
