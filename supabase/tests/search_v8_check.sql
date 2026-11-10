-- Search v8 (20261122000100_search_v8.sql): whole words, aliases first, AND, minimum relevance, recency, synonyms.
-- Reported queries from the user study: "Powell" must not match power banks, "Fed" must not lead with FedEx,
-- "interest rates" must not find Pinterest, and bitcoin / Coinbase / rent / Best Buy / housing / mortgage / tariffs /
-- stock market must return the expected top card. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  r jsonb; c record; v_ok boolean;
  c_new uuid; c_old uuid;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.categories (slug, name, sort_order) values ('safety','Recalls & Safety',22) on conflict (slug) do nothing;
  if (select value from core.rank_params where key='search_min_relevance') is distinct from 0.05
     or (select value from core.rank_params where key='search_recency_weight') is distinct from 0.3 then
    raise exception 'FAIL: v8 defaults must be min relevance 0.05, recency weight 0.3'; end if;
  v_ok := false; begin update core.rank_params set value = 0.9 where key = 'search_min_relevance'; exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'FAIL: search_min_relevance 0.9 accepted'; end if;
  v_ok := false; begin update core.rank_params set value = 1.5 where key = 'search_recency_weight'; exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'FAIL: search_recency_weight 1.5 accepted'; end if;

  create temp table s8 (k text primary key, id uuid) on commit drop;
  for c in select * from (values
    ('powell',  'Powell says the Fed is in no hurry to cut rates', 'The Federal Reserve chair spoke on Tuesday.', 'economy', '[]', 0),
    ('bank',    'Power bank recall over battery fire risk', 'The power banks were sold online.', 'safety', '[]', 0),
    ('fed',     'Fed holds interest rates steady', 'The Federal Reserve kept its policy rate unchanged.', 'economy', '[]', 20),
    ('fedex',   'FedEx raises its profit outlook', 'FedEx said shipping volume grew.', 'earnings', '[{"symbol":"FDX","name":"FedEx Corp."}]', 0),
    ('rates',   'Treasury yields rise as interest rates stay high', 'Investors priced fewer cuts.', 'markets', '[]', 30),
    ('pins',    'Pinterest shares jump after strong results', 'Pinterest users grew.', 'earnings', '[{"symbol":"PINS","name":"Pinterest, Inc."}]', 0),
    ('rateonly','Mortgage rates fall for a third week', 'The average 30-year rate eased.', 'economy', '[]', 40),
    ('btc',     'Bitcoin tops $100,000 for the first time', 'The crypto rally continued.', 'markets', '[]', 0),
    ('coin',    'Coinbase reports record quarterly revenue', 'Trading volume rose.', 'earnings', '[{"symbol":"COIN","name":"Coinbase Global"}]', 10),
    ('rent',    'Rent growth slows in October', 'Apartment rents rose less than last year.', 'economy', '[]', 0),
    ('current', 'Current account deficit narrows', 'The gap with the rest of the world shrank.', 'economy', '[]', 0),
    ('bby',     'Best Buy cuts its sales outlook', 'The electronics retailer cited weak demand.', 'earnings', '[{"symbol":"BBY","name":"Best Buy Co."}]', 0),
    ('best',    'Best month for hiring in a year', 'Employers added jobs.', 'economy', '[]', 5),
    ('hs',      'Housing starts fall to 1.22M', 'Builders started fewer homes.', 'economy', '[]', 0),
    ('hplastic','Charger recall over plastic housing crack', 'The plastic housing can crack.', 'safety', '[]', 0),
    ('mort',    'Home loan costs climb as refinance demand drops', 'Lenders reported fewer applications.', 'economy', '[]', 0),
    ('tar',     'Trade war escalates as new duties take effect', 'Importers face higher costs.', 'economy', '[]', 0),
    ('stk',     'Equities slip as markets turn lower', 'Wall Street ended the day down.', 'markets', '[]', 0)
  ) v(k, h, b, cat, tk, boost) loop
    insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance,rank_score)
    values ('sv8-'||c.k,'summary',c.h,c.b,c.cat,'published',c.tk::jsonb,now(),now(),now(),4,base+c.boost);
    insert into s8 select c.k, id from core.blurbs where dedupe_key='sv8-'||c.k;
  end loop;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV8 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sv8-%';

  -- Powell: the Powell card, never the power bank
  r := api.search('Powell', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s8 where k='powell') then raise exception 'FAIL: Powell top: %', r->'items'->0->>'headline'; end if;
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s8 where k='bank')) then
    raise exception 'FAIL: Powell matched the power bank'; end if;
  -- ... also when no card says Powell yet (no typo fuzzy to "power")
  update core.blurbs set headline = 'Fed chair signals patience on cuts', body = 'The central bank chair spoke.' where id = (select id from s8 where k='powell');
  delete from core.search_words where word = 'powell';
  if exists (select 1 from jsonb_array_elements(api.search('Powell', null, 10)->'items') x where x->>'id' = (select id::text from s8 where k='bank')) then
    raise exception 'FAIL: Powell fuzzy-matched power bank'; end if;
  -- the alias tier: "Fed chair" card is found through the synonym group
  if not exists (select 1 from jsonb_array_elements(api.search('Powell', null, 10)->'items') x where x->>'id' = (select id::text from s8 where k='powell')) then
    raise exception 'FAIL: Powell must reach the Fed chair card by synonym'; end if;

  -- Fed: Fed / Federal Reserve cards first, FedEx not first (and a card saying only Fed is not displaced by it)
  r := api.search('Fed', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s8 where k='fed') then raise exception 'FAIL: Fed top: %', r->'items'->0->>'headline'; end if;
  if (select x->>'id' from jsonb_array_elements(r->'items') x limit 1) = (select id::text from s8 where k='fedex') then raise exception 'FAIL: FedEx first for Fed'; end if;
  if (select count(*) from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s8 where k='fedex')) <> 0 then
    raise exception 'FAIL: FedEx should not match Fed at all (whole words)'; end if;
  -- the company itself is still found by name
  if api.search('FedEx', null, 10)->'items'->0->>'id' is distinct from (select id::text from s8 where k='fedex') then raise exception 'FAIL: FedEx query'; end if;

  -- interest rates: AND, no Pinterest, rates-only card (mortgage) not listed, both-words cards first
  r := api.search('interest rates', null, 10);
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s8 where k='pins')) then raise exception 'FAIL: interest rates matched Pinterest'; end if;
  if r->'items'->0->>'id' not in ((select id::text from s8 where k='fed'), (select id::text from s8 where k='rates')) then
    raise exception 'FAIL: interest rates top: %', r->'items'->0->>'headline'; end if;
  -- AND: a word that no card has removes every result
  if jsonb_array_length(api.search('interest rates zzqxjk', null, 10)->'items') <> 0 then raise exception 'FAIL: AND with an unknown word must return nothing'; end if;

  -- bitcoin / Coinbase
  if api.search('bitcoin', null, 10)->'items'->0->>'id' is distinct from (select id::text from s8 where k='btc') then raise exception 'FAIL: bitcoin top'; end if;
  if api.search('Coinbase', null, 10)->'items'->0->>'id' is distinct from (select id::text from s8 where k='coin') then raise exception 'FAIL: Coinbase top'; end if;
  if not exists (select 1 from jsonb_array_elements(api.search('crypto', null, 10)->'items') x where x->>'id' = (select id::text from s8 where k='btc')) then
    raise exception 'FAIL: crypto synonym should find the bitcoin card'; end if;

  -- rent (not "current"), Best Buy (both words), housing
  r := api.search('rent', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s8 where k='rent') then raise exception 'FAIL: rent top'; end if;
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s8 where k='current')) then raise exception 'FAIL: rent matched current'; end if;
  r := api.search('Best Buy', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s8 where k='bby') then raise exception 'FAIL: Best Buy top'; end if;
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s8 where k='best')) then raise exception 'FAIL: Best Buy matched a card with only Best'; end if;
  r := api.search('housing', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s8 where k='hs') then raise exception 'FAIL: housing top: %', r->'items'->0->>'headline'; end if;

  -- synonyms: mortgage <-> home loan, tariffs <-> trade war / duties, stock market <-> equities / markets
  if not exists (select 1 from jsonb_array_elements(api.search('mortgage', null, 10)->'items') x where x->>'id' = (select id::text from s8 where k='mort')) then raise exception 'FAIL: mortgage synonym'; end if;
  if not exists (select 1 from jsonb_array_elements(api.search('tariffs', null, 10)->'items') x where x->>'id' = (select id::text from s8 where k='tar')) then raise exception 'FAIL: tariffs synonym'; end if;
  if api.search('stock market', null, 10)->'items'->0->>'id' is distinct from (select id::text from s8 where k='stk') then raise exception 'FAIL: stock market synonym'; end if;

  -- recency: equal text and equal rank_score, the newer card first
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv8-old','summary','Zentaro opens a new plant','Output will grow.','economy','published',now(),now(),now()-interval '120 hours',4,base-1) returning id into c_old;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv8-new','summary','Zentaro opens a new office','Output will grow.','economy','published',now(),now(),now()-interval '1 hour',4,base-1) returning id into c_new;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV8 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where id in (c_old, c_new);
  r := api.search('zentaro', null, 10);
  if r->'items'->0->>'id' is distinct from c_new::text then raise exception 'FAIL: the newer card must lead at equal relevance'; end if;

  -- security unchanged
  if not exists (select 1 from pg_proc where oid='api.search(text,text,int)'::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must stay security definer with an empty search_path'; end if;
  if has_table_privilege('anon','core.search_aliases','select') or has_table_privilege('authenticated','core.search_aliases','select') then
    raise exception 'FAIL: search_aliases readable by client roles'; end if;
  raise exception 'ALL SEARCH V8 CHECKS PASSED (test rows rolled back on purpose)';
end $$;
