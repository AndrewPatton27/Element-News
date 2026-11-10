-- Search v7: v6's ranking over an indexed candidate set, so search scales to ~100x the cards (SQL scale audit,
-- 2026-11-09). NOT applied. Replaces only api.search (same signature, response, cursor format, grants). Must run
-- after 20261120000000_search_v6.sql (whose body it starts from). Idempotent.
--
-- Why: v6 scanned the 2000 highest-ranked published cards (c_scan_cap) and rebuilt every card's text, three
-- tsvectors and the typo word list (similarity over every distinct word of those 2000 cards) on every request. At
-- 100x the cards that cap hides every older relevant card (a rare company or a typo older than about a week finds
-- nothing), and the per-request work stays at the cap.
--
-- What v7 does:
--   1. core.search_docs: one row per card with the texts v6 built per request (headline, visible text, detail text,
--      source/topic metadata, the topic/story-type text), their english tsvectors, and words = the distinct words
--      (split on non-letters/digits, exactly like v6) of the visible, detail and metadata text, GIN-indexed. Kept
--      current by triggers on core.blurbs (headline, body, tickers, macro, detail, category, event_type) and
--      core.blurb_sources (any change). core.search_docs_refresh(ids) rebuilds rows (null = all), e.g. after a
--      topic is renamed or a number series gets a new label (both rare; the label and topic name are copied).
--   2. core.search_words: the distinct words of the visible and detail text of every card ever indexed (never
--      pruned; a word that no longer occurs matches nothing), with its length, english lexemes and trigrams. The
--      typo list per query word (5+ letters) comes from here: with pg_trgm (Supabase) through a pg_trgm GIN index
--      (word % term, then v6's similarity >= 0.4); without it (PGlite) through a length window, a trigram-overlap
--      bound that every word within the allowed edit distance meets (1 edit removes at most 3 of the term's
--      distinct trigrams), then v6's edit-distance test. Same typo matches as v6.
--   3. Candidates: the cards whose words contain any word that can give a query word evidence in v6 (the word,
--      the word + "s", vocabulary words starting with it, vocabulary words with the same english stem, its
--      synonyms, its typo words, and for "fed" the words of "federal reserve" / "fomc"), plus cards surely tagged
--      (>= search_company_min_confidence) with a company whose sector or industry names the word. That is a
--      superset of every card v6 could score above 0. v6's scoring (evidence rules, gate, IDF, headline weight,
--      micro penalty, company tier, prior, dedupe, keyset) then runs unchanged on the search_pool_cap (2000)
--      highest-ranked candidates, so the cap now applies to matching cards, not to all cards.
--   4. IDF's N (number of scanned cards) = min(eligible cards, search_pool_cap), which is what v6 counted.
-- Result: identical to v6 while there are at most 2000 eligible cards (today: about 300); above that, older
-- matching cards are found. Setting: core.rank_params search_pool_cap 2000 (> 0). Checked by
-- tests/search_v7_check.sql (and every older search check).

insert into core.rank_params (key, value) values
  ('search_pool_cap', 2000)    -- search scores at most this many matching cards (highest-ranked first)
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_search_v7_range;
alter table core.rank_params add constraint rank_params_search_v7_range
  check (key <> 'search_pool_cap' or value > 0);

-- ---------- 1. stored search documents ----------
create table if not exists core.search_docs (
  blurb_id   uuid primary key references core.blurbs (id) on delete cascade,
  hl         text not null,
  vis        text not null,
  deep       text not null,
  meta0      text not null,
  tmeta      text not null,
  words      text[] not null,
  tv         tsvector not null,
  td         tsvector not null,
  th         tsvector not null,
  updated_at timestamptz not null default now()
);
create index if not exists search_docs_words_gin on core.search_docs using gin (words);
alter table core.search_docs enable row level security;   -- no policies: private
revoke all on core.search_docs from anon, authenticated;

-- ---------- 2. vocabulary for typo, prefix and stem expansion ----------
create table if not exists core.search_words (
  word text collate "C" primary key,
  len  int not null,
  lex  text[] not null,     -- english lexemes of the word (to_tsvector('english', word))
  tri  text[] not null      -- distinct pg_trgm-style trigrams ('  w', ..., 'd ')
);
create index if not exists search_words_lex_gin on core.search_words using gin (lex);
create index if not exists search_words_tri_gin on core.search_words using gin (tri);
create index if not exists search_words_len_idx on core.search_words (len);
alter table core.search_words enable row level security;
revoke all on core.search_words from anon, authenticated;

create or replace function core.search_word_trigrams(p text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct g order by g), '{}'::text[])
  from (select substr('  ' || p || ' ', i, 3) g from generate_series(1, char_length(coalesce(p, '')) + 1) i) s
  where coalesce(p, '') <> ''
$$;
revoke all on function core.search_word_trigrams(text) from public, anon, authenticated;

-- Rebuilds the documents of the given cards (null = every card) and adds their words to the vocabulary.
-- The text expressions are v6's (20261120000000_search_v6.sql pool0), character for character.
create or replace function core.search_docs_refresh(p_ids uuid[])
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v_n int;
begin
  delete from core.search_docs d
   where p_ids is not null and d.blurb_id = any (p_ids)
     and not exists (select 1 from core.blurbs b where b.id = d.blurb_id);
  with src as (
    select b.id,
      lower(b.headline) hl,
      lower(concat_ws(' ',b.headline,b.body,
       (select string_agg(concat_ws(' ',t->>'symbol',t->>'name'),' ') from jsonb_array_elements(b.tickers)t),
       (select string_agg(concat_ws(' ',m->>'series_id',ms.label),' ') from jsonb_array_elements(b.macro)m left join core.macro_series ms on ms.series_id=m->>'series_id'))) vis,
      lower(coalesce((select string_agg(v #>> '{}',' ') from jsonb_path_query(coalesce(b.detail,'{}'::jsonb),'strict $.**') v where jsonb_typeof(v)='string'),'')) deep,
      lower(concat_ws(' ',(select string_agg(s.name,' ') from core.blurb_sources s where s.blurb_id=b.id),
        (select c2.name from core.categories c2 where c2.slug=b.category),b.category,replace(coalesce(b.event_type,''),'_',' '))) meta0,
      lower(concat_ws(' ',(select c2.name from core.categories c2 where c2.slug=b.category),b.category,replace(coalesce(b.event_type,''),'_',' '))) tmeta
    from core.blurbs b
    where p_ids is null or b.id = any (p_ids)
  ), up as (
    insert into core.search_docs (blurb_id, hl, vis, deep, meta0, tmeta, words, tv, td, th, updated_at)
    select s.id, s.hl, s.vis, s.deep, s.meta0, s.tmeta,
           array(select distinct w from regexp_split_to_table(s.vis || ' ' || s.deep || ' ' || s.meta0, '[^[:alnum:]]+') w where w <> ''),
           to_tsvector('english', s.vis), to_tsvector('english', s.deep), to_tsvector('english', s.hl), now()
    from src s
    on conflict (blurb_id) do update set hl = excluded.hl, vis = excluded.vis, deep = excluded.deep, meta0 = excluded.meta0,
      tmeta = excluded.tmeta, words = excluded.words, tv = excluded.tv, td = excluded.td, th = excluded.th, updated_at = excluded.updated_at
    returning 1
  ), voc as (
    insert into core.search_words (word, len, lex, tri)
    select w, char_length(w), tsvector_to_array(to_tsvector('english', w)), core.search_word_trigrams(w)
    from (select distinct w from src s cross join lateral regexp_split_to_table(s.vis || ' ' || s.deep, '[^[:alnum:]]+') w where w <> '') x
    on conflict (word) do nothing
    returning 1
  )
  select (select count(*) from up) into v_n;
  return v_n;
end $$;
revoke all on function core.search_docs_refresh(uuid[]) from public, anon, authenticated;
grant execute on function core.search_docs_refresh(uuid[]) to service_role;

create or replace function core.search_docs_blurbs_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.search_docs_refresh(array[new.id]);
  return null;
end $$;
create or replace function core.search_docs_sources_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform core.search_docs_refresh(array[old.blurb_id]); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.blurb_id is distinct from old.blurb_id) then
    perform core.search_docs_refresh(array[new.blurb_id]);
  end if;
  return null;
end $$;
revoke all on function core.search_docs_blurbs_trg(), core.search_docs_sources_trg() from public, anon, authenticated;

drop trigger if exists blurbs_search_docs on core.blurbs;
create trigger blurbs_search_docs after insert or update of headline, body, tickers, macro, detail, category, event_type on core.blurbs
  for each row execute function core.search_docs_blurbs_trg();
drop trigger if exists blurb_sources_search_docs on core.blurb_sources;
create trigger blurb_sources_search_docs after insert or update or delete on core.blurb_sources
  for each row execute function core.search_docs_sources_trg();

-- backfill (idempotent)
select core.search_docs_refresh(null);

-- ---------- typo words of one query word: v6's typo test over the vocabulary, index-assisted ----------
do $$
declare v_nsp text;
begin
  select n.nspname into v_nsp from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if v_nsp is not null and core.search_typo_mode() = 'pg_trgm' then
    execute format('create index if not exists search_words_trgm_gin on core.search_words using gin (word %I.gin_trgm_ops)', v_nsp);
    -- word %% term uses the index (similarity >= 0.3, a superset of the 0.4 that core.search_typo_ok requires)
    execute format($f$
      create or replace function core.search_typo_words(p_term text)
      returns text[] language sql stable set search_path = '' set pg_trgm.similarity_threshold = 0.3 as
      $b$ select coalesce(array_agg(w.word order by w.word), '{}'::text[]) from core.search_words w
          where w.word operator(%I.%%) p_term and w.word <> p_term and core.search_typo_ok(p_term, w.word) $b$ $f$, v_nsp);
  else
    -- edit distance <= k (k = 1, 2 from 8 letters): length within k, and at least (distinct term trigrams - 3k)
    -- shared trigrams (each edit removes at most 3 of them); the overlap test is skipped when that bound is < 1
    execute $f$
      create or replace function core.search_typo_words(p_term text)
      returns text[] language sql stable set search_path = '' as
      $b$ with t as (select core.search_word_trigrams(p_term) tri, char_length(p_term) len,
                            case when char_length(p_term) >= 8 then 2 else 1 end k)
          select coalesce(array_agg(w.word order by w.word), '{}'::text[]) from core.search_words w cross join t
          where w.len between t.len - t.k and t.len + t.k and w.word <> p_term
            and (cardinality(t.tri) - 3 * t.k < 1
                 or (w.tri && t.tri and (select count(*) from unnest(w.tri) x where x = any (t.tri)) >= cardinality(t.tri) - 3 * t.k))
            and core.search_typo_ok(p_term, w.word) $b$ $f$;
  end if;
end $$;
revoke all on function core.search_typo_words(text) from public, anon, authenticated;

-- ---------- api.search v7 ----------
create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_min_quality constant numeric := 0.5;
  c_detail_weight constant numeric := 0.2;      -- settings.md: search_detail_weight
  c_visible_tier constant numeric := 10;        -- visible match first (the rest of the key is 0..1)
  c_company_tier constant numeric := 20;        -- a card tagged with the company the query names comes before both
  c_company_min constant numeric := 0.95;       -- query names the company: ticker (1) or exact name / alias (0.95)
  c_max_terms constant int := 6;
  c_typo_min_len constant int := 5;
  c_prefix_min_len constant int := 3;
  c_rate_noise constant text := '(^|[^[:alnum:]])(unemployment|jobless|annual|growth|participation|vacancy|savings|exchange|birth|death|tax)[[:space:]]+rates?([^[:alnum:]]|$)';
  c_stop constant text[] := array['the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be','it','its','as','from','that','this','what','how','why','who','about','into'];
  v_uid uuid := auth.uid(); v_norm text; v_terms text[]; v_nterms int; v_limit int := least(greatest(coalesce(p_limit,20),1),30);
  v_key numeric := 1e30; v_imp numeric := 1e30; v_sort timestamptz := 'infinity';
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_gen bigint;
  v_h numeric; v_cap numeric; v_w numeric; v_aw numeric; v_now_h numeric;
  v_hw numeric; v_mpen numeric; v_cmin numeric; v_mcats text[]; v_idf boolean;
  v_pcap int; v_nall numeric; v_lk boolean;
  v_taste jsonb; v_rows jsonb; v_next text; v_co text[];
  v_empty constant jsonb := jsonb_build_object('items','[]'::jsonb,'next_cursor',null);
begin
  v_norm := btrim(regexp_replace(lower(left(coalesce(p_q,''),80)), '[^[:alnum:]]+', ' ', 'g'));
  if char_length(v_norm)<2 then return v_empty; end if;
  select coalesce(array_agg(t order by o),'{}') into v_terms from
    (select x.t,min(x.o) o from regexp_split_to_table(v_norm,' ') with ordinality x(t,o)
     where char_length(x.t)>=2 and not(x.t=any(c_stop)) group by x.t order by min(x.o) limit c_max_terms) s;
  if p_cursor is not null then begin
    v_key:=split_part(p_cursor,'|',1)::numeric; v_id:=split_part(p_cursor,'|',2)::uuid;
    v_asof:=least(coalesce(nullif(split_part(p_cursor,'|',3),'')::timestamptz,v_asof),v_asof);
    v_gen:=nullif(split_part(p_cursor,'|',4),'')::bigint;
    v_imp:=coalesce(nullif(split_part(p_cursor,'|',5),'')::numeric,1e30);
    v_sort:=coalesce(nullif(split_part(p_cursor,'|',6),'')::timestamptz,'infinity');
  exception when others then raise exception 'invalid_cursor' using errcode='PT422'; end; end if;
  v_nterms := cardinality(v_terms);
  if v_nterms=0 then return v_empty; end if;
  if v_gen is null or not exists(select 1 from core.trend_generations where gen=v_gen) then select coalesce(max(gen),0) into v_gen from core.trend_generations; end if;
  select coalesce(max(value) filter(where key='half_life_hours'),8),
         coalesce(max(value) filter(where key='affinity_cap_hours'),4),
         coalesce(max(value) filter(where key='search_prior_weight'),0.15),
         coalesce(max(value) filter(where key='search_prior_affinity_share'),0.5),
         coalesce(max(value) filter(where key='search_headline_weight'),0.15),
         coalesce(max(value) filter(where key='search_micro_penalty'),0.5),
         coalesce(max(value) filter(where key='search_company_min_confidence'),0.75),
         coalesce(max(value) filter(where key='search_idf_weighting'),1)=1,
         greatest(coalesce(max(value) filter(where key='search_pool_cap'),2000),1)::int
    into v_h,v_cap,v_w,v_aw,v_hw,v_mpen,v_cmin,v_idf,v_pcap from core.rank_params;
  v_h := greatest(v_h,0.5); v_w := least(greatest(v_w,0),0.5); v_aw := least(greatest(v_aw,0),1);
  v_hw := least(greatest(v_hw,0),1); v_mpen := least(greatest(v_mpen,0),1);
  v_mcats := array(select substr(key,16) from core.rank_params where starts_with(key,'micro_category:') and value>0);
  v_now_h := extract(epoch from v_asof)::numeric/3600;
  select linkout_cards into v_lk from core.app_config where id;
  -- v7: IDF's N = the cards v6 scanned = min(eligible cards, cap); counted with a LIMIT, so bounded
  select count(*) into v_nall from (
    select 1 from core.blurbs b
    where b.status='published' and b.published_at<=v_asof and (b.kind<>'link_out' or coalesce(v_lk,false))
      and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
    limit v_pcap) n;
  if v_uid is not null then
    v_taste:=core.user_taste(v_uid,v_asof);
  end if;
  -- Companies the whole query names (20261115000000_companies.sql). Any error there: no company tier.
  begin
    select coalesce(array_agg(cq.ticker),'{}') into v_co from core.company_query_scores(p_q) cq where cq.score>=c_company_min;
  exception when others then v_co:='{}'; end;
  with cfg as (select linkout_cards from core.app_config where id),
  -- per query word, once: tsquery, synonym expression and words, typo words and expression
  terms0 as materialized (
    select t.t, plainto_tsquery('english',t.t) tq,
      (select '(^|[^[:alnum:]])('||string_agg(distinct replace(s2.word,' ','[[:space:]]+'),'|')||')([^[:alnum:]]|$)'
         from core.search_synonyms s1 join core.search_synonyms s2 on s2.grp=s1.grp
        where (s1.word=t.t or s1.word||'s'=t.t or s1.word=t.t||'s') and s2.word<>t.t
          and (t.t not in ('fed','federal','federl') or s2.word in ('federal reserve','fomc'))) syn_re,
      array(select distinct regexp_split_to_table(s2.word,' ')
         from core.search_synonyms s1 join core.search_synonyms s2 on s2.grp=s1.grp
        where (s1.word=t.t or s1.word||'s'=t.t or s1.word=t.t||'s') and s2.word<>t.t
          and (t.t not in ('fed','federal','federl') or s2.word in ('federal reserve','fomc'))) syn_words,
      case when char_length(t.t)>=c_typo_min_len then core.search_typo_words(t.t) else '{}'::text[] end typo_words
    from unnest(v_terms) t
  ), terms as materialized (
    select t0.*, case when cardinality(t0.typo_words)>0 then '(^|[^[:alnum:]])('||array_to_string(t0.typo_words,'|')||')([^[:alnum:]]|$)' end typo_re
    from terms0 t0
  ),
  -- v7: every word that can give a query word evidence in v6 (see the header), then the candidate cards
  cw as materialized (
    select coalesce(array_agg(distinct x),'{}'::text[]) ws from (
      select t.t x from terms t
      union all select t.t||'s' from terms t
      union all select w.word from terms t join core.search_words w
        on w.word > (t.t collate "C") and w.word < ((t.t || chr(1114111)) collate "C") and starts_with(w.word, t.t)
      union all select w.word from terms t join core.search_words w on w.lex && tsvector_to_array(to_tsvector('english', t.t))
      union all select unnest(t.syn_words) from terms t
      union all select unnest(t.typo_words) from terms t
      union all select unnest(array['fed','federal','reserve','fomc']) from terms t where t.t in ('fed','federal','federl')
    ) s
  ), cotk as materialized (
    select coalesce(array_agg(co.ticker),'{}'::text[]) tk from core.companies co
    where exists (select 1 from terms t where lower(concat_ws(' ',co.sector,co.industry)) ~ ('(^|[^[:alnum:]])'||t.t||'s?([^[:alnum:]]|$)'))
  ), cands as (
    select d.blurb_id id from core.search_docs d where d.words && (select ws from cw)
    union
    select cc.blurb_id from cotk join core.card_companies cc on cc.ticker = any (cotk.tk) where cc.confidence>=v_cmin
  ),
  pool0 as materialized (
    select b.id,b.kind,b.category,b.event_type,b.importance,b.sort_at,b.dedupe_key,b.tickers,b.macro,
      b.rank_score+coalesce(tb.boost,0) trend,
      d.hl, d.vis, d.deep, d.meta0, d.tmeta, d.tv, d.td, d.th,
      -- v6: sector and industry of the companies the card is surely about
      lower(coalesce((select string_agg(concat_ws(' ',co.sector,co.industry),' ') from core.card_companies cc
        join core.companies co on co.ticker=cc.ticker where cc.blurb_id=b.id and cc.confidence>=v_cmin),'')) cometa
    from cands c join core.blurbs b on b.id=c.id join core.search_docs d on d.blurb_id=b.id
    cross join cfg left join core.trend_boosts tb on tb.gen=v_gen and tb.blurb_id=b.id
    where b.status='published' and b.published_at<=v_asof and (b.kind<>'link_out' or cfg.linkout_cards)
      and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
    order by b.rank_score desc,b.id desc limit v_pcap
  ), pool as materialized (
    select p0.*, p0.vis||' '||p0.deep content, p0.meta0||' '||p0.cometa meta
    from pool0 p0
  ),
  field_scores as (
    -- v6 evidence rules, unchanged: visible text (v), detail text (d), headline (h); interest-rate noise blanked (z.x)
    select p.id, t.t, f.f, greatest(
      case when z.x ~ ('(^|[^[:alnum:]])'||t.t||'([^[:alnum:]]|$)')
             and t.t not in ('fed','federal','federl') then 1.0
           when t.t='federal' and z.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)' then 1.0
           when t.t='fed' and (z.x ~ '(^|[^[:alnum:]])fed([^[:alnum:]]|$)'
             or z.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)'
             or z.x ~ '(^|[^[:alnum:]])fomc([^[:alnum:]]|$)') then 1.0 else 0 end,
      case when ((case when z.blanked then to_tsvector('english',z.x) else f.tv end) @@ t.tq
             or z.x ~ ('(^|[^[:alnum:]])'||t.t||'[[:alnum:]]{1,}([^[:alnum:]]|$)'))
           and t.t not in ('fed','federal','federl') then 0.8
           when f.f='v' and t.t in ('aapl','msft','ba') and p.tickers @> jsonb_build_array(jsonb_build_object('symbol',upper(t.t))) then 1.0
           when f.f='v' and p.macro @> jsonb_build_array(jsonb_build_object('series_id',upper(t.t))) then 1.0 else 0 end,
      case when t.syn_re is not null and z.x ~ t.syn_re then 0.6 else 0 end,
      case when t.typo_re is not null and z.x ~ t.typo_re
            and (t.t not in ('federl','federal') or p.content ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)') then 0.5 else 0 end,
      case when f.f='v' and p.meta ~ ('(^|[^[:alnum:]])'||t.t||'s?([^[:alnum:]]|$)') then 0.25 else 0 end
    ) q
    from pool p cross join terms t cross join lateral (values ('v',p.vis,p.tv),('d',p.deep,p.td),('h',p.hl,p.th)) f(f,x,tv)
    cross join lateral (select case when t.t in ('rate','rates','interest') and f.x ~ c_rate_noise
                                    then regexp_replace(f.x, c_rate_noise, ' ', 'g') else f.x end x,
                               t.t in ('rate','rates','interest') and f.x ~ c_rate_noise blanked) z
  ), term_scores as (
    select id, t, max(q) filter (where f='v') qv, max(q) filter (where f='d') qd, max(q) filter (where f='h') qh
    from field_scores group by id, t
  ), term_weights as (
    -- v6 IDF; v7: N = min(eligible cards, search_pool_cap) (v_nall), the cards v6 scanned
    select ts.t, case when v_idf then ln(1 + v_nall / (1 + count(*) filter (where greatest(ts.qv,ts.qd)>0))) else 1 end w
    from term_scores ts group by ts.t
    having count(*) filter (where greatest(ts.qv,ts.qd)>0) > 0
  ), matches as (
    select ts.id, sum(greatest(ts.qv,ts.qd)) quality,
      sum(coalesce(tw.w,0)*((1-v_hw)*greatest(ts.qv, c_detail_weight*ts.qd) + v_hw*coalesce(ts.qh,0)))
        / greatest((select sum(w) from term_weights),0.000001) relevance,
      bool_or(coalesce(ts.qv,0)>0) visible
    from term_scores ts left join term_weights tw on tw.t=ts.t group by ts.id
    having sum(greatest(ts.qv,ts.qd))>=c_min_quality
  ), scored as (
    select p.id,p.importance,p.sort_at,
      round((case when m.visible then c_visible_tier else 0 end
        + case when cardinality(v_co)>0 and exists(select 1 from core.card_companies cc where cc.blurb_id=p.id and cc.ticker=any(v_co) and cc.confidence>=v_cmin) then c_company_tier else 0 end
        + (1-v_w)*least(round(m.relevance,4),1)
        + v_w*case when v_uid is null then x.rp
            else (1-v_aw)*x.rp + v_aw*(least(greatest(
              coalesce(core.taste_hours(v_taste,p.category,coalesce(p.event_type,p.kind),case when p.kind='data' then 'fred' else core.source_key_of(p.kind,p.id) end),0)
                / greatest(v_cap,0.01), -1), 1) + 1) / 2 end
        - case when p.category=any(v_mcats)
                and not exists(select 1 from unnest(v_terms) qt where p.tmeta ~('(^|[^[:alnum:]])'||qt||'s?([^[:alnum:]]|$)'))
               then v_mpen else 0 end)::numeric, 9) k,
      row_number() over(partition by p.dedupe_key order by p.sort_at desc,p.id desc) dn
    from pool p join matches m on m.id=p.id
    cross join lateral (select power(2::numeric, least(greatest((p.trend - v_now_h)/v_h, -40), 40)) e) y
    cross join lateral (select y.e/(1+y.e) rp) x
  ), page as (select s.id,s.k,s.importance,s.sort_at from scored s where s.dn=1 and (s.k,s.importance,s.sort_at,s.id)<(v_key,v_imp,v_sort,v_id) order by s.k desc,s.importance desc,s.sort_at desc,s.id desc limit v_limit+1),
  chosen as (select * from page order by k desc,importance desc,sort_at desc,id desc limit v_limit)
  select coalesce(jsonb_agg(x.c-'my_reaction' order by x.o),'[]'::jsonb),
    case when (select count(*) from page)>v_limit then (select ch.k::text||'|'||ch.id::text||'|'||to_char(v_asof at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'|'||v_gen::text||'|'||ch.importance::text||'|'||to_char(ch.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from chosen ch order by ch.k asc,ch.importance asc,ch.sort_at asc,ch.id asc limit 1) end
  into v_rows,v_next from jsonb_array_elements(core.cards_json((select array_agg(id order by k desc,importance desc,sort_at desc,id desc) from chosen),null)) with ordinality x(c,o);
  return jsonb_build_object('items',coalesce(v_rows,'[]'::jsonb),'next_cursor',v_next);
end; $$;
revoke all on function api.search(text,text,int) from public;
grant execute on function api.search(text,text,int) to anon,authenticated;
notify pgrst,'reload schema';
