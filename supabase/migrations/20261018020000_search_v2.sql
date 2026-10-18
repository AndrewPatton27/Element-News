-- 20261018020000_search_v2.sql: Search v2 (any-word matching, similar words, typos; ranked by Trending)
--
-- Replaces api.search from 20261018010000_algo_v2.sql. Same signature, same JSON shape
-- ({items, next_cursor}), security definer, search_path '', read-only, anon + authenticated.
--
-- 1. The query is normalized: lowercased, punctuation removed, cut to 80 characters, split into
--    words, stopwords dropped, at most search_max_terms (6) words. Nothing left (or < 2 chars) -> empty page.
-- 2. A card matches when ANY word matches its headline, body, detail, tickers, source names,
--    category label, event type or macro series (id + label), by any of:
--      english stem + prefix match ("fed" -> federal, "infl" -> inflation; prefix from 3 letters),
--      a curated synonym (core.search_synonyms: fed ~ federal reserve ~ fomc, oil ~ crude ~ wti ...),
--      a typo match (core.search_typo_ok: pg_trgm similarity >= 0.4 when pg_trgm is installed,
--        otherwise edit distance <= 1, or <= 2 for words of 8+ letters; only for words of 5+ letters),
--      the exact ticker symbol or macro series id (AAPL, CPI, DGS10).
-- 3. Order = the Trending tab's key (rank_score + this generation's trend boost, in hours; one card per
--    story) + half_life_hours x log2(search_term_bonus 1.3) per extra query word matched (so x1.3 each)
--    + the signed-in personal part (x (1 + 0.15 x clamp(taste_hours / affinity_cap_hours, 0, 1)), the
--    core.taste_hours helper from 20261018010000). Ties: importance, then newest, then id.
-- 4. Paging: cursor "key|id|asof|gen|importance|sort_at"; as-of and trend generation stay frozen.
-- 5. Speed: only the search_scan_cap (2000) highest-ranked published cards are scanned (rank index).
--
-- Never applied automatically. Re-runnable (paste twice: same result).

-- ---------- optional pg_trgm (Supabase has it; PGlite without the contrib does not) ----------
do $$
begin
  begin
    create extension if not exists pg_trgm with schema extensions;
  exception when others then
    raise notice 'search_v2: pg_trgm not available (%); typo matching uses the edit-distance fallback', sqlerrm;
  end;
end $$;

-- ---------- edit distance (fallback typo check; words are short so plpgsql is fine) ----------
create or replace function core.search_edit_distance(a text, b text)
returns int language plpgsql immutable strict set search_path = '' as $$
declare
  la int := char_length(a); lb int := char_length(b);
  prev int[]; cur int[]; i int; j int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      cur := cur || least(cur[j] + 1, prev[j + 1] + 1,
                          prev[j] + case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end);
    end loop;
    prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- ---------- core.search_typo_ok(term, word) + core.search_typo_mode() ----------
-- settings.md: search_trgm_threshold (0.4), search_typo_max_edits (1, 2 from 8 letters)
do $$
declare v_nsp text;
begin
  select n.nspname into v_nsp from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if v_nsp is not null then
    execute format($f$
      create or replace function core.search_typo_ok(p_term text, p_word text)
      returns boolean language sql immutable strict set search_path = '' as
      $b$ select %I.similarity(p_term, p_word) >= 0.4 $b$ $f$, v_nsp);
    execute $f$ create or replace function core.search_typo_mode() returns text language sql immutable
      set search_path = '' as $b$ select 'pg_trgm'::text $b$ $f$;
  else
    execute $f$
      create or replace function core.search_typo_ok(p_term text, p_word text)
      returns boolean language sql immutable strict set search_path = '' as
      $b$ select core.search_edit_distance(p_term, p_word) <= case when char_length(p_term) >= 8 then 2 else 1 end $b$ $f$;
    execute $f$ create or replace function core.search_typo_mode() returns text language sql immutable
      set search_path = '' as $b$ select 'edit_distance'::text $b$ $f$;
  end if;
end $$;
revoke all on function core.search_edit_distance(text, text) from public, anon, authenticated;
revoke all on function core.search_typo_ok(text, text)       from public, anon, authenticated;
revoke all on function core.search_typo_mode()               from public, anon, authenticated;

-- ---------- curated synonyms: words in the same group find each other ----------
create table if not exists core.search_synonyms (
  word text primary key check (word ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  grp  text not null
);
alter table core.search_synonyms enable row level security;
revoke all on core.search_synonyms from anon, authenticated;
insert into core.search_synonyms (word, grp) values
  ('fed', 'fed'), ('federal reserve', 'fed'), ('fomc', 'fed'),
  ('rate', 'rate'), ('rates', 'rate'), ('interest', 'rate'),
  ('inflation', 'inflation'), ('cpi', 'inflation'), ('prices', 'inflation'),
  ('jobs', 'jobs'), ('employment', 'jobs'), ('unemployment', 'jobs'), ('payrolls', 'jobs'),
  ('oil', 'oil'), ('crude', 'oil'), ('wti', 'oil'), ('energy', 'oil'),
  ('stocks', 'stocks'), ('equities', 'stocks'), ('markets', 'stocks'),
  ('quake', 'quake'), ('earthquake', 'quake'), ('tremor', 'quake'),
  ('recall', 'recall'), ('recalls', 'recall'), ('safety', 'recall'),
  ('gdp', 'gdp'), ('growth', 'gdp'), ('economy', 'gdp'),
  ('deal', 'deal'), ('merger', 'deal'), ('acquisition', 'deal')
on conflict (word) do update set grp = excluded.grp;

-- ---------- api.search ----------
create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_personal_weight constant numeric := 0.15;  -- settings.md: search_personal_weight
  c_term_bonus      constant numeric := 1.3;   -- settings.md: search_term_bonus (x per extra matched word)
  c_max_terms       constant int     := 6;     -- settings.md: search_max_terms
  c_scan_cap        constant int     := 2000;  -- settings.md: search_scan_cap
  c_typo_min_len    constant int     := 5;     -- settings.md: search_typo_min_len
  c_prefix_min_len  constant int     := 3;     -- settings.md: search_prefix_min_len
  c_stop constant text[] := array['the','a','an','and','or','of','to','in','on','for','at','by','with',
    'is','are','was','were','be','it','its','as','from','that','this','what','how','why','who','about','into'];
  v_uid   uuid := auth.uid();
  v_norm  text;
  v_terms text[];
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 30);
  v_key   numeric := 1e30;
  v_imp   numeric := 1e30;
  v_sort  timestamptz := 'infinity';
  v_id    uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_asof  timestamptz := now();
  v_gen   bigint;
  v_h     numeric;
  v_cap   numeric;
  v_taste jsonb;
  v_rows  jsonb;
  v_next  text;
  v_empty constant jsonb := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null);
begin
  v_norm := btrim(regexp_replace(lower(left(coalesce(p_q, ''), 80)), '[^[:alnum:]]+', ' ', 'g'));
  if char_length(v_norm) < 2 then return v_empty; end if;
  select coalesce(array_agg(t order by o), '{}') into v_terms
    from (select x.t, min(x.o) as o from regexp_split_to_table(v_norm, ' ') with ordinality as x(t, o)
           where char_length(x.t) >= 2 and not (x.t = any (c_stop))
           group by x.t order by min(x.o) limit c_max_terms) s;
  if p_cursor is not null then
    begin
      v_key  := split_part(p_cursor, '|', 1)::numeric;
      v_id   := split_part(p_cursor, '|', 2)::uuid;
      v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof);
      v_gen  := nullif(split_part(p_cursor, '|', 4), '')::bigint;
      v_imp  := coalesce(nullif(split_part(p_cursor, '|', 5), '')::numeric, 1e30);
      v_sort := coalesce(nullif(split_part(p_cursor, '|', 6), '')::timestamptz, 'infinity');
    exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end;
  end if;
  if cardinality(v_terms) = 0 then return v_empty; end if;

  if v_gen is null or not exists (select 1 from core.trend_generations where gen = v_gen) then
    select coalesce(max(gen), 0) into v_gen from core.trend_generations;
  end if;
  select coalesce(max(value) filter (where key = 'half_life_hours'), 8),
         coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4)
    into v_h, v_cap from core.rank_params;
  if v_uid is not null then v_taste := core.user_taste(v_uid, v_asof); end if;

  with cfg as (select linkout_cards from core.app_config where id),
  pool as (           -- the cards Trending could show, capped (uses blurbs_rank_idx)
    select b.id, b.kind, b.category, b.event_type, b.importance, b.sort_at, b.dedupe_key, b.tickers, b.macro,
           b.rank_score + coalesce(tb.boost, 0) as trend,
           lower(concat_ws(' ', b.headline, b.body,
             (select string_agg(v #>> '{}', ' ') from jsonb_path_query(coalesce(b.detail, '{}'::jsonb), 'strict $.**') v
               where jsonb_typeof(v) = 'string'),
             (select string_agg(concat_ws(' ', t ->> 'symbol', t ->> 'name'), ' ') from jsonb_array_elements(b.tickers) t),
             (select string_agg(s.name, ' ') from core.blurb_sources s where s.blurb_id = b.id),
             (select c2.name from core.categories c2 where c2.slug = b.category), b.category,
             replace(coalesce(b.event_type, ''), '_', ' '),
             (select string_agg(concat_ws(' ', m ->> 'series_id', ms.label), ' ')
                from jsonb_array_elements(b.macro) m left join core.macro_series ms on ms.series_id = m ->> 'series_id')
           )) as doc
      from core.blurbs b
      cross join cfg c
      left join core.trend_boosts tb on tb.gen = v_gen and tb.blurb_id = b.id
     where b.status = 'published' and b.published_at <= v_asof
       and (b.kind <> 'link_out' or c.linkout_cards)
       and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
     order by b.rank_score desc, b.id desc
     limit c_scan_cap
  ), vecs as (
    select p.*, to_tsvector('english', p.doc) as vec from pool p
  ), terms as (
    select u.t, u.i from unnest(v_terms) with ordinality as u(t, i)
  ), vocab as (       -- distinct words of the scanned cards, for typo matching only
    select distinct w from vecs, regexp_split_to_table(vecs.doc, '[^[:alnum:]]+') as w
     where char_length(w) >= c_typo_min_len - 1
       and exists (select 1 from terms where char_length(terms.t) >= c_typo_min_len)
  ), alts as (        -- (word index, alternative, prefix allowed)
    select tm.i, tm.t, tm.t as alt, true as pre from terms tm
    union
    select tm.i, tm.t, s2.word, true from terms tm
      join core.search_synonyms s1 on s1.word in (tm.t, tm.t || 's') or s1.word || 's' = tm.t
      join core.search_synonyms s2 on s2.grp = s1.grp
    union
    select tm.i, tm.t, v.w, false from terms tm join vocab v
        on char_length(tm.t) >= c_typo_min_len and v.w <> tm.t
       and abs(char_length(v.w) - char_length(tm.t)) <= 2 and left(v.w, 1) = left(tm.t, 1)
       and core.search_typo_ok(tm.t, v.w)
  ), tq as (
    select a.i, a.t, to_tsquery('english', string_agg(
             '(' || regexp_replace(a.alt, ' +', ' <-> ', 'g')
             || case when a.pre and char_length(regexp_replace(a.alt, '^.* ', '')) >= c_prefix_min_len then ':*' else '' end
             || ')', ' | ')) as q
      from alts a group by a.i, a.t
  ), hits as (
    select v.id, count(distinct tq.i) as n
      from vecs v join tq on (v.vec @@ tq.q
        or v.tickers @> jsonb_build_array(jsonb_build_object('symbol', upper(tq.t)))
        or v.macro   @> jsonb_build_array(jsonb_build_object('series_id', upper(tq.t))))
     group by v.id
  ), scored as (
    select v.id, v.importance, v.sort_at,
           round((v.trend
             + v_h * ln(c_term_bonus) / ln(2::numeric) * (h.n - 1)
             + case when v_uid is null then 0 else
                 v_h * ln(1 + c_personal_weight * least(greatest(core.taste_hours(v_taste, v.category,
                   coalesce(v.event_type, v.kind), case when v.kind = 'data' then 'fred' else core.source_key_of(v.kind, v.id) end), 0)
                   / greatest(v_cap, 0.01), 1)) / ln(2::numeric) end)::numeric, 6) as k,
           row_number() over (partition by v.dedupe_key order by v.sort_at desc, v.id desc) as dn
      from vecs v join hits h on h.id = v.id
  ), page as (
    select s.id, s.k, s.importance, s.sort_at from scored s
     where s.dn = 1 and (s.k, s.importance, s.sort_at, s.id) < (v_key, v_imp, v_sort, v_id)
     order by s.k desc, s.importance desc, s.sort_at desc, s.id desc
     limit v_limit + 1
  ), chosen as (
    select * from page order by k desc, importance desc, sort_at desc, id desc limit v_limit
  )
  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb),
         case when (select count(*) from page) > v_limit then
           (select ch.k::text || '|' || ch.id::text
                   || '|' || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   || '|' || v_gen::text || '|' || ch.importance::text
                   || '|' || to_char(ch.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              from chosen ch order by ch.k asc, ch.importance asc, ch.sort_at asc, ch.id asc limit 1) end
    into v_rows, v_next
    from jsonb_array_elements(core.cards_json(
           (select array_agg(id order by k desc, importance desc, sort_at desc, id desc) from chosen), null)) with ordinality x(c, o);
  return jsonb_build_object('items', coalesce(v_rows, '[]'::jsonb), 'next_cursor', v_next);
end; $$;
revoke all on function api.search(text, text, int) from public;
grant execute on function api.search(text, text, int) to anon, authenticated;

notify pgrst, 'reload schema';

-- HOW TO CHECK: paste after 20261018010000_algo_v2.sql ("Success. No rows returned"; a second run
-- gives the same), then run supabase/tests/search_v2_check.sql and the older *_check.sql files.
-- Undo: re-run section D of 20261018010000_algo_v2.sql (the old api.search); the helpers and
-- core.search_synonyms can stay (nothing else uses them).
