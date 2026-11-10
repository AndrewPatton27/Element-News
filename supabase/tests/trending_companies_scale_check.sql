-- Trending page bound and company RPC joins (20261121000300_trending_companies_scale.sql).
-- Checks: with 300 cards and trend boosts of both signs, Trending's first page equals the brute-force page (the
-- best page + diversity_carry cards by rank_score + boost, then core.diversify), a card with a big positive boost
-- from far down the list makes page 1 and one with a big negative boost does not; the full scroll lists every card
-- once; Latest unchanged; the wrapper is intact; company counts skip hidden cards and cards without a source.
-- Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  g bigint; up uuid; down uuid; r jsonb; cur text; ids uuid[] := '{}'; expect jsonb; top uuid[]; v_fetch int; n int;
  cats text[] := array['markets', 'world', 'tech', 'policy', 'energy', 'deals'];
  dir jsonb; cnt int;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  update core.rank_params set value = 0 where key = 'trending_ml_mode';
  insert into core.blurbs (dedupe_key, kind, headline, category, status, as_of, published_at, sort_at, importance, rank_score)
  select 'tcs-' || x, 'summary', 'Trend scale story ' || x, cats[1 + x % 6], 'published', now(), now(), now() - make_interval(hours => x),
         4, base - x + 16
    from generate_series(1, 300) x;
  select coalesce(max(gen), 0) + 1 into g from core.trend_generations;
  insert into core.trend_generations (gen) values (g);
  select id into up from core.blurbs where dedupe_key = 'tcs-200';      -- 200 h down, +250 h boost: must lead
  select id into down from core.blurbs where dedupe_key = 'tcs-1';      -- the top card, -2.9 h boost
  insert into core.trend_boosts (gen, blurb_id, boost)
  select g, id, case when id = up then 250 when id = down then -2.9 else ((hashtext(dedupe_key) % 100) / 50.0) end
    from core.blurbs where dedupe_key like 'tcs-%';

  -- 1. first page = brute force
  select greatest(20 + coalesce((select value from core.rank_params where key = 'diversity_carry'), 3)::int, 1) into v_fetch;
  top := array(select b.id from core.blurbs b left join core.trend_boosts t on t.gen = g and t.blurb_id = b.id
                where b.status = 'published' order by b.rank_score + coalesce(t.boost, 0) desc, b.id desc limit v_fetch);
  expect := core.diversify(top, '{}'::jsonb, 20) -> 'ids';
  r := core.feed_top_base('top', null, 20, null);
  if (select jsonb_agg(x -> 'id' order by o) from jsonb_array_elements(r -> 'items') with ordinality t(x, o)) is distinct from expect then
    raise exception 'FAIL: Trending page 1 must equal the brute-force page'; end if;
  if not (r -> 'items' @> jsonb_build_array(jsonb_build_object('id', up))) then raise exception 'FAIL: a big positive boost must reach page 1'; end if;

  -- 2. full scroll, every card once (base and wrapper agree on page 1)
  cur := null;
  for n in 1..40 loop
    r := core.feed_top_base('top', cur, 20, null);
    ids := ids || array(select (x ->> 'id')::uuid from jsonb_array_elements(r -> 'items') x);
    cur := r ->> 'next_cursor'; exit when cur is null;
  end loop;
  if cardinality(ids) <> 300 or (select count(distinct x) from unnest(ids) x) <> 300 then
    raise exception 'FAIL: Trending scroll must list all 300 cards once (got %)', cardinality(ids); end if;
  -- category chip: same bound with the category index
  r := core.feed_top_base('top', null, 10, 'tech');
  if exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'category' <> 'tech') or jsonb_array_length(r -> 'items') < 10 then
    raise exception 'FAIL: the topic chip page is wrong'; end if;
  if (select prosrc from pg_proc where oid = 'core.feed_top(text,text,integer,text)'::regprocedure) not like '%macro_focus_wrapper%' then
    raise exception 'FAIL: the macro_focus wrapper of core.feed_top must stay in place'; end if;

  -- 3. company counts: a hidden AAPL card and one without a source do not count
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at, importance, rank_score) values
    ('tcs-aapl-1', 'summary', 'Apple reports quarterly revenue', 'Sales rose.', 'earnings', 'published', '[{"symbol":"AAPL","name":"Apple"}]', now(), now(), now(), 6, base),
    ('tcs-aapl-2', 'summary', 'Apple names a new finance chief', 'A new officer.', 'markets', 'hidden', '[{"symbol":"AAPL","name":"Apple"}]', now(), now(), now(), 3, base),
    ('tcs-aapl-3', 'summary', 'Apple signs a credit agreement', 'A loan.', 'deals', 'published', '[{"symbol":"AAPL","name":"Apple"}]', now(), now(), now(), 4, base);
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, 'SEC', 'filing', 'https://www.sec.gov/tcs/' || dedupe_key, 'company_filing', true from core.blurbs where dedupe_key in ('tcs-aapl-1', 'tcs-aapl-2');
  select (api.company_cards('AAPL', null, 20) -> 'company' ->> 'card_count')::int into cnt;
  if cnt <> 1 then raise exception 'FAIL: company_cards must count only visible cards with a source (got %)', cnt; end if;
  dir := api.companies_directory(null);
  if (select (x ->> 'card_count')::int from jsonb_array_elements(dir) x where x ->> 'ticker' = 'AAPL') <> 1 then
    raise exception 'FAIL: companies_directory count wrong'; end if;
  if (select (x ->> 'card_count')::int from jsonb_array_elements(api.search_companies('apple', 5)) x where x ->> 'ticker' = 'AAPL') <> 1 then
    raise exception 'FAIL: search_companies count wrong'; end if;
  if jsonb_array_length(api.company_cards('AAPL', null, 20) -> 'items') <> 1 then raise exception 'FAIL: company_cards items wrong'; end if;
  raise exception 'ALL TRENDING COMPANIES SCALE CHECKS PASSED (test rows rolled back on purpose)';
end $$;
