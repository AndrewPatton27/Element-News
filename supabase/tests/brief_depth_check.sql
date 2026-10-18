-- Checks for 20261018030000_brief_depth.sql; runs after that migration.
--   expected:     ERROR: ALL BRIEF DEPTH CHECKS PASSED (test rows rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Every row is inserted inside this DO statement and rolled back by the final deliberate error.
-- rank_score is set explicitly (1e6 minus an offset) so the test topics outrank any other card.
do $$
declare
  cats text[];
  per int[] := array[9,8,7,5,4,4,3,3,2,1];   -- cards per topic, most important topic first
  k int; j int; newid uuid; r jsonb; s jsonb; i int;
  exp_ret int[] := array[6,6,6,3,3,2,2,2];    -- daily: returned per section for ranks 1..8
  exp_wk  int[] := array[8,8,7,3,3,2,2,2];    -- weekly
  exp_tot int[] := array[9,8,7,5,4,4,3,3];
  sample jsonb := '[]'::jsonb;
  s24 int; s48 int; want int; n int;
begin
  select array_agg(slug order by sort_order) into cats from (select slug, sort_order from core.categories order by sort_order limit 10) q;
  if cardinality(cats) < 10 then raise exception 'SETUP: need at least 10 categories'; end if;

  for k in 1..10 loop
    for j in 1..per[k] loop
      insert into core.blurbs (dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score)
      values ('depth:'||lpad(k::text,2,'0')||':'||lpad(j::text,2,'0'),'summary','Depth topic '||k||' story '||j,'Plain body.',cats[k],'published','[]'::jsonb,
              now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour',5, 1000000 - k*100 - j)
      returning id into newid;
      insert into core.blurb_sources (blurb_id,name,kind,url,license_class,is_primary)
      values (newid,'Depth Test Source','news','https://example.com/depth/'||k||'/'||j,'company_filing',true);
    end loop;
  end loop;

  -- ---- daily: 8 sections, depth by importance, total/rank/slug, ordering ----
  r := api.daily_brief();
  if (r->>'window_hours')::int <> 24 then raise exception 'FAIL: daily window should be 24 with 40+ fresh cards, got %', r->>'window_hours'; end if;
  if jsonb_array_length(r->'sections') <> 8 then raise exception 'FAIL: daily should have 8 sections, got %', jsonb_array_length(r->'sections'); end if;
  for i in 1..8 loop
    s := r->'sections'->(i-1);
    if s->>'category' <> cats[i] or s->>'slug' <> cats[i] then raise exception 'FAIL: daily section % should be topic % (got %)', i, cats[i], s->>'category'; end if;
    if (s->>'rank')::int <> i then raise exception 'FAIL: daily section % rank is %', i, s->>'rank'; end if;
    if (s->>'total')::int <> exp_tot[i] then raise exception 'FAIL: daily section % total % <> %', i, s->>'total', exp_tot[i]; end if;
    if jsonb_array_length(s->'cards') <> exp_ret[i] then raise exception 'FAIL: daily section % returned % cards, expected %', i, jsonb_array_length(s->'cards'), exp_ret[i]; end if;
    if s->'cards'->0->>'headline' <> 'Depth topic '||i||' story 1' then raise exception 'FAIL: daily section % best story first (got %)', i, s->'cards'->0->>'headline'; end if;
    if s->'cards'->1->>'headline' <> 'Depth topic '||i||' story 2' then raise exception 'FAIL: daily section % order (got %)', i, s->'cards'->1->>'headline'; end if;
    sample := sample || jsonb_build_array(jsonb_build_object('topic',s->>'category','total',s->'total','returned',jsonb_array_length(s->'cards'))); 
  end loop;
  if exists (select 1 from jsonb_array_elements(r->'sections') x where x->>'category' in (cats[9],cats[10])) then raise exception 'FAIL: more than 8 sections'; end if;
  if (select count(distinct c->>'id') from jsonb_array_elements(r->'sections') x, jsonb_array_elements(x->'cards') c) <> (select sum(jsonb_array_length(x->'cards')) from jsonb_array_elements(r->'sections') x) then
    raise exception 'FAIL: a card is repeated across sections'; end if;

  -- ---- headlines: 3 cards from 3 different topics (the top 3) ----
  if jsonb_array_length(r->'headline_cards') <> 3 then raise exception 'FAIL: 3 headline cards'; end if;
  if (select count(distinct h->>'category') from jsonb_array_elements(r->'headline_cards') h) <> 3 then raise exception 'FAIL: headlines must be 3 different topics'; end if;
  if (r->'headline_cards'->0->>'headline') <> 'Depth topic 1 story 1' or (r->'headline_cards'->2->>'headline') <> 'Depth topic 3 story 1' then raise exception 'FAIL: headline order'; end if;

  -- ---- numbers still present, old keys kept ----
  if not (r ? 'numbers' and r ? 'generated_at' and r ? 'window_hours') then raise exception 'FAIL: brief keeps old keys'; end if;
  if jsonb_array_length(r->'numbers') > 4 then raise exception 'FAIL: numbers capped at 4'; end if;

  -- ---- weekly: deeper top 3 (8), movers kept, window 168 ----
  r := api.weekly_brief();
  if (r->>'window_hours')::int <> 168 then raise exception 'FAIL: weekly window'; end if;
  if not (r ? 'movers') then raise exception 'FAIL: weekly keeps movers'; end if;
  if jsonb_array_length(r->'sections') <> 8 then raise exception 'FAIL: weekly should have 8 sections'; end if;
  for i in 1..8 loop
    s := r->'sections'->(i-1);
    if jsonb_array_length(s->'cards') <> exp_wk[i] or (s->>'rank')::int <> i or (s->>'total')::int <> exp_tot[i] then
      raise exception 'FAIL: weekly section % returned %/total %/rank %, expected %/%/%', i, jsonb_array_length(s->'cards'), s->>'total', s->>'rank', exp_wk[i], exp_tot[i], i; end if;
  end loop;

  -- ---- topic order follows the best card, not the card count: a 1-card topic with the top score wins ----
  update core.blurbs set rank_score = 2000000 where dedupe_key = 'depth:10:01';
  r := api.daily_brief();
  if r->'sections'->0->>'category' <> cats[10] or (r->'sections'->0->>'total')::int <> 1 or jsonb_array_length(r->'sections'->0->'cards') <> 1 then
    raise exception 'FAIL: topic importance is the best card first (got %)', r->'sections'->0->>'category'; end if;
  update core.blurbs set rank_score = 1000000 - 10*100 - 1 where dedupe_key = 'depth:10:01';

  -- ---- window widening (other cards pushed out of the way first) ----
  update core.blurbs set sort_at = now() - interval '400 days' where dedupe_key not like 'depth:%';
  -- 5 cards at 1 h, 6 at 30 h, 3 at 60 h, the rest 400 days old: 24 h has 5 (<12), 48 h has 11 (<12) -> 72 h
  update core.blurbs b set sort_at = now() - case when q.rn <= 5 then interval '1 hour' when q.rn <= 11 then interval '30 hours' when q.rn <= 14 then interval '60 hours' else interval '400 days' end
    from (select id, row_number() over (order by dedupe_key) rn from core.blurbs where dedupe_key like 'depth:%') q where q.id = b.id;
  r := api.daily_brief();
  if (r->>'window_hours')::int <> 72 then raise exception 'FAIL: thin supply should widen to 72 h, got %', r->>'window_hours'; end if;
  -- 3 at 1 h, 12 at 30 h: 24 h has 3 (<12), 48 h has 15 -> 48 h
  update core.blurbs b set sort_at = now() - case when q.rn <= 3 then interval '1 hour' when q.rn <= 15 then interval '30 hours' else interval '400 days' end
    from (select id, row_number() over (order by dedupe_key) rn from core.blurbs where dedupe_key like 'depth:%') q where q.id = b.id;
  r := api.daily_brief();
  if (r->>'window_hours')::int <> 48 then raise exception 'FAIL: should widen to 48 h, got %', r->>'window_hours'; end if;
  -- 12 at 1 h: stays 24 h; weekly always 168
  update core.blurbs b set sort_at = now() - case when q.rn <= 12 then interval '1 hour' else interval '400 days' end
    from (select id, row_number() over (order by dedupe_key) rn from core.blurbs where dedupe_key like 'depth:%') q where q.id = b.id;
  r := api.daily_brief();
  if (r->>'window_hours')::int <> 24 then raise exception 'FAIL: 12 cards in 24 h must not widen, got %', r->>'window_hours'; end if;
  if (api.weekly_brief()->>'window_hours')::int <> 168 then raise exception 'FAIL: weekly window'; end if;

  -- ---- empty window: no sections, no error ----
  update core.blurbs set sort_at = now() - interval '400 days';
  r := api.daily_brief();
  if jsonb_array_length(r->'sections') <> 0 or jsonb_array_length(r->'headline_cards') <> 0 or (r->>'window_hours')::int <> 72 then raise exception 'FAIL: empty brief shape'; end if;

  -- ---- grants: public RPCs only; internal helpers are private ----
  if has_function_privilege('anon','api.daily_brief()','execute') is not true or has_function_privilege('anon','api.weekly_brief()','execute') is not true then raise exception 'FAIL: brief RPC grants'; end if;
  if has_function_privilege('anon','core.brief_build(int,int)','execute') or has_function_privilege('authenticated','core.brief_build(int,int)','execute')
     or has_function_privilege('anon','core.brief_supply(int)','execute') then raise exception 'FAIL: helpers must not be callable by app roles'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where (n.nspname,p.proname) in (('api','daily_brief'),('api','weekly_brief'),('core','brief_build'),('core','brief_supply'))
                and not (p.prosecdef and p.provolatile='s' and p.proconfig @> array['search_path=""'])) then
    raise exception 'FAIL: brief functions must be security definer, stable, search_path empty'; end if;

  raise exception 'ALL BRIEF DEPTH CHECKS PASSED (test rows rolled back on purpose) sections=%', sample;
end $$;
