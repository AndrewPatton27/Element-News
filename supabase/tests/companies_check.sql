-- Checks for 20261115000000_companies.sql: tagging cases shared with contract/companyMatch.ts, the trigger
-- path (publish -> filing tag, revise -> re-tag), company search (ticker > name > prefix > typo), keyset paging
-- of api.company_cards, the directory counts, api.card_companies and grants. Rows roll back at the final error.
create temp table tag_cases (name text, headline text, body text, tickers text[], filing boolean, expect text, methods text);

-- BEGIN GENERATED TAGGING CASES (scripts/gen-companies-sql.mjs; do not edit by hand)
insert into pg_temp.tag_cases (name, headline, body, tickers, filing, expect, methods) values
  ('apple the fruit', 'Apple harvest falls as orchards face drought', 'Growers in Washington expect a smaller apple crop this year.', '{}'::text[], false, '', ''),
  ('Big Apple is New York', 'Big Apple rents hit a record', 'Median rent in New York City rose 4% as landlords raised prices.', '{}'::text[], false, '', ''),
  ('Apple plus a cue word', 'Apple unveils a cheaper iPhone', 'The phone goes on sale next week.', '{}'::text[], false, 'AAPL', 'context_cue'),
  ('Apple plus a business word', 'Apple shares slip after earnings', '', '{}'::text[], false, 'AAPL', 'context_biz'),
  ('Harrison Ford the actor', 'Harrison Ford to star in a new series', 'The actor signed a deal with a streaming company.', '{}'::text[], false, '', ''),
  ('a person named Ford mid-sentence', 'Studio hires director Ron Ford for its next film', 'The deal was announced on Monday.', '{}'::text[], false, '', ''),
  ('Ford the automaker', 'Ford recalls 500,000 F-150 pickups', 'The recall covers trucks built in 2024.', '{}'::text[], false, 'F', 'context_cue'),
  ('Ford Motor by full name', 'Ford Motor cuts its outlook', '', '{}'::text[], false, 'F', 'alias'),
  ('the Amazon rainforest', 'Amazon deforestation falls 30%', 'Brazil says satellite data show the lowest loss in a decade.', '{}'::text[], false, '', ''),
  ('Amazon the company', 'Amazon to hire 250,000 warehouse workers for the holidays', '', '{}'::text[], false, 'AMZN', 'context_cue'),
  ('student visas', 'Visa rules tighten for international students', 'Applicants will face longer waits.', '{}'::text[], false, '', ''),
  ('Visa and Mastercard', 'Visa and Mastercard settle swipe fee lawsuit', '', '{}'::text[], false, 'MA,V', 'alias,context_cue'),
  ('Chevron deference is a court doctrine', 'Supreme Court overturns Chevron deference', 'The ruling changes how agencies write rules.', '{}'::text[], false, '', ''),
  ('Oracle of Omaha is Warren Buffett', 'The Oracle of Omaha trims his bank stocks', '', '{}'::text[], false, 'BRK-B', 'alias'),
  ('exchange-prefixed ticker', 'Shares of Coinbase (Nasdaq: COIN) jump', '', '{}'::text[], false, 'COIN', 'ticker_text'),
  ('dollar ticker', '$TSLA options volume spikes', '', '{}'::text[], false, 'TSLA', 'ticker_text'),
  ('bare ticker that is not a word', 'NVDA leads a chip rally', '', '{}'::text[], false, 'NVDA', 'bare_ticker'),
  ('bare ticker that is a word', 'Rates stay LOW as the Fed waits', '', '{}'::text[], false, '', ''),
  ('SEC filing card', 'Apple reports quarterly results', '', array['AAPL'], true, 'AAPL', 'filing'),
  ('card tickers without a filing', 'Software maker lifts its forecast', '', array['MSFT'], false, 'MSFT', 'card_ticker'),
  ('at most three companies', 'Apple Inc, Microsoft, Nvidia, Netflix and Tesla lead gains', '', '{}'::text[], false, 'AAPL,MSFT,NFLX', ''),
  ('the Delta variant', 'Delta variant cases rise in Texas', '', '{}'::text[], false, '', ''),
  ('Delta the airline', 'Delta cancels 300 flights after a storm', '', '{}'::text[], false, 'DAL', 'context_cue'),
  ('Target the retailer', 'Target cuts prices on 2,000 items as shoppers pull back', '', '{}'::text[], false, 'TGT', 'context_cue'),
  ('an inflation target', 'Fed keeps its 2% inflation target', '', '{}'::text[], false, '', ''),
  ('curly apostrophe', 'Lowe’s raises its forecast', '', '{}'::text[], false, 'LOW', 'alias'),
  ('GM crops', 'EU weighs new rules on GM crops', '', '{}'::text[], false, '', ''),
  ('GeForce RTX is not RTX the defense company', 'Nvidia unveils the GeForce RTX 5090', '', '{}'::text[], false, 'NVDA', 'alias'),
  ('Paris Hilton', 'Paris Hilton launches a podcast company', '', '{}'::text[], false, '', ''),
  ('degrees Celsius', 'Temperatures top 40 degrees Celsius in Spain', '', '{}'::text[], false, '', ''),
  ('a meta-analysis', 'Meta-analysis links sleep to heart health', '', '{}'::text[], false, '', ''),
  ('the gender pay gap', 'Gender pay gap narrows', '', '{}'::text[], false, '', ''),
  ('Gap by its brands', 'Gap sales rise as Old Navy rebounds', '', '{}'::text[], false, 'GAP', 'alias'),
  ('Robin Hood the legend', 'Robin Hood remake tops the box office', '', '{}'::text[], false, '', ''),
  ('Klaus Schwab', 'Klaus Schwab steps down from the World Economic Forum', '', '{}'::text[], false, '', ''),
  ('$3M is three million', 'Startup raises $3M for battery recycling', '', '{}'::text[], false, '', ''),
  ('hyphenated ticker', 'Berkshire Hathaway (NYSE: BRK-B) buys more shares', '', '{}'::text[], false, 'BRK-B', 'ticker_text');
-- END GENERATED TAGGING CASES

do $$
declare
  r record; v_got text; v_m text; n int; v_dir int;
  a uuid; b uuid; f uuid; h uuid; i int; res jsonb; cur text; seen text[] := '{}'; pg int; ids text[];
begin
  -- 1. shared cases (same text in, same companies out as the TypeScript matcher)
  n := 0;
  for r in select * from pg_temp.tag_cases loop
    select coalesce(string_agg(m.ticker, ',' order by m.confidence desc, m.ticker collate "C"), ''),
           coalesce(string_agg(m.method, ',' order by m.confidence desc, m.ticker collate "C"), '')
      into v_got, v_m
    from (select * from core.match_companies(r.headline || ' ' || r.body, upper(r.tickers::text)::text[], r.filing)
          where confidence >= 0.60 order by confidence desc, ticker collate "C" limit 3) m;
    if v_got <> r.expect then raise exception 'FAIL: case "%": expected [%] got [%] (%)', r.name, r.expect, v_got, v_m; end if;
    if r.methods <> '' and v_m <> r.methods then raise exception 'FAIL: case "%": expected methods [%] got [%]', r.name, r.methods, v_m; end if;
    n := n + 1;
  end loop;
  if n < 30 then raise exception 'FAIL: only % tagging cases ran', n; end if;

  -- 2. directory: seeded, regexes derived, CIK from the SEC list, no prices anywhere
  if (select count(*) from core.companies) < 180 then raise exception 'FAIL: directory has % rows', (select count(*) from core.companies); end if;
  if (select cik from core.companies where ticker = 'AAPL') <> '0000320193' then raise exception 'FAIL: AAPL cik'; end if;
  if exists (select 1 from core.companies where ticker_re is null or search_terms = '{}' or trigrams = '{}') then raise exception 'FAIL: derived columns missing'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'companies' and column_name ~ 'price|quote') then
    raise exception 'FAIL: the directory must not hold prices'; end if;

  -- 3. trigger path: a filing card gets method 'filing' once its SEC source is written; a news card by alias
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
  values ('co:filing', 'summary', 'Apple reports quarterly results', 'Revenue rose 8%.', 'earnings', 'published',
          '[{"symbol":"AAPL","name":"Apple Inc.","exchange":"Nasdaq"}]', now(), now() - interval '2 hours', now() - interval '2 hours') returning id into a;
  if (select method from core.card_companies where blurb_id = a and ticker = 'AAPL') <> 'card_ticker' then raise exception 'FAIL: tag before the source'; end if;
  insert into core.blurb_sources (blurb_id, name, kind, doc_label, url, license_class, is_primary)
  values (a, 'SEC', 'filing', 'Form 8-K', 'https://www.sec.gov/Archives/edgar/data/320193/x-index.htm', 'company_filing', true);
  if (select method from core.card_companies where blurb_id = a and ticker = 'AAPL') <> 'filing' then raise exception 'FAIL: filing tag'; end if;

  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
  values ('co:news', 'summary', 'Harrison Ford signs a deal with a streaming company', 'The actor will star in a series.', 'world', 'published',
          '[]', now(), now() - interval '1 hour', now() - interval '1 hour') returning id into h;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  values (h, 'Wire', 'news', 'https://example.com/co-news', 'public_domain', true);
  if exists (select 1 from core.card_companies where blurb_id = h) then raise exception 'FAIL: Harrison Ford tagged as a company'; end if;
  -- revising the text re-tags it
  update core.blurbs set headline = 'Ford recalls 500,000 F-150 pickups', body = 'The recall covers trucks.' where id = h;
  if (select string_agg(ticker, ',') from core.card_companies where blurb_id = h) is distinct from 'F' then raise exception 'FAIL: re-tag on revise'; end if;
  -- a hidden card keeps its tag but is not counted or listed
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
  values ('co:hidden', 'summary', 'Ford Motor cuts its outlook', '', 'earnings', 'hidden', '[]', now(), now(), now()) returning id into f;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary) values (f, 'Wire', 'news', 'https://example.com/co-hidden', 'public_domain', true);

  -- 4. keyset paging over 25 Tesla cards (plus the visible Ford card above): 3 pages of 10, no repeats, newest first
  for i in 1..25 loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
    values ('co:tsla' || i, 'summary', 'Tesla delivery update ' || i, 'Shares moved.', 'markets', 'published', '[]',
            now(), now() - (i || ' hours')::interval, now() - (i || ' hours')::interval) returning id into b;
    insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary) values (b, 'Wire', 'news', 'https://example.com/co-tsla' || i, 'public_domain', true);
  end loop;
  -- same sort_at on two cards: the id breaks the tie, so paging still never repeats or skips
  update core.blurbs set sort_at = (select sort_at from core.blurbs where dedupe_key = 'co:tsla10') where dedupe_key = 'co:tsla11';

  v_dir := (select count(*) from core.companies where enabled);
  set local role anon;
  cur := null; n := 0;
  for pg in 1..4 loop
    res := api.company_cards('tsla', cur, 10);
    if res -> 'company' ->> 'ticker' <> 'TSLA' then raise exception 'FAIL: company row'; end if;
    for v_got in select x ->> 'id' from jsonb_array_elements(res -> 'items') x loop
      if v_got = any(seen) then raise exception 'FAIL: repeated card on page %', pg; end if;
      seen := seen || v_got; n := n + 1;
    end loop;
    cur := res ->> 'next_cursor';
    exit when cur is null;
  end loop;
  if n <> 25 then raise exception 'FAIL: paging returned % of 25 Tesla cards', n; end if;
  ids := (select array_agg(x ->> 'sort_at' order by k) from jsonb_array_elements(api.company_cards('TSLA', null, 30) -> 'items') with ordinality e(x, k));
  if ids[1]::timestamptz < ids[2]::timestamptz then raise exception 'FAIL: newest first'; end if;
  if (api.company_cards('TSLA', null, 30) -> 'items' -> 0 -> 'sources') is null then raise exception 'FAIL: cards carry sources'; end if;
  if api.company_cards('ZZZZ', null, 10) -> 'company' <> 'null'::jsonb then raise exception 'FAIL: unknown ticker'; end if;
  begin
    perform api.company_cards('TSLA', 'not-a-cursor', 10);
    raise exception 'FAIL: bad cursor accepted';
  exception when sqlstate '22023' then null;
  end;

  -- hidden card not listed or counted
  if exists (select 1 from jsonb_array_elements(api.company_cards('F', null, 30) -> 'items') x where (x ->> 'id')::uuid = f) then raise exception 'FAIL: hidden card listed'; end if;
  if (api.company_cards('F', null, 30) -> 'company' ->> 'card_count')::int <> 1 then raise exception 'FAIL: F count %', api.company_cards('F', null, 30) -> 'company' ->> 'card_count'; end if;

  -- 5. search: exact ticker first, alias/name, prefix, typo; counts attached; nothing for gibberish
  res := api.search_companies('AAPL', 5);
  if res -> 0 ->> 'ticker' <> 'AAPL' or res -> 0 ->> 'match' <> 'ticker' then raise exception 'FAIL: ticker search %', res; end if;
  if (res -> 0 ->> 'card_count')::int <> 1 then raise exception 'FAIL: AAPL count %', res -> 0 ->> 'card_count'; end if;
  if api.search_companies('$tsla', 5) -> 0 ->> 'ticker' <> 'TSLA' then raise exception 'FAIL: $ticker'; end if;
  if api.search_companies('Facebook', 5) -> 0 ->> 'ticker' <> 'META' then raise exception 'FAIL: alias search'; end if;
  if api.search_companies('lowes', 5) -> 0 ->> 'ticker' <> 'LOW' then raise exception 'FAIL: apostrophe-free name'; end if;
  if api.search_companies('home dep', 5) -> 0 ->> 'ticker' <> 'HD' then raise exception 'FAIL: prefix search'; end if;
  if api.search_companies('mircosoft', 5) -> 0 ->> 'ticker' <> 'MSFT' then raise exception 'FAIL: typo search %', api.search_companies('mircosoft', 5); end if;
  if api.search_companies('nvidea', 5) -> 0 ->> 'ticker' <> 'NVDA' then raise exception 'FAIL: typo search nvidea'; end if;
  if (api.search_companies('mircosoft', 5) -> 0 ->> 'match') <> 'typo' then raise exception 'FAIL: typo match label'; end if;
  if jsonb_array_length(api.search_companies('qqqqzzzz', 5)) <> 0 then raise exception 'FAIL: gibberish matched'; end if;
  if jsonb_array_length(api.search_companies('', 5)) <> 0 then raise exception 'FAIL: empty query'; end if;
  if jsonb_array_length(api.search_companies('a', 50)) > 10 then raise exception 'FAIL: search cap'; end if;

  -- 6. directory: every company once, recent counts, grouped by sector
  res := api.companies_directory(null);
  if jsonb_array_length(res) <> v_dir then raise exception 'FAIL: directory size'; end if;
  if (select (x ->> 'card_count')::int from jsonb_array_elements(res) x where x ->> 'ticker' = 'TSLA') <> 25 then raise exception 'FAIL: TSLA count'; end if;
  if (select count(*) from jsonb_array_elements(res) x where x ? 'aliases' or x ? 'strong_re') > 0 then raise exception 'FAIL: internals leaked'; end if;

  -- 7. chips: tags of visible cards only, capped batch
  res := api.card_companies(array[a, h, f]);
  if jsonb_array_length(res) <> 2 then raise exception 'FAIL: card_companies size %', res; end if;
  if (select x -> 'companies' -> 0 ->> 'short_name' from jsonb_array_elements(res) x where (x ->> 'id')::uuid = a) <> 'Apple' then raise exception 'FAIL: chip name'; end if;
  if jsonb_array_length(api.card_companies((select array_agg(gen_random_uuid()) from generate_series(1, 500)))) <> 0 then raise exception 'FAIL: random ids'; end if;

  -- 8. grants: anon cannot re-tag or read core tables
  begin
    perform api.retag_companies(30);
    raise exception 'FAIL: anon can re-tag';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from core.card_companies limit 1;
    raise exception 'FAIL: anon reads core.card_companies';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- the search hook: exact names score above prefix and typo matches
  if (select score from core.company_query_scores('Tesla') where ticker = 'TSLA') <> 0.95 then raise exception 'FAIL: name score'; end if;

  -- 9. re-tag is idempotent
  n := (select count(*) from core.card_companies);
  perform core.retag_cards(now() - interval '30 days');
  if (select count(*) from core.card_companies) <> n then raise exception 'FAIL: re-tag changed the tag count'; end if;

  raise exception 'ALL COMPANIES CHECKS PASSED';
end $$;
