-- Following, faster and without false 'related' cards (search/recommendation audit, 2026-11-09).
-- Replaces only api.following_feed (same signature, response, reasons, tiers, cursor, grants). Must run after
-- 20261119000000_following_companies.sql (whose body it starts from). Idempotent. NOT applied.
--
-- Why: the 'related' tier (cards that share a topic, ticker, key prefix or number series with a direct match) was
-- a correlated scan: for every card, every direct match was re-read with its ticker and series arrays, so the cost
-- grew with cards x direct matches (PGlite, 290 cards: about 3-5 s for one page; at 100x the cards it would pass the
-- statement timeout). v2 collects the direct matches' topics, tickers, key prefixes and series once (dsets) and
-- tests each card against those arrays: one pass. Hidden cards are dropped there too (they were dropped later).
-- Relevance fix: filing cards use their URL as dedupe key, so 'https' was a shared key prefix and every filing card
-- counted as related to every followed filing card ("Related to Earnings" on unrelated cards). A key that starts
-- with a URL scheme no longer counts as a prefix; series keys such as 'CPIAUCSL:2026-10' still do.
-- Checked by tests/following_speed_check.sql plus the existing following_*, story_links and seen checks.

create or replace function api.following_feed(p_topics text[], p_sources text[], p_tickers text[], p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_topics text[] := coalesce(p_topics, '{}'); v_sources text[] := coalesce(p_sources, '{}');
  -- followed tickers: upper case, distinct, at most 100 (first ones kept)
  v_tickers text[] := coalesce((select array_agg(t order by n) from (
      select upper(btrim(x)) t, min(n) n from unnest(coalesce(p_tickers, '{}'::text[])) with ordinality u(x, n)
      where btrim(coalesce(x, '')) <> '' group by upper(btrim(x)) order by min(n) limit 100) s), '{}'::text[]);
  v_min numeric := coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);
  v_limit int := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_key numeric := 1e30; v_id uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff'; v_asof timestamptz := now(); v_next text; v_items jsonb;
  v_uid uuid := auth.uid(); v_taste jsonb; v_scale numeric; v_half numeric;
begin
  if cardinality(v_topics) + cardinality(v_sources) + cardinality(v_tickers) = 0 then return core.feed_top('top', p_cursor, p_limit, null); end if;
  if p_cursor is not null then begin v_key := split_part(p_cursor, '|', 1)::numeric; v_id := split_part(p_cursor, '|', 2)::uuid; v_asof := least(coalesce(nullif(split_part(p_cursor, '|', 3), '')::timestamptz, v_asof), v_asof); exception when others then raise exception 'invalid_cursor' using errcode = 'PT422'; end; end if;
  select coalesce(max(value) filter (where key='foryou_personal_scale'),3),coalesce(max(value) filter (where key='following_half_life_hours'),12) into v_scale,v_half from core.rank_params;
  if v_uid is not null then v_taste := core.user_taste(v_uid,v_asof); end if;
  with company_hits as (
    -- cards that mention a followed company (one row per card: its strongest followed company)
    select distinct on (cc.blurb_id) cc.blurb_id, cc.ticker, co.short_name
    from core.card_companies cc join core.companies co on co.ticker = cc.ticker and co.enabled
    where cc.ticker = any(v_tickers) and cc.confidence >= v_min
    order by cc.blurb_id, cc.confidence desc, array_position(v_tickers, cc.ticker)
  ), direct0 as (
    select b.id,b.category,b.dedupe_key,b.sort_at,b.importance,
      case when b.category=any(v_topics) then 'topic' when exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources)) then 'source'
           when exists(select 1 from jsonb_array_elements(b.tickers) t where upper(t->>'symbol')=any(v_tickers)) then 'ticker' else 'company' end match_kind,
      ch.ticker company_ticker, ch.short_name company_name
    from core.blurbs b join core.app_config cfg on cfg.id left join company_hits ch on ch.blurb_id=b.id
    where b.status='published' and b.published_at<=now() and (b.kind<>'link_out' or cfg.linkout_cards) and exists(select 1 from core.blurb_sources bs where bs.blurb_id=b.id)
      and (b.category=any(v_topics) or exists(select 1 from core.blurb_sources s where s.blurb_id=b.id and s.name=any(v_sources)) or exists(select 1 from jsonb_array_elements(b.tickers) t where upper(t->>'symbol')=any(v_tickers)) or ch.blurb_id is not null)
  ), direct as (
    select d.id,d.category,d.dedupe_key,d.sort_at,d.importance,1.0 rel,d.match_kind,
      case d.match_kind
        when 'topic' then 'Because you follow '||coalesce((select c.name from core.categories c where c.slug=d.category),d.category)
        when 'source' then 'Because you follow '||(select s.name from core.blurb_sources s where s.blurb_id=d.id and s.name=any(v_sources) limit 1)
        when 'ticker' then 'Because you follow '||coalesce((select upper(t->>'symbol') from core.blurbs b, jsonb_array_elements(b.tickers) t where b.id=d.id and upper(t->>'symbol')=any(v_tickers) limit 1),v_tickers[1])
        else 'Because you follow '||d.company_ticker||' (mentions '||d.company_name||')' end reason,
      case when d.match_kind='ticker' then coalesce((select upper(t->>'symbol') from core.blurbs b, jsonb_array_elements(b.tickers) t where b.id=d.id and upper(t->>'symbol')=any(v_tickers) limit 1),d.company_ticker)
           when d.match_kind='company' then d.company_ticker end follow_ticker
    from direct0 d
  ), candidates0 as (
    select d.id,d.dedupe_key,d.rel,d.reason,d.sort_at,d.importance,null::text link_kind,null::uuid related_id,null::text related_headline,d.match_kind,d.follow_ticker from direct d
    union all
    select b.id,b.dedupe_key,case sl.kind when 'related' then 0.6 else 0.9 end,case sl.kind when 'update' then 'Update to a story you follow' when 'angle' then 'Another angle on a story you follow' else 'Related to something you follow' end,b.sort_at,b.importance,sl.kind,sl.related_id,target.headline,null::text,null::text
    from core.story_links sl join core.blurbs b on b.id=sl.card_id join core.blurbs target on target.id=sl.related_id join direct d on d.id=sl.related_id
    where b.status='published' and (sl.kind='related' or true)
    union all
    select b.id,b.dedupe_key,0.6,'Related to something you follow',b.sort_at,b.importance,sl.kind,sl.card_id,target.headline,null::text,null::text
    from core.story_links sl join core.blurbs b on b.id=sl.related_id join core.blurbs target on target.id=sl.card_id join direct d on d.id=sl.card_id where b.status='published'
  ), dsets as materialized (
    select coalesce((select array_agg(distinct db.category) from direct d join core.blurbs db on db.id=d.id),'{}'::text[]) cats,
           coalesce((select array_agg(distinct split_part(db.dedupe_key,':',1)) from direct d join core.blurbs db on db.id=d.id where db.dedupe_key !~ '^[a-z]+://'),'{}'::text[]) pfx,
           coalesce((select array_agg(distinct dt->>'symbol') from direct d join core.blurbs db on db.id=d.id cross join jsonb_array_elements(db.tickers) dt where dt->>'symbol' is not null),'{}'::text[]) ticks,
           coalesce((select array_agg(distinct dm->>'series_id') from direct d join core.blurbs db on db.id=d.id cross join jsonb_array_elements(db.macro) dm where dm->>'series_id' is not null),'{}'::text[]) series
  ), candidates as (
    select * from (select distinct on(id) * from candidates0 order by id,rel desc,sort_at desc) preferred
    union all
    -- v2 (20261120000400): one pass over the cards against the direct matches' topics, tickers, key prefixes and
    -- number series (dsets), instead of a correlated scan of the direct matches for every card; a URL dedupe key
    -- ('https://...') no longer counts as a shared prefix (every filing card was 'related' to every other one)
    select b.id,b.dedupe_key,0.6,'Related to '||coalesce((select t->>'symbol' from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(ds.ticks) limit 1),(select c.name from core.categories c where c.slug=b.category),b.category),b.sort_at,b.importance,null::text,null::uuid,null::text,null::text,null::text
    from core.blurbs b cross join dsets ds
    where b.status='published' and not exists(select 1 from candidates0 c where c.id=b.id)
      and (b.category=any(ds.cats)
        or exists(select 1 from jsonb_array_elements(b.tickers) t where t->>'symbol'=any(ds.ticks))
        or (b.dedupe_key !~ '^[a-z]+://' and split_part(b.dedupe_key,':',1)=any(ds.pfx))
        or exists(select 1 from jsonb_array_elements(b.macro) m where m->>'series_id'=any(ds.series)))
  ), cfg as (select linkout_cards from core.app_config where id), eligible as (
    select c.*,(case when c.rel>=0.9 then 10000 else 0 end)+c.rel*(case when c.rel>=0.9 then 0.35+0.65*exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/greatest(v_half,0.5)*ln(2)) else exp(-greatest(extract(epoch from (v_asof-c.sort_at)),0)/3600/greatest(v_half,0.5)*ln(2)) end)*greatest(c.importance,0.1)*case when v_taste is null then 1 else power(2::numeric,least(greatest(v_scale*core.taste_hours(v_taste,b.category,coalesce(b.event_type,b.kind),case when b.kind='data' then 'fred' else core.source_key_of(b.kind,b.id) end),-48),48)/greatest(v_half,0.5)) end score,
      row_number() over(partition by c.dedupe_key order by case when c.link_kind in ('update','angle') then 1 else 0 end desc,c.rel desc,c.sort_at desc,c.id desc,case c.link_kind when 'update' then 1 when 'angle' then 2 when 'related' then 3 else 4 end,c.related_id nulls last) dedupe_n
    from candidates c join core.blurbs b on b.id=c.id cross join cfg where b.status='published' and b.published_at<=now() and exists(select 1 from core.blurb_sources s where s.blurb_id=b.id) and (b.kind<>'link_out' or cfg.linkout_cards)
  ), page as (select e.* from eligible e where e.dedupe_n=1 and (round(e.score::numeric,8),e.id)<(v_key,v_id) order by round(e.score::numeric,8) desc,e.id desc limit v_limit+1), chosen as (select * from page order by round(score::numeric,8) desc,id desc limit v_limit)
  select coalesce(jsonb_agg((x.c-'my_reaction')||jsonb_build_object('follow_reason',r.reason)
           ||case when r.match_kind in ('ticker','company') then jsonb_build_object('follow_match',r.match_kind,'follow_ticker',r.follow_ticker) when r.match_kind is not null then jsonb_build_object('follow_match',r.match_kind) else '{}'::jsonb end
           ||case when r.link_kind is null then '{}'::jsonb else jsonb_build_object('story_link',jsonb_build_object('kind',r.link_kind,'related_id',r.related_id,'related_headline',r.related_headline)) end order by x.o),'[]'::jsonb),
         case when (select count(*) from page)>v_limit then (select round(score::numeric,8)::text||'|'||id::text||'|'||to_char(v_asof at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from chosen order by round(score::numeric,8) asc,id asc limit 1) end into v_items,v_next
  from jsonb_array_elements(core.cards_json((select array_agg(id order by round(score::numeric,8) desc,id desc) from chosen),null)) with ordinality x(c,o) join chosen r on r.id=(x.c->>'id')::uuid;
  return jsonb_build_object('items',coalesce(v_items,'[]'::jsonb),'next_cursor',v_next);
end; $$;

revoke all on function api.following_feed(text[],text[],text[],text,int) from public;
grant execute on function api.following_feed(text[],text[],text[],text,int) to anon, authenticated, service_role;
