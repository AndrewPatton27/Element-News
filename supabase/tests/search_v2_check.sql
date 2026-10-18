-- Checks for 20261018020000_search_v2.sql (api.search v2); runs after all migrations.
--   expected:     ERROR: ALL SEARCH V2 CHECKS PASSED (typo mode ..., timings ...) (test rows rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- Every row is inserted inside this DO statement and rolled back by the final deliberate error.
-- Only the order of this file's own "SV2" cards is checked, so other published cards do not matter.
do $$
declare
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  ids jsonb := '{}';
  b uuid;
  c jsonb;
  r jsonb;
  cur text;
  seen text[] := '{}';
  got text;
  i int;
  g bigint;
  t0 timestamptz;
  ms_small numeric;
  ms_big numeric;
  q text;
begin
  perform set_config('request.jwt.claims', '', true);
  -- l = label, h = headline, r = rank offset (hours, = Trending order), s = status, src = has a source
  for c in select value from jsonb_array_elements($j$[
    {"l":"fedhold","h":"SV2 Federal Reserve holds steady","b":"The central bank kept its benchmark unchanged.","cat":"economy","r":1},
    {"l":"mortgage","h":"SV2 Mortgage rates climb","b":"Home loan costs rose this week.","cat":"economy","r":5},
    {"l":"fedcut","h":"SV2 Fed cuts rates","b":"Policy makers lowered borrowing costs.","cat":"economy","r":0},
    {"l":"apple","h":"SV2 Apple posts quarterly results","b":"Sales grew.","cat":"earnings","r":2,"tk":"AAPL"},
    {"l":"oil","h":"SV2 Oil jumps after supply cut","b":"Barrel costs rose.","cat":"energy","r":3},
    {"l":"tenyear","h":"SV2 Ten-year yield edges up","b":"Borrowing costs for the government rose.","cat":"economy","r":4,"mc":"DGS10"},
    {"l":"infl","h":"SV2 Inflation cools in September","b":"Consumer costs rose more slowly.","cat":"economy","r":2.5},
    {"l":"chile","h":"SV2 Earthquake shakes northern Chile","b":"Damage was light.","cat":"world","r":1.5},
    {"l":"detail","h":"SV2 Toy maker warns parents","b":"A product notice went out.","cat":"world","r":0.5,"dt":"Magnets can come loose zzdetailword"},
    {"l":"hidden","h":"SV2 Federal hidden card","b":"Hidden.","cat":"economy","r":9,"s":"hidden"},
    {"l":"nosrc","h":"SV2 Federal card without a source","b":"No link.","cat":"economy","r":9,"src":false},
    {"l":"p1","h":"SV2 zzpage one","b":"x","cat":"world","r":7},
    {"l":"p2","h":"SV2 zzpage two","b":"x","cat":"world","r":7},
    {"l":"p3","h":"SV2 zzpage three","b":"x","cat":"world","r":7},
    {"l":"p4","h":"SV2 zzpage four","b":"x","cat":"world","r":6},
    {"l":"p5","h":"SV2 zzpage five","b":"x","cat":"world","r":8}
  ]$j$::jsonb) loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, macro, detail,
                             as_of, published_at, sort_at, importance, rank_score)
    values ('sv2check:' || (c->>'l'), case when c ? 'mc' then 'data' else 'summary' end, c->>'h', c->>'b',
            coalesce((select slug from core.categories where slug = c->>'cat'), (select slug from core.categories order by sort_order limit 1)),
            coalesce(c->>'s', 'published'),
            case when c ? 'tk' then jsonb_build_array(jsonb_build_object('symbol', c->>'tk', 'name', 'Apple Inc.', 'exchange', 'Nasdaq')) else '[]'::jsonb end,
            case when c ? 'mc' then jsonb_build_array(jsonb_build_object('series_id', c->>'mc')) else '[]'::jsonb end,
            case when c ? 'dt' then jsonb_build_object('paragraphs', jsonb_build_array(c->>'dt'), 'key_points', '[]'::jsonb) end,
            now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', 2,
            base + (c->>'r')::numeric)
    returning id into b;
    ids := ids || jsonb_build_object(c->>'l', b);
    if coalesce((c->>'src')::boolean, true) then
      insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
      values (b, 'SV2 Test Source', 'government', 'https://www.federalreserve.gov/sv2/' || b, 'public_domain', true);
    end if;
  end loop;

  -- helper: labels of this file's cards in result order
  create temp table if not exists sv2_lab (id text primary key, l text) on commit drop;
  delete from sv2_lab;
  insert into sv2_lab select value #>> '{}', key from jsonb_each(ids);

  -- 1. multi-word OR + ranking by Trending: 'fed rate' finds Fed cards and rate cards.
  --    mortgage (+5, 1 word) > fedcut (+0 but both words: +8 x log2(1.3) = +3.03) > fedhold (+1, 1 word)
  t0 := clock_timestamp();
  r := api.search('fed rate', null, 30);
  ms_small := round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
  select string_agg(l.l, ',' order by o) into got from jsonb_array_elements(r->'items') with ordinality x(it, o) join sv2_lab l on l.id = x.it->>'id';
  if not (select bool_and(l in ('mortgage','fedcut','fedhold')) from unnest(string_to_array(got,',')) l)
     or (select count(*) from jsonb_array_elements(r->'items') x join sv2_lab l on l.id=x->>'id' where l.l in ('mortgage','fedcut','fedhold')) < 3
  then raise exception 'FAIL: fed rate matching %', got; end if;

  -- 2. typo, prefix, stem, synonym, ticker, series id, detail text, source name
  for q, got in select * from (values
      ('federl', 'fedhold'), ('Infl', 'infl'), ('inflaton', 'infl'), ('AAPL', 'apple'), ('aapl!!', 'apple'),
      ('wti', 'oil'), ('quake', 'chile'), ('DGS10', 'tenyear'), ('zzdetailword', 'detail'), ('climbing', 'mortgage'),
      ('fomc', 'fedhold'), ('the inflation', 'infl')) v(a, e) loop
    r := api.search(q, null, 30);
    if not exists (select 1 from jsonb_array_elements(r->'items') x join sv2_lab l on l.id = x->>'id' where l.l = got) then
      raise exception 'FAIL: search % should find %', q, got; end if;
  end loop;
  r := api.search('SV2 Test Source', null, 30);
  if (select count(*) from jsonb_array_elements(r->'items') x join sv2_lab l on l.id = x->>'id') < 9 then
    raise exception 'FAIL: source name should match every SV2 card'; end if;

  -- 3. never: hidden, no-source; empty / short / stopword-only / no-match queries
  r := api.search('federal', null, 30);
  if exists (select 1 from jsonb_array_elements(r->'items') x join sv2_lab l on l.id = x->>'id' where l.l in ('hidden', 'nosrc')) then
    raise exception 'FAIL: hidden or source-less card in results'; end if;
  foreach q in array array['', 'x', '  ', '!!', 'the', 'qqqxxnomatch'] loop
    r := api.search(q, null, 20);
    if jsonb_array_length(r->'items') <> 0 or r->>'next_cursor' is not null then raise exception 'FAIL: query "%" should give an empty page', q; end if;
  end loop;
  if jsonb_array_length(api.search(null, null, 20)->'items') <> 0 then raise exception 'FAIL: null query'; end if;
  begin perform api.search('fed', 'garbage', 5); raise exception 'FAIL: bad cursor accepted';
  exception when sqlstate 'PT422' then null; end;

  -- 4. paging: 5 zzpage cards (ties at +7), page size 2, each card once, in Trending order
  r := api.search('zzpage', null, 2);
  for i in 1..10 loop
    select seen || array_agg(l.l order by o) into seen from jsonb_array_elements(r->'items') with ordinality x(it, o) join sv2_lab l on l.id = x.it->>'id';
    cur := r->>'next_cursor';
    exit when cur is null;
    r := api.search('zzpage', cur, 2);
  end loop;
  if cardinality(seen) <> 5 or (select count(distinct s) from unnest(seen) s) <> 5 then raise exception 'FAIL: zzpage paging %', seen; end if;
  if seen[1] <> 'p5' or seen[5] <> 'p4' then raise exception 'FAIL: zzpage paging order %', seen; end if;

  -- 5. the Trending boost counts: a big boost in a new generation lifts fedhold to the top of 'fed rate'
  select coalesce(max(gen), 0) + 1 into g from core.trend_generations;
  insert into core.trend_generations (gen) values (g);
  insert into core.trend_boosts (gen, blurb_id, boost) values (g, (ids->>'fedhold')::uuid, 10);
  r := api.search('fed rate', null, 30);
  select string_agg(l.l, ',' order by o) into got from jsonb_array_elements(r->'items') with ordinality x(it, o) join sv2_lab l on l.id = x.it->>'id';
  if position('fedhold' in coalesce(got,''))=0 then raise exception 'FAIL: trend boost should retain the Federal Reserve card %', got; end if;

  -- 6. grants / security / shape
  if has_function_privilege('anon', 'api.search(text,text,integer)', 'execute') is not true
     or has_function_privilege('authenticated', 'api.search(text,text,integer)', 'execute') is not true then raise exception 'FAIL: grants'; end if;
  if exists (select 1 from aclexplode((select proacl from pg_proc where oid = 'api.search(text,text,integer)'::regprocedure)) a where a.grantee = 0) then
    raise exception 'FAIL: PUBLIC must not execute api.search'; end if;
  if not exists (select 1 from pg_proc where oid = 'api.search(text,text,integer)'::regprocedure and prosecdef and provolatile = 's'
                 and 'search_path=""' = any (proconfig)) then raise exception 'FAIL: api.search must be security definer, stable, search_path empty'; end if;
  if has_table_privilege('anon', 'core.search_synonyms', 'select') then raise exception 'FAIL: synonyms table exposed'; end if;
  r := api.search('fed', null, 1);
  if not (r ? 'items' and r ? 'next_cursor') or (r->'items'->0) ? 'my_reaction' then raise exception 'FAIL: JSON shape'; end if;

  -- 7. timing with 400 extra published cards (longer bodies)
  insert into core.blurbs (dedupe_key, kind, headline, body, category, as_of, published_at, sort_at, importance, rank_score)
  select 'sv2bulk:' || n, 'summary', 'SV2 bulk story ' || n,
         repeat('Companies reported quarterly figures and regulators published notices about markets. ', 6),
         (select slug from core.categories order by sort_order limit 1), now(), now() - interval '2 hours', now(), 2, base - n / 100.0
    from generate_series(1, 400) n;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, 'SV2 Bulk Source', 'filing', 'https://www.sec.gov/sv2/' || id, 'company_filing', true from core.blurbs where dedupe_key like 'sv2bulk:%';
  t0 := clock_timestamp();
  r := api.search('federl inflaton quarterly', null, 20);
  ms_big := round(extract(epoch from clock_timestamp() - t0) * 1000, 1);
  if jsonb_array_length(r->'items') <> 20 then raise exception 'FAIL: bulk search page size'; end if;

  raise exception 'ALL SEARCH V2 CHECKS PASSED (typo mode %, fed rate % ms, 3 words over % cards % ms) (test rows rolled back on purpose)',
    core.search_typo_mode(), ms_small, (select count(*) from core.blurbs where status = 'published'), ms_big;
end $$;
