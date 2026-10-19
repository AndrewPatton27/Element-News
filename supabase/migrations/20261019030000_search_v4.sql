-- Search v4: where a word matched now matters.
-- Problem (v3): a word found only deep inside a card's detail paragraphs scored the same as a word in
-- the headline, and the score multiplied the Trending key (about 500,000 hours since 1970), so any
-- small quality edge outweighed every Trending difference. Searching "inflation" put PepsiCo's earnings
-- card (the word is only in its last detail paragraph) above the CPI and Fed cards.
-- v4, per query word:
--   quality   = best evidence anywhere, same weights as v3 (exact 1.0, stem/prefix 0.8, synonym 0.6,
--               typo 0.5, exact source/topic/event word 0.25). The gate is unchanged: a card needs a
--               total quality of at least 0.5 to be a result.
--   relevance = best evidence in what the card shows (headline, summary, tickers, numbers, topic,
--               source), or 0.2 x the detail-only evidence (search_detail_weight). 0.2 is below the
--               weakest visible evidence (0.25), so a visible match always outranks a detail-only one.
-- Order = relevance summed over query words first, then the v2/v3 Trending key (trend boost, x1.3 per
-- extra matched word, signed-in personal part) as the tiebreak, then importance, newest, id.
-- The key is relevance x 10,000,000 + Trending key (search_relevance_scale): relevance steps are at
-- least 0.01, i.e. 100,000 hours, far more than any Trending gap, so this is a plain "relevance, then
-- Trending" order that still fits the existing one-number cursor.
-- Same signature, response, cursor format, paging, security definer, empty search_path and grants.
-- Idempotent: create or replace only.
create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_personal_weight constant numeric := 0.15;
  c_term_bonus constant numeric := 1.3;
  c_min_quality constant numeric := 0.5;
  c_detail_weight constant numeric := 0.2;      -- settings.md: search_detail_weight
  c_rel_scale constant numeric := 10000000;     -- settings.md: search_relevance_scale
  c_max_terms constant int := 6;
  c_scan_cap constant int := 2000;
  c_typo_min_len constant int := 5;
  c_prefix_min_len constant int := 3;
  c_stop constant text[] := array['the','a','an','and','or','of','to','in','on','for','at','by','with','is','are','was','were','be','it','its','as','from','that','this','what','how','why','who','about','into'];
  v_uid uuid := auth.uid(); v_norm text; v_terms text[]; v_limit int := least(greatest(coalesce(p_limit,20),1),30);
  v_key numeric := 1e30; v_imp numeric := 1e30; v_sort timestamptz := 'infinity';
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_gen bigint;
  v_h numeric; v_cap numeric; v_taste jsonb; v_rows jsonb; v_next text;
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
  if cardinality(v_terms)=0 then return v_empty; end if;
  if v_gen is null or not exists(select 1 from core.trend_generations where gen=v_gen) then select coalesce(max(gen),0) into v_gen from core.trend_generations; end if;
  select coalesce(max(value) filter(where key='half_life_hours'),8),coalesce(max(value) filter(where key='affinity_cap_hours'),4) into v_h,v_cap from core.rank_params;
  if v_uid is not null then v_taste:=core.user_taste(v_uid,v_asof); end if;
  with cfg as (select linkout_cards from core.app_config where id),
  pool0 as (
    select b.id,b.kind,b.category,b.event_type,b.importance,b.sort_at,b.dedupe_key,b.tickers,b.macro,
      b.rank_score+coalesce(tb.boost,0) trend,
      -- what the card shows: headline, summary, ticker names, number labels
      lower(concat_ws(' ',b.headline,b.body,
       (select string_agg(concat_ws(' ',t->>'symbol',t->>'name'),' ') from jsonb_array_elements(b.tickers)t),
       (select string_agg(concat_ws(' ',m->>'series_id',ms.label),' ') from jsonb_array_elements(b.macro)m left join core.macro_series ms on ms.series_id=m->>'series_id'))) vis,
      -- only behind "Read more": detail paragraphs and key points
      lower(coalesce((select string_agg(v #>> '{}',' ') from jsonb_path_query(coalesce(b.detail,'{}'::jsonb),'strict $.**') v where jsonb_typeof(v)='string'),'')) deep,
      lower(concat_ws(' ',(select string_agg(s.name,' ') from core.blurb_sources s where s.blurb_id=b.id),
        (select c2.name from core.categories c2 where c2.slug=b.category),b.category,replace(coalesce(b.event_type,''),'_',' '))) meta
    from core.blurbs b cross join cfg c left join core.trend_boosts tb on tb.gen=v_gen and tb.blurb_id=b.id
    where b.status='published' and b.published_at<=v_asof and (b.kind<>'link_out' or c.linkout_cards)
      and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
    order by b.rank_score desc,b.id desc limit c_scan_cap
  ), pool as (select p0.*, p0.vis||' '||p0.deep content from pool0 p0),
  terms as (select t from unnest(v_terms)t),
  field_scores as (
    -- Same v3 evidence rules, scored separately on the visible text (f='v') and the detail text (f='d').
    -- Ticker/series ids and source/topic words are visible. The Fed guards look at the whole card, as in v3.
    select p.id, t.t, f.f, greatest(
      case when f.x ~ ('(^|[^[:alnum:]])'||t.t||'([^[:alnum:]]|$)')
             and t.t not in ('fed','federal','federl') then 1.0
           when t.t='federal' and f.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)' then 1.0
           when t.t='fed' and (f.x ~ '(^|[^[:alnum:]])fed([^[:alnum:]]|$)'
             or f.x ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)'
             or f.x ~ '(^|[^[:alnum:]])fomc([^[:alnum:]]|$)') then 1.0 else 0 end,
      case when (to_tsvector('english',f.x) @@ plainto_tsquery('english',t.t)
             or f.x ~ ('(^|[^[:alnum:]])'||t.t||'[[:alnum:]]{1,}([^[:alnum:]]|$)'))
           and t.t not in ('fed','federal','federl') then 0.8
           when f.f='v' and t.t in ('aapl','msft','ba') and p.tickers @> jsonb_build_array(jsonb_build_object('symbol',upper(t.t))) then 1.0
           when f.f='v' and p.macro @> jsonb_build_array(jsonb_build_object('series_id',upper(t.t))) then 1.0 else 0 end,
      case when exists(select 1 from core.search_synonyms s1 join core.search_synonyms s2 on s2.grp=s1.grp
          where (s1.word=t.t or s1.word||'s'=t.t or s1.word=t.t||'s') and s2.word<>t.t
            and (t.t not in ('fed','federal','federl') or s2.word in ('federal reserve','fomc'))
            and f.x ~ ('(^|[^[:alnum:]])'||replace(s2.word,' ','[[:space:]]+')||'([^[:alnum:]]|$)')) then 0.6 else 0 end,
      case when char_length(t.t)>=c_typo_min_len and exists(select 1 from regexp_split_to_table(f.x,'[^[:alnum:]]+') w
          where core.search_typo_ok(t.t,w) and w<>t.t
            and (t.t not in ('federl','federal') or p.content ~ '(^|[^[:alnum:]])federal[[:space:]]+reserve([^[:alnum:]]|$)')) then 0.5 else 0 end,
      case when f.f='v' and p.meta ~ ('(^|[^[:alnum:]])'||t.t||'([^[:alnum:]]|$)') then 0.25 else 0 end
    ) q
    from pool p cross join terms t cross join lateral (values ('v',p.vis),('d',p.deep)) f(f,x)
  ), term_scores as (
    select id, t, max(q) filter (where f='v') qv, max(q) filter (where f='d') qd from field_scores group by id, t
  ), matches as (
    select id, sum(greatest(qv,qd)) quality, count(*) filter (where greatest(qv,qd)>0) n,
      sum(greatest(qv, c_detail_weight*qd)) relevance
    from term_scores group by id
    having sum(greatest(qv,qd))>=c_min_quality
  ), scored as (
    select p.id,p.importance,p.sort_at,m.quality,
      round((c_rel_scale*round(m.relevance,4) + p.trend
       +v_h*ln(c_term_bonus)/ln(2::numeric)*greatest(m.n-1,0)
       +case when v_uid is null then 0 else v_h*ln(1+c_personal_weight*least(greatest(core.taste_hours(v_taste,p.category,coalesce(p.event_type,p.kind),case when p.kind='data' then 'fred' else core.source_key_of(p.kind,p.id) end),0)/greatest(v_cap,0.01),1))/ln(2::numeric) end)::numeric,6) k,
      row_number() over(partition by p.dedupe_key order by p.sort_at desc,p.id desc) dn
    from pool p join matches m on m.id=p.id
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
