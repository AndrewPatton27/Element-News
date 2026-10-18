-- Search, related stories, following feed and daily/weekly briefs.
-- Requires 20261017090000_web_side_column.sql. Read-only; never applied automatically.
create index if not exists blurbs_search_english_gin on core.blurbs using gin (
  to_tsvector('english'::regconfig,
    coalesce(headline, '') || ' ' || coalesce(body, '') || ' ' ||
    coalesce(detail::text, '') || ' ' || coalesce(tickers::text, '') || ' ' || coalesce(category, ''))
);

-- Personalization (signed-in readers only): score x (1 + c_personal_weight x affinity 0..1), where
-- affinity comes from core.user_affinity_dims, the helper For you uses, capped at
-- affinity_cap_hours. Multiplying keeps text relevance dominant: the boost is at most +15%.
-- Guests get no boost. The cursor carries `as of`, so scores (age, affinity) stay frozen while paging.
create or replace function api.search(p_q text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_personal_weight constant numeric := 0.15;   -- settings.md: search_personal_weight
  v_uid uuid := auth.uid();
  v_q text := left(btrim(coalesce(p_q, '')), 80);
  v_ts tsquery;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 30);
  v_key numeric := 1e30;
  v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_asof timestamptz := now();
  v_fol text[] := '{}';
  v_follow numeric; v_cap numeric;
  v_rows jsonb := '[]'::jsonb;
  v_next text;
begin
  if char_length(v_q) < 2 then return jsonb_build_object('items', '[]'::jsonb, 'next_cursor', null); end if;
  v_ts := websearch_to_tsquery('english', v_q);
  if p_cursor is not null then
    begin
      v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid;
      v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof);
    exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end;
  end if;
  if v_uid is not null then
    select coalesce(max(value) filter (where key = 'boost_followed_hours'), 2),
           coalesce(max(value) filter (where key = 'affinity_cap_hours'), 4)
      into v_follow, v_cap from core.rank_params;
    select coalesce(followed_categories, '{}') into v_fol from core.user_prefs where user_id = v_uid;
    v_fol := coalesce(v_fol, '{}');
  end if;
  with cfg as (select linkout_cards from core.app_config where id),
  dims as materialized (
    select a.dim, a.key, a.hours, a.conf from core.user_affinity_dims(v_uid, v_asof) a where v_uid is not null
  ),
  matched as (
    select b.id, b.category, b.sort_at, b.importance,
      case when b.kind = 'data' then 'fred' else sk.key end as skey,
      coalesce(b.event_type, b.kind) as typ,
      ts_rank(to_tsvector('english', coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,'')), v_ts) as tr
    from core.blurbs b cross join cfg c
    left join lateral (
      select k.key from core.blurb_sources s join core.source_keys k on s.name = any (k.match_names)
       where s.blurb_id = b.id and v_uid is not null order by s.is_primary desc, s.position, s.id limit 1) sk on true
    where b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or c.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
      and (to_tsvector('english', coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,'')) @@ v_ts
        or position(lower(v_q) in lower(coalesce(b.headline,'') || ' ' || coalesce(b.body,'') || ' ' || coalesce(b.detail::text,'') || ' ' || coalesce(b.tickers::text,'') || ' ' || coalesce(b.category,''))) > 0
        or exists (select 1 from core.blurb_sources s where s.blurb_id = b.id and position(lower(v_q) in lower(s.name)) > 0))
  ), candidates as (
    select m.id,
      (0.72 * m.tr + 0.28 / (1 + greatest(extract(epoch from (v_asof - m.sort_at)) / 3600, 0) / 72))
       * (1 + ln(greatest(m.importance, 0.1)) / 20)
       * (1 + c_personal_weight * case when v_uid is null then 0 else
            least(greatest(
              (case when m.category = any (v_fol) then v_follow else 0 end)
              + coalesce(ac.conf * ac.hours, 0) + coalesce(aty.conf * aty.hours, 0) + coalesce(asr.conf * asr.hours, 0), 0)
              / greatest(v_cap, 0.01), 1) end) as score
    from matched m
    left join dims ac  on ac.dim = 'category' and ac.key = m.category
    left join dims aty on aty.dim = 'type'    and aty.key = m.typ
    left join dims asr on asr.dim = 'source'  and asr.key = m.skey
  ), page as (
    select id, round(score::numeric, 8) as score from candidates
    where (round(score::numeric, 8), id) < (v_key, v_id)
    order by score desc, id desc limit v_limit + 1
  ), chosen as (
    select * from page order by score desc, id desc limit v_limit
  )
  select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb),
         case when (select count(*) from page) > v_limit then
           (select score::text || '|' || id::text || '|' || to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              from chosen order by score asc, id asc limit 1) end
    into v_rows, v_next
    from jsonb_array_elements(core.cards_json((select array_agg(id order by score desc, id desc) from chosen), null)) with ordinality x(c,o);
  return jsonb_build_object('items', coalesce(v_rows,'[]'::jsonb), 'next_cursor', v_next);
end; $$;
revoke all on function api.search(text,text,int) from public;
grant execute on function api.search(text,text,int) to anon, authenticated;

create or replace function api.related_cards(p_card_id uuid, p_limit int default 5)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  select array_agg(id order by score desc, id desc) into v_ids from (
    select b.id,
      (case when b.category = src.category then 1 else 0 end
       + (select count(*) from jsonb_array_elements(b.tickers) bt join jsonb_array_elements(src.tickers) st on lower(bt->>'symbol') = lower(st->>'symbol'))
       + (select count(*) from jsonb_array_elements(b.macro) bm join jsonb_array_elements(src.macro) sm on bm->>'series_id' = sm->>'series_id')
       + case when split_part(b.dedupe_key, ':', 1) = split_part(src.dedupe_key, ':', 1) then 1 else 0 end)
       * exp(-greatest(extract(epoch from (now() - b.sort_at)), 0) / 86400 / 3)
       * greatest(b.importance, 0.1) as score
    from core.blurbs src join core.blurbs b on b.id <> src.id
    join core.app_config c on c.id
    where src.id = p_card_id and src.status = 'published' and b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or c.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
      and (b.category = src.category or exists (select 1 from jsonb_array_elements(b.tickers) bt2 join jsonb_array_elements(src.tickers) st2 on lower(bt2->>'symbol') = lower(st2->>'symbol'))
        or exists (select 1 from jsonb_array_elements(b.macro) m where exists (select 1 from jsonb_array_elements(src.macro) sm where sm->>'series_id'=m->>'series_id'))
        or split_part(b.dedupe_key, ':', 1) = split_part(src.dedupe_key, ':', 1))
    order by score desc, b.sort_at desc, b.id desc limit least(greatest(coalesce(p_limit, 5), 1), 10)
  ) q;
  return coalesce((select jsonb_agg(x.c - 'my_reaction' order by x.o) from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality x(c,o)), '[]'::jsonb);
end; $$;
revoke all on function api.related_cards(uuid,int) from public;
grant execute on function api.related_cards(uuid,int) to anon, authenticated;

create or replace function api.following_feed(p_topics text[], p_sources text[], p_tickers text[], p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_topics text[] := coalesce(p_topics, '{}'); v_sources text[] := coalesce(p_sources, '{}'); v_tickers text[] := coalesce(p_tickers, '{}');
  v_limit int := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key numeric := 1e30; v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_next text; v_items jsonb;
begin
  if cardinality(v_topics) + cardinality(v_sources) + cardinality(v_tickers) = 0 then
    return api.feed('top', p_cursor, p_limit, null);
  end if;
  if p_cursor is not null then
    begin v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid;
      v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof);
    exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end;
  end if;
  with direct as (
    select b.id, b.category, b.dedupe_key, b.sort_at, b.importance,
      case when b.category = any(v_topics) then 1.0
           when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources)) then 1.0
           when exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol' = any(v_tickers)) then 1.0 else 0.0 end rel,
      case when b.category = any(v_topics) then 'Because you follow ' || b.category
           when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources)) then 'Because you follow ' || (select s.name from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources) limit 1)
           else 'Because you follow ' || coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(v_tickers) limit 1), v_tickers[1]) end reason
    from core.blurbs b join core.app_config cfg on cfg.id
    where b.status='published' and b.published_at<=now() and (b.kind<>'link_out' or cfg.linkout_cards)
      and exists(select 1 from core.blurb_sources bs where bs.blurb_id=b.id)
      and (b.category = any(v_topics)
      or exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name = any(v_sources))
      or exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol' = any(v_tickers)))
  ), candidates as (
    select d.id, d.dedupe_key, d.rel, d.reason, d.sort_at, d.importance from direct d
    union all
    select b.id, b.dedupe_key, 0.6, 'Related to ' || coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where exists(select 1 from direct d, core.blurbs db, jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol') limit 1), b.category), b.sort_at, b.importance
    from core.blurbs b
    where not exists(select 1 from direct d where d.id=b.id)
      and (exists(select 1 from direct d join core.blurbs db on db.id=d.id where db.category=b.category)
        or exists(select 1 from jsonb_array_elements(b.tickers) t join direct d on exists(select 1 from core.blurbs db, jsonb_array_elements(db.tickers) dt where db.id=d.id and dt->>'symbol'=t->>'symbol'))
        or exists(select 1 from direct d join core.blurbs db on db.id=d.id where split_part(db.dedupe_key,':',1)=split_part(b.dedupe_key,':',1))
        or exists(select 1 from jsonb_array_elements(b.macro) m join direct d on exists(select 1 from core.blurbs db,jsonb_array_elements(db.macro) dm where db.id=d.id and dm->>'series_id'=m->>'series_id')))
  ), cfg as (select linkout_cards from core.app_config where id), eligible as (
    select c.*, c.rel * exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/12 * ln(2)) * greatest(c.importance,0.1) score,
           row_number() over(partition by c.dedupe_key order by c.rel desc, c.sort_at desc, c.id desc) dedupe_n
    from candidates c join core.blurbs b on b.id=c.id cross join cfg
    where b.status='published' and b.published_at<=now() and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)
      and (b.kind<>'link_out' or cfg.linkout_cards)
  ), page as (
    select e.id,e.reason,round(e.score::numeric,8) as score from eligible e where e.dedupe_n=1 and (round(e.score::numeric,8),e.id)<(v_key,v_id) order by 3 desc,1 desc limit v_limit+1
  ), chosen as (select * from page order by score desc,id desc limit v_limit), rendered as (
    select c.id,c.reason,c.score from chosen c
  )
  select coalesce(jsonb_agg((x.c - 'my_reaction') || jsonb_build_object('follow_reason',r.reason) order by x.o),'[]'::jsonb),
         case when (select count(*) from page)>v_limit then (select score::text||'|'||id::text||'|'||to_char(v_asof at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from chosen order by score asc,id asc limit 1) end
    into v_items,v_next
    from jsonb_array_elements(core.cards_json((select array_agg(id order by score desc,id desc) from rendered),null)) with ordinality x(c,o)
    join rendered r on r.id=(x.c->>'id')::uuid;
  return jsonb_build_object('items',coalesce(v_items,'[]'::jsonb),'next_cursor',v_next);
end; $$;
revoke all on function api.following_feed(text[],text[],text[],text,int) from public;
grant execute on function api.following_feed(text[],text[],text[],text,int) to anon, authenticated;

create or replace function api.daily_brief()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_hours int; v_ids uuid[]; v_head jsonb; v_sections jsonb; v_numbers jsonb;
begin
  select case when count(*) < 6 then 48 else 24 end into v_hours from core.blurbs b join core.app_config c on c.id where b.status='published' and b.published_at<=now() and b.sort_at>=now()-interval '24 hours' and (b.kind<>'link_out' or c.linkout_cards) and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id);
  with eligible as (select b.* from core.blurbs b join core.app_config c on c.id where b.status='published' and b.published_at<=now() and b.sort_at>=now()-make_interval(hours=>v_hours) and (b.kind<>'link_out' or c.linkout_cards) and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)),
  ranked as (select *,row_number() over(partition by category order by rank_score desc,id desc) cat_n from eligible), top_ids as (select id from ranked where cat_n=1 order by rank_score desc,id desc limit 3), section_json as (select r.category,coalesce((select name from core.categories c where c.slug=r.category),r.category) label,(select coalesce(jsonb_agg(j.c-'my_reaction' order by j.o),'[]'::jsonb) from jsonb_array_elements(core.cards_json(array_agg(r.id order by r.rank_score desc,r.id desc),null)) with ordinality j(c,o)) cards,max(r.rank_score) section_score from ranked r where cat_n<=3 group by r.category)
  select array(select id from top_ids), coalesce((select jsonb_agg(x.c-'my_reaction' order by x.o) from jsonb_array_elements(core.cards_json((select array_agg(t.id order by t.rank_score desc,t.id desc) from (select id,rank_score from ranked where cat_n=1 order by rank_score desc,id desc limit 3) t),null)) with ordinality x(c,o)),'[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('category',category,'label',label,'cards',cards) order by section_score desc) from (select * from section_json order by section_score desc limit 5) limited),'[]'::jsonb)
    into v_ids,v_head,v_sections;
  select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
  return jsonb_build_object('generated_at',now(),'window_hours',v_hours,'headline_cards',v_head,'sections',v_sections,'numbers',v_numbers);
end; $$;
revoke all on function api.daily_brief() from public;
grant execute on function api.daily_brief() to anon, authenticated;

create or replace function api.weekly_brief()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_head jsonb; v_sections jsonb; v_numbers jsonb; v_items uuid[];
begin
  with eligible as (select b.* from core.blurbs b join core.app_config c on c.id where b.status='published' and b.published_at<=now() and b.sort_at>=now()-interval '7 days' and (b.kind<>'link_out' or c.linkout_cards) and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id)),
  ranked as (select *,row_number() over(partition by category order by rank_score desc,id desc) cat_n from eligible),
  section_json as (select r.category,coalesce((select name from core.categories c where c.slug=r.category),r.category) label,
    (select coalesce(jsonb_agg(j.c-'my_reaction' order by j.o),'[]'::jsonb) from jsonb_array_elements(core.cards_json(array_agg(r.id order by r.rank_score desc,r.id desc),null)) with ordinality j(c,o)) cards,
    max(r.rank_score) section_score from ranked r where cat_n<=3 group by r.category)
  select coalesce((select jsonb_agg(x.c-'my_reaction' order by x.o) from jsonb_array_elements(core.cards_json((select array_agg(t.id order by t.rank_score desc,t.id desc) from (select id,rank_score from ranked where cat_n=1 order by rank_score desc,id desc limit 3) t),null)) with ordinality x(c,o)),'[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('category',category,'label',label,'cards',cards) order by section_score desc) from (select * from section_json order by section_score desc limit 5) limited),'[]'::jsonb)
    into v_head,v_sections;
  select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order),'[]'::jsonb) into v_numbers from (select * from api.numbers_to_know order by sort_order limit 4) n;
  return jsonb_build_object('generated_at',now(),'window_hours',168,'headline_cards',v_head,'sections',v_sections,'numbers',v_numbers,'movers',api.number_trends());
end; $$;
revoke all on function api.weekly_brief() from public;
grant execute on function api.weekly_brief() to anon, authenticated;

notify pgrst, 'reload schema';
