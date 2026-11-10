-- Search v6: faster, and three relevance fixes found by the search audit (2026-11-09).
-- Replaces only api.search (same signature, response, cursor format, grants). Must run after
-- 20261115000100_search_company_boost.sql (whose body it starts from). Idempotent. NOT applied.
--
-- Why (measured on the live project, anonymous read-only calls, 287 published cards):
--   * Speed: typical searches took 1.2-2.9 s and a 3-word query ("quarterly revenue record") hit the 3 s
--     statement timeout (HTTP 500, code 57014). The cost was per card x per query word: a typo check called on
--     every word of every card, a synonym join and two to_tsvector calls per card and word. v6 does that work
--     once per request: the english tsvectors once per card, the synonym words once per query word (as one
--     regular expression), and the typo check once per DISTINCT word of the scanned cards (a typo word list per
--     query word, then one regular expression per card). Matching results are the same as v5.
--   * "amazon" / "walmart": recalls of small sellers whose summary says "sold on Amazon" are tagged with the
--     retailer at low confidence (0.6, an ambiguous name next to a business word). v5 gave every tagged card the
--     +20 company tier, so the top 5 for "amazon" were third-party recalls. v6 gives the tier only to tags with
--     confidence >= search_company_min_confidence (0.75: ticker, filing, alias, or a name with a company cue).
--   * Headline matches: a word in the headline now counts more than the same word only in the summary
--     (search_headline_weight 0.15 of the per-word relevance comes from the headline; 0.3 measured worse:
--     "interest rates" put "Housing starts ... (annual rate)" first).
--   * Macro/finance first (standing content rule): a card of a micro topic (core.rank_params
--     'micro_category:<slug>' > 0: Recalls & Safety, Science & Space) loses search_micro_penalty (0.5) of the
--     0..1 part of the key unless a query word names its topic or story type ("recall", "safety", "science",
--     "quake"...). Such cards are still found; they come after macro/finance matches of similar strength
--     ("housing" no longer lists recalls of products with a plastic housing before Housing starts).
--   * Company industry words: a card tagged (>= 0.75) with a company also matches that company's sector and
--     industry words as metadata (0.25, whole word, a plural "s" allowed), so "bank earnings" finds bank results
--     whose text never says "bank". Metadata alone still cannot pass the 0.5 gate with one word.
--
-- Order key (higher first), unchanged in form:
--   10 x visible + 20 x company tier + (1 - w) x min(relevance / words, 1) + w x prior - micro penalty
--   per-word relevance = (1 - hw) x max(visible quality, 0.2 x detail quality) + hw x headline quality
--   (hw = search_headline_weight). The 0.5 quality gate, the 2000-card scan cap, the dedupe, the cursor
--   ("key|id|asof|gen|importance|sort_at"), security definer and the empty search_path are unchanged.
-- Settings (core.rank_params, range CHECK): search_headline_weight 0.15 (0..1), search_micro_penalty 0.5 (0..1),
-- search_company_min_confidence 0.75 (0..1). Checked by tests/search_v6_check.sql.

insert into core.rank_params (key, value) values
  ('search_headline_weight', 0.15),          -- share of per-word relevance that comes from the headline
  ('search_micro_penalty', 0.5),            -- micro-topic cards drop this much unless the query names the topic
  ('search_company_min_confidence', 0.75)   -- company tier only for tags at least this sure
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_search_v6_range;
alter table core.rank_params add constraint rank_params_search_v6_range
  check ((key not in ('search_headline_weight', 'search_micro_penalty', 'search_company_min_confidence'))
         or (value >= 0 and value <= 1));

create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_min_quality constant numeric := 0.5;
  c_detail_weight constant numeric := 0.2;      -- settings.md: search_detail_weight
  c_visible_tier constant numeric := 10;        -- visible match first (the rest of the key is 0..1)
  c_company_tier constant numeric := 20;        -- a card tagged with the company the query names comes before both
  c_company_min constant numeric := 0.95;       -- query names the company: ticker (1) or exact name / alias (0.95)
  c_max_terms constant int := 6;
  c_scan_cap constant int := 2000;
  c_typo_min_len constant int := 5;
  c_prefix_min_len constant int := 3;
  c_stop constant text[] := array['the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be','it','its','as','from','that','this','what','how','why','who','about','into'];
  v_uid uuid := auth.uid(); v_norm text; v_terms text[]; v_nterms int; v_limit int := least(greatest(coalesce(p_limit,20),1),30);
  v_key numeric := 1e30; v_imp numeric := 1e30; v_sort timestamptz := 'infinity';
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_gen bigint;
  v_h numeric; v_cap numeric; v_w numeric; v_aw numeric; v_now_h numeric;
  v_hw numeric; v_mpen numeric; v_cmin numeric; v_mcats text[]; v_edit boolean;
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
         coalesce(max(value) filter(where key='search_company_min_confidence'),0.75)
    into v_h,v_cap,v_w,v_aw,v_hw,v_mpen,v_cmin from core.rank_params;
  v_h := greatest(v_h,0.5); v_w := least(greatest(v_w,0),0.5); v_aw := least(greatest(v_aw,0),1);
  v_hw := least(greatest(v_hw,0),1); v_mpen := least(greatest(v_mpen,0),1);
  v_mcats := array(select substr(key,16) from core.rank_params where starts_with(key,'micro_category:') and value>0);
  v_now_h := extract(epoch from v_asof)::numeric/3600;
  -- edit-distance typo mode (no pg_trgm, e.g. PGlite): a word whose length differs by more than 2 can never pass
  v_edit := core.search_typo_mode() <> 'pg_trgm';
  if v_uid is not null then
    v_taste:=core.user_taste(v_uid,v_asof);
  end if;
  -- Companies the whole query names (20261115000000_companies.sql). Any error there: no company tier.
  begin
    select coalesce(array_agg(cq.ticker),'{}') into v_co from core.company_query_scores(p_q) cq where cq.score>=c_company_min;
  exception when others then v_co:='{}'; end;
  with cfg as (select linkout_cards from core.app_config where id),
  pool0 as materialized (
    select b.id,b.kind,b.category,b.event_type,b.importance,b.sort_at,b.dedupe_key,b.tickers,b.macro,
      b.rank_score+coalesce(tb.boost,0) trend,
      lower(b.headline) hl,
      -- what the card shows: headline, summary, ticker names, number labels
      lower(concat_ws(' ',b.headline,b.body,
       (select string_agg(concat_ws(' ',t->>'symbol',t->>'name'),' ') from jsonb_array_elements(b.tickers)t),
       (select string_agg(concat_ws(' ',m->>'series_id',ms.label),' ') from jsonb_array_elements(b.macro)m left join core.macro_series ms on ms.series_id=m->>'series_id'))) vis,
      -- only behind "Read more": detail paragraphs and key points
      lower(coalesce((select string_agg(v #>> '{}',' ') from jsonb_path_query(coalesce(b.detail,'{}'::jsonb),'strict $.**') v where jsonb_typeof(v)='string'),'')) deep,
      lower(concat_ws(' ',(select string_agg(s.name,' ') from core.blurb_sources s where s.blurb_id=b.id),
        (select c2.name from core.categories c2 where c2.slug=b.category),b.category,replace(coalesce(b.event_type,''),'_',' '))) meta0,
      -- v6: the card's topic and story type only (for the micro penalty: does the query name them?)
      lower(concat_ws(' ',(select c2.name from core.categories c2 where c2.slug=b.category),b.category,replace(coalesce(b.event_type,''),'_',' '))) tmeta,
      -- v6: sector and industry of the companies the card is surely about
      lower(coalesce((select string_agg(concat_ws(' ',co.sector,co.industry),' ') from core.card_companies cc
        join core.companies co on co.ticker=cc.ticker where cc.blurb_id=b.id and cc.confidence>=v_cmin),'')) cometa
    from core.blurbs b cross join cfg c left join core.trend_boosts tb on tb.gen=v_gen and tb.blurb_id=b.id
    where b.status='published' and b.published_at<=v_asof and (b.kind<>'link_out' or c.linkout_cards)
      and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
    order by b.rank_score desc,b.id desc limit c_scan_cap
  ), pool as materialized (
    select p0.*, p0.vis||' '||p0.deep content, p0.meta0||' '||p0.cometa meta,
      to_tsvector('english',p0.vis) tv, to_tsvector('english',p0.deep) td, to_tsvector('english',p0.hl) th
    from pool0 p0
  ),
  -- v6: per query word, once: tsquery, synonym expression, typo-word expression
  vocab as materialized (
    select distinct w from pool p cross join lateral regexp_split_to_table(p.content,'[^[:alnum:]]+') w where w<>''
  ),
  terms as materialized (
    select t.t, plainto_tsquery('english',t.t) tq,
      (select '(^|[^[:alnum:]])('||string_agg(distinct replace(s2.word,' ','[[:space:]]+'),'|')||')([^[:alnum:]]|$)'
         from core.search_synonyms s1 join core.search_synonyms s2 on s2.grp=s1.grp
        where (s1.word=t.t or s1.word||'s'=t.t or s1.word=t.t||'s') and s2.word<>t.t
          and (t.t not in ('fed','federal','federl') or s2.word in ('federal reserve','fomc'))) syn_re,
      case when char_length(t.t)>=c_typo_min_len then
        (select '(^|[^[:alnum:]])('||string_agg(vo.w,'|')||')([^[:alnum:]]|$)' from vocab vo
          where vo.w<>t.t and (not v_edit or abs(char_length(vo.w)-char_length(t.t))<=2) and core.search_typo_ok(t.t,vo.w)) end typo_re
    from unnest(v_terms) t
  ),
  field_scores as (
    -- v4 evidence rules (same results), visible text (v), detail text (d) and, new, the headline alone (h)
    select p.id, t.t, f.f, greatest(
      case when f.x ~ ('(^|[^[:alnum:]])'||t.t||'([^[:alnum:]]|$)')
             and t.t not in ('fed','federal','federl') then 1.0
           when t.t='federal' and f.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)' then 1.0
           when t.t='fed' and (f.x ~ '(^|[^[:alnum:]])fed([^[:alnum:]]|$)'
             or f.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)'
             or f.x ~ '(^|[^[:alnum:]])fomc([^[:alnum:]]|$)') then 1.0 else 0 end,
      case when (f.tv @@ t.tq
             or f.x ~ ('(^|[^[:alnum:]])'||t.t||'[[:alnum:]]{1,}([^[:alnum:]]|$)'))
           and t.t not in ('fed','federal','federl') then 0.8
           when f.f='v' and t.t in ('aapl','msft','ba') and p.tickers @> jsonb_build_array(jsonb_build_object('symbol',upper(t.t))) then 1.0
           when f.f='v' and p.macro @> jsonb_build_array(jsonb_build_object('series_id',upper(t.t))) then 1.0 else 0 end,
      case when t.syn_re is not null and f.x ~ t.syn_re then 0.6 else 0 end,
      case when t.typo_re is not null and f.x ~ t.typo_re
            and (t.t not in ('federl','federal') or p.content ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)') then 0.5 else 0 end,
      case when f.f='v' and p.meta ~ ('(^|[^[:alnum:]])'||t.t||'s?([^[:alnum:]]|$)') then 0.25 else 0 end
    ) q
    from pool p cross join terms t cross join lateral (values ('v',p.vis,p.tv),('d',p.deep,p.td),('h',p.hl,p.th)) f(f,x,tv)
  ), term_scores as (
    select id, t, max(q) filter (where f='v') qv, max(q) filter (where f='d') qd, max(q) filter (where f='h') qh
    from field_scores group by id, t
  ), matches as (
    select id, sum(greatest(qv,qd)) quality,
      sum((1-v_hw)*greatest(qv, c_detail_weight*qd) + v_hw*coalesce(qh,0)) relevance,
      bool_or(coalesce(qv,0)>0) visible
    from term_scores group by id
    having sum(greatest(qv,qd))>=c_min_quality
  ), scored as (
    -- prior per matched card, computed inline (no extra pass over the pool):
    -- rank part x/(1+x), x = 2^((trend - now)/H), exponent clamped so power() never overflows;
    -- affinity (signed in only) from core.taste_hours / affinity_cap_hours, -1..1 mapped to 0..1
    select p.id,p.importance,p.sort_at,
      round((case when m.visible then c_visible_tier else 0 end
        + case when cardinality(v_co)>0 and exists(select 1 from core.card_companies cc where cc.blurb_id=p.id and cc.ticker=any(v_co) and cc.confidence>=v_cmin) then c_company_tier else 0 end
        + (1-v_w)*least(round(m.relevance,4)/v_nterms,1)
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
