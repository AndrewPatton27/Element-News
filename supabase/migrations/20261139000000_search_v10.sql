-- Search v10 (M9c fix3, persona run 3b). NOT applied. Idempotent. Replaces only api.search (same signature, response,
-- cursor format, grants) on top of v9 (20261137000200_search_v9.sql).
-- Reported: "how much is gas" and "rent and gas costs" found nothing, "is the economy ok" ranked a coffee company first
-- (the Fed card only said "economy" in its detail, so it was not a visible match).
-- What changes:
--   1. More question filler is a stop word: much, many, long, get, tell, show, mean, means, whats.
--   2. An alias card (headline matches the alias pattern, or carries one of its macro series) counts as a visible
--      match of the alias words (evidence 0.6) and joins the candidates, so it ranks on its +5 alias tier.
--   3. A query whose kept words are ALL single-word aliases ("rent and gas costs") matches a card that fits ANY of
--      them (housing OR energy); one real word beside an alias word ("gas Tailspin") still needs every word.
--   4. New aliases: rent, rents, shelter, mortgage, mortgages (housing and mortgage series; not "housing" alone, so the v6 housing-starts ordering is unchanged); the gas family
--      also carries the weekly pump price GASREGW.
-- Setting: none new. Checked by tests/search_v10_check.sql.

insert into core.search_aliases (alias, headline_re, series) values
  ('rent', '(^|[^[:alnum:]])(rents?|housing|shelter|mortgages?|home[[:space:]]+prices?|homes?|house[[:space:]]+prices?)([^[:alnum:]]|$)', array['CUSR0000SEHA','HOUST','MORTGAGE30US','CSUSHPINSA']),
  ('rents', '(^|[^[:alnum:]])(rents?|housing|shelter|mortgages?|home[[:space:]]+prices?|homes?|house[[:space:]]+prices?)([^[:alnum:]]|$)', array['CUSR0000SEHA','HOUST','MORTGAGE30US','CSUSHPINSA']),
  ('shelter', '(^|[^[:alnum:]])(rents?|housing|shelter|mortgages?|home[[:space:]]+prices?|homes?|house[[:space:]]+prices?)([^[:alnum:]]|$)', array['CUSR0000SEHA','HOUST','MORTGAGE30US','CSUSHPINSA']),
  ('mortgage', '(^|[^[:alnum:]])(rents?|housing|shelter|mortgages?|home[[:space:]]+prices?|homes?|house[[:space:]]+prices?)([^[:alnum:]]|$)', array['CUSR0000SEHA','HOUST','MORTGAGE30US','CSUSHPINSA']),
  ('mortgages', '(^|[^[:alnum:]])(rents?|housing|shelter|mortgages?|home[[:space:]]+prices?|homes?|house[[:space:]]+prices?)([^[:alnum:]]|$)', array['CUSR0000SEHA','HOUST','MORTGAGE30US','CSUSHPINSA'])
on conflict (alias) do update set headline_re = excluded.headline_re, series = excluded.series;

update core.search_aliases set series = array['DCOILWTICO','GASREGW']
 where alias in ('gas','gasoline','diesel','fuel','diesel fuel','oil');

create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_min_quality constant numeric := 0.5;
  c_detail_weight constant numeric := 0.2;      -- settings.md: search_detail_weight
  c_visible_tier constant numeric := 10;        -- visible match first (the rest of the key is 0..1)
  c_alias_tier constant numeric := 5;           -- v8: headline names the alias (Fed -> Federal Reserve / FOMC)
  c_recency_half_h constant numeric := 72;      -- v8: recency term halves every 72 hours
  c_company_tier constant numeric := 20;        -- a card tagged with the company the query names comes before both
  c_company_min constant numeric := 0.95;       -- query names the company: ticker (1) or exact name / alias (0.95)
  c_max_terms constant int := 6;
  c_typo_min_len constant int := 5;
  c_prefix_min_len constant int := 3;
  c_rate_noise constant text := '(^|[^[:alnum:]])(unemployment|jobless|annual|growth|participation|vacancy|savings|exchange|birth|death|tax)[[:space:]]+rates?([^[:alnum:]]|$)';
  c_stop constant text[] := array['the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be','it','its','as','from','that','this','what','how','why','who','about','into',
    'ok','okay','doing','going','now','today','my','me','do','does','should','can','will','you','your','we','our','there','any','am',
    'much','many','long','get','tell','show','mean','means','whats'];   -- v10: more question filler
  c_modifiers constant text[] := array['price','prices','cost','costs','account','accounts'];   -- v9: dropped when another word remains
  c_filing_penalty constant numeric := 5;       -- v9: Form 4 / filing cards under a query that names no company
  v_uid uuid := auth.uid(); v_norm text; v_terms text[]; v_nterms int; v_limit int := least(greatest(coalesce(p_limit,20),1),30);
  v_key numeric := 1e30; v_imp numeric := 1e30; v_sort timestamptz := 'infinity';
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_gen bigint;
  v_h numeric; v_cap numeric; v_w numeric; v_aw numeric; v_now_h numeric;
  v_hw numeric; v_mpen numeric; v_cmin numeric; v_mcats text[]; v_idf boolean;
  v_pcap int; v_nall numeric; v_lk boolean; v_mr numeric; v_rw numeric; v_alias_re text; v_alias_series text[]; v_generic boolean; v_term_alias boolean := false;
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
  -- v9: words that only describe the thing searched ("gas prices", "savings account") are dropped when another word remains
  if exists(select 1 from unnest(v_terms) t where t <> all(c_modifiers)) then
    v_terms := coalesce((select array_agg(t order by o) from unnest(v_terms) with ordinality u(t,o) where t <> all(c_modifiers)),'{}'::text[]);
  end if;
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
         greatest(coalesce(max(value) filter(where key='search_pool_cap'),2000),1)::int,
         coalesce(max(value) filter(where key='search_min_relevance'),0.05),
         coalesce(max(value) filter(where key='search_recency_weight'),0.3)
    into v_h,v_cap,v_w,v_aw,v_hw,v_mpen,v_cmin,v_idf,v_pcap,v_mr,v_rw from core.rank_params;
  v_pcap := least(greatest(coalesce(v_pcap,2000),1),10000);   -- clamp: a bad rank_params value cannot widen the scan
  v_mr := least(greatest(v_mr,0),0.5); v_rw := least(greatest(v_rw,0),1);
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
  select a.headline_re, a.series into v_alias_re, v_alias_series from core.search_aliases a where a.alias=array_to_string(v_terms,' ');   -- v9: the kept words, so "is the economy ok" is the alias "economy"
  -- v10: every kept word is itself an alias ("rent and gas costs"): a card that fits ANY of them is a match
  v_term_alias := v_alias_re is null and not exists(select 1 from unnest(v_terms) t where not exists(select 1 from core.search_aliases a where a.alias=t));
  begin
    if v_alias_re is not null or v_term_alias then v_co:='{}';   -- v8: Fed names the Federal Reserve, not FedEx
    else select coalesce(array_agg(cq.ticker),'{}') into v_co from core.company_query_scores(p_q) cq where cq.score>=c_company_min; end if;
  exception when others then v_co:='{}'; end;
  v_generic := v_alias_re is not null or v_term_alias or cardinality(v_co)=0;   -- v9: no company named
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
      case when char_length(t.t)>=c_typo_min_len and not exists(select 1 from core.search_words sw where sw.word=t.t)
        then array(select w from unnest(core.search_typo_words(t.t)) w
                    where position(t.t in w)=0 and position(w in t.t)=0
                      and core.search_edit_distance(t.t,w) <= case when char_length(t.t)>=8 then 2 else 1 end)
        else '{}'::text[] end typo_words,
      -- v10: the alias pattern and series that count as evidence for this word (whole-query alias, or the word's own alias)
      case when v_alias_re is not null then v_alias_re when v_term_alias then (select a.headline_re from core.search_aliases a where a.alias=t.t) end a_re,
      case when v_alias_re is not null then v_alias_series when v_term_alias then (select a.series from core.search_aliases a where a.alias=t.t) end a_series
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
    select d.blurb_id from core.search_docs d join terms t on t.a_re is not null and d.hl ~ t.a_re   -- v10: alias cards
    union
    select b.id from core.blurbs b join terms t on t.a_series is not null
      where b.status='published' and b.published_at > v_asof - interval '120 days'
        and exists(select 1 from jsonb_array_elements(b.macro) am where am->>'series_id'=any(t.a_series))
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
             or (char_length(t.t)>=4 and z.x ~ ('(^|[^[:alnum:]])'||t.t||'[[:alnum:]]{1,}([^[:alnum:]]|$)')))
           and t.t not in ('fed','federal','federl') then 0.8
           when f.f='v' and t.t in ('aapl','msft','ba') and p.tickers @> jsonb_build_array(jsonb_build_object('symbol',upper(t.t))) then 1.0
           when f.f='v' and p.macro @> jsonb_build_array(jsonb_build_object('series_id',upper(t.t))) then 1.0 else 0 end,
      case when t.syn_re is not null and z.x ~ t.syn_re then 0.6 else 0 end,
      case when t.typo_re is not null and z.x ~ t.typo_re
            and (t.t not in ('federl','federal') or p.content ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)') then 0.5 else 0 end,
      case when f.f='v' and p.meta ~ ('(^|[^[:alnum:]])'||t.t||'s?([^[:alnum:]]|$)') then 0.25 else 0 end,
      case when f.f='v' and t.a_re is not null and (p.hl ~ t.a_re
             or exists(select 1 from jsonb_array_elements(p.macro) am where am->>'series_id'=any(t.a_series))) then 0.6 else 0 end   -- v10
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
       and (bool_and(greatest(coalesce(ts.qv,0),coalesce(ts.qd,0))>0) or v_term_alias)   -- v8: every query word must match (v10: any, when all are alias words)
       and sum(coalesce(tw.w,0)*((1-v_hw)*greatest(ts.qv, c_detail_weight*ts.qd) + v_hw*coalesce(ts.qh,0)))
             / greatest((select sum(w) from term_weights),0.000001) >= v_mr   -- v8: minimum relevance
  ), scored as (
    select p.id,p.importance,p.sort_at,
      round((case when m.visible then c_visible_tier else 0 end
        + case when (v_alias_re is not null and (exists(select 1 from core.search_docs d2 where d2.blurb_id=p.id and d2.hl ~ v_alias_re)
            or exists(select 1 from jsonb_array_elements(p.macro) am where am->>'series_id'=any(v_alias_series))))
            or (v_term_alias and exists(select 1 from core.search_aliases a2 where a2.alias=any(v_terms)
              and (p.hl ~ a2.headline_re or exists(select 1 from jsonb_array_elements(p.macro) am where am->>'series_id'=any(a2.series))))) then c_alias_tier else 0 end
        - case when v_generic and (p.event_type='insider' or exists(select 1 from core.blurb_sources fs where fs.blurb_id=p.id and fs.kind='filing')) then c_filing_penalty else 0 end
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
    cross join lateral (select (1-v_rw)*(y.e/(1+y.e)) + v_rw*power(0.5::numeric, least(greatest(extract(epoch from (v_asof-p.sort_at))/3600,0),2000)/c_recency_half_h) rp) x
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
