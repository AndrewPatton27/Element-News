-- Search v10 (20261139000000_search_v10.sql): the v9 queries plus plain questions ("how much is gas", "rent and gas costs",
-- "is the economy ok" with a Fed card that never says economy). Original header follows.
-- Search v9 (20261137000200_search_v9.sql), the persona-run-3 queries. Same pool as lib/__tests__/searchRelevance.test.ts.
-- "Beige Book" must not return a travel company; "CPI" returns the CPI card first; "is the economy ok" -> macro cards;
-- "gas prices" / "diesel fuel" -> the oil card before Form 4 cards; "savings account interest" -> rates cards first;
-- a query naming a company still finds its Form 4 card. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  r jsonb; c record; q text; top text;
  function_ok boolean;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  create temp table s9 (k text primary key, id uuid) on commit drop;
  for c in select * from (values
    ('cpi',   'Consumer prices rise 3.2% in September', 'The consumer price index was up 3.2% from a year earlier.', 'economy', 'macro_release', '[{"series_id":"CPIAUCSL","label":"CPI","value":"3.2%"}]', 'government', 0),
    ('gdp',   'Economy grew 2.1% in the third quarter', 'Gross domestic product rose 2.1%.', 'economy', 'macro_release', '[{"series_id":"GDP","label":"GDP growth","value":"2.1%"}]', 'government', 0),
    ('oil',   'WTI crude oil falls to $61.40 a barrel', 'Crude fell on weaker demand, which can lower costs at the pump.', 'markets', 'macro_release', '[{"series_id":"DCOILWTICO","label":"WTI crude oil","value":"$61.40"}]', 'government', 0),
    ('fed',   'Fed holds its benchmark rate steady', 'The Federal Reserve left interest rates unchanged. Banks may keep savings account yields where they are.', 'economy', 'fed', '[]', 'government', 0),
    ('bank',  'Adatum Bank quarterly profit rises on higher lending income', 'Net interest income grew as loan balances increased.', 'earnings', 'earnings', '[]', 'filing', 30),
    ('travel','Margie''s Travel reports record bookings', 'Travel demand stayed strong this quarter.', 'earnings', 'earnings', '[]', 'filing', 30),
    ('coffee','Fourth Coffee lowers annual sales outlook', 'The company said a slow economy kept customers away.', 'earnings', 'earnings', '[]', 'filing', 60),
    ('f4a',   'Tailspin Air director reports open-market purchase', 'A director bought shares at average prices of $12. Cost basis rose.', 'earnings', 'insider', '[]', 'filing', 80),
    ('f4b',   'Fabrikam officer sells shares, Form 4 shows', 'The officer sold shares to cover taxes on gas and fuel stock awards. CPI mentioned in a footnote.', 'earnings', 'insider', '[]', 'filing', 80),
    ('fed2',  'Fed keeps rates on hold', 'Policymakers kept borrowing costs unchanged.', 'economy', 'fed', '[]', 'government', 0),
    ('rent',  'Rents rise 4.1% from a year ago', 'Shelter costs kept climbing.', 'economy', 'macro_release', '[{"series_id":"CUSR0000SEHA","label":"Rent of primary residence","value":"4.1%"}]', 'government', 0)
  ) v(k, h, b, cat, ev, macro, srck, boost) loop
    insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,tickers,macro,as_of,published_at,sort_at,importance,rank_score)
    values ('sv9-'||c.k,'summary',c.h,c.b,c.cat,c.ev,'published','[]',c.macro::jsonb,now(),now(),now(),4,base+c.boost);
    insert into s9 select c.k, id from core.blurbs where dedupe_key='sv9-'||c.k;
    insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
    select id,'SV9 Source',c.srck,'https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key='sv9-'||c.k;
  end loop;

  -- Beige Book: no travel company, no card at all in this pool
  r := api.search('Beige Book', null, 10);
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s9 where k='travel')) then
    raise exception 'FAIL: "Beige Book" returned the travel company: %', r->'items'; end if;

  -- CPI: the CPI card first, an insider card (CPI in a footnote) never ahead of it
  r := api.search('CPI', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s9 where k='cpi') then raise exception 'FAIL: CPI top was %', r->'items'->0->>'headline'; end if;

  -- "is the economy ok": macro cards first, the coffee company after them
  r := api.search('is the economy ok', null, 10);
  top := r->'items'->0->>'id';
  if top is null or top not in ((select id::text from s9 where k='gdp'), (select id::text from s9 where k='cpi')) then
    raise exception 'FAIL: "is the economy ok" top was %: %', r->'items'->0->>'headline', r->'items'; end if;
  if exists (select 1 from jsonb_array_elements(r->'items') with ordinality a(x,n), jsonb_array_elements(r->'items') with ordinality b(y,m)
              where a.x->>'id' = (select id::text from s9 where k='coffee') and b.y->>'id' = (select id::text from s9 where k='gdp') and a.n < b.m) then
    raise exception 'FAIL: the coffee company ranked above the GDP card'; end if;

  -- gas prices / diesel fuel: the oil card first, Form 4 cards after it
  foreach q in array array['gas prices','diesel fuel','gasoline'] loop
    r := api.search(q, null, 10);
    if r->'items'->0->>'id' is distinct from (select id::text from s9 where k='oil') then
      raise exception 'FAIL: "%" top was %: %', q, r->'items'->0->>'headline', r->'items'; end if;
  end loop;

  -- savings account interest: the Fed decision above the bank profit
  r := api.search('savings account interest', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s9 where k='fed') then
    raise exception 'FAIL: "savings account interest" top was %: %', r->'items'->0->>'headline', r->'items'; end if;
  if exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s9 where k='bank'))
     and (select min(n) from jsonb_array_elements(r->'items') with ordinality e(x,n) where x->>'id'=(select id::text from s9 where k='fed'))
       > (select min(n) from jsonb_array_elements(r->'items') with ordinality e(x,n) where x->>'id'=(select id::text from s9 where k='bank')) then
    raise exception 'FAIL: the bank profit ranked above the Fed decision'; end if;

  -- a whole-word rule: "cpi" does not match a word that merely starts with it, "prices" alone still searches
  if jsonb_array_length(api.search('prices', null, 10)->'items') = 0 then raise exception 'FAIL: "prices" alone found nothing'; end if;

  -- a name in the query keeps Form 4 cards in play (not demoted below non-matches): Tailspin finds its card first
  r := api.search('Tailspin', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s9 where k='f4a') then raise exception 'FAIL: Tailspin top was %', r->'items'->0->>'headline'; end if;

  -- v10: a Fed card that never says "economy" is a visible alias match and ranks above the coffee company
  r := api.search('is the economy ok', null, 10);
  if not exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s9 where k='fed2')) then
    raise exception 'FAIL: "is the economy ok" missed the Fed card: %', r->'items'; end if;
  if r->'items'->0->>'id' = (select id::text from s9 where k='coffee') then raise exception 'FAIL: coffee ranked first'; end if;

  -- v10: filler words
  r := api.search('how much is gas', null, 10);
  if r->'items'->0->>'id' is distinct from (select id::text from s9 where k='oil') then
    raise exception 'FAIL: "how much is gas" top was %: %', r->'items'->0->>'headline', r->'items'; end if;

  -- v10: all alias words: housing OR energy, Form 4 cards after them
  r := api.search('rent and gas costs', null, 10);
  if not exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s9 where k='rent'))
     or not exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = (select id::text from s9 where k='oil')) then
    raise exception 'FAIL: "rent and gas costs" missed the rent or oil card: %', r->'items'; end if;
  if (r->'items'->0->>'id') not in ((select id::text from s9 where k='rent'), (select id::text from s9 where k='oil')) then
    raise exception 'FAIL: "rent and gas costs" top was %', r->'items'->0->>'headline'; end if;

  -- v10: one real word beside an alias word still needs both
  if jsonb_array_length(api.search('gas Tailspin', null, 10)->'items') <> 0 then raise exception 'FAIL: "gas Tailspin" matched on one word'; end if;

  raise exception 'ALL SEARCH V10 CHECKS PASSED (test rows rolled back on purpose)';
end $$;
