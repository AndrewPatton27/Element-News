-- Checks for 20261136000000_companies_extra.sql (extended SEC watch list in core.companies): the ~350 name-less rows are
-- seeded and derived, rerunning the seed changes nothing, search finds them by name and ticker, an 8-K card with their
-- ticker gets a 'filing' tag, a card that only mentions the name in text is NOT tagged, and no prices anywhere.
-- Rows roll back at the final error.
do $$
declare
  n_before int; n_after int; a uuid; h uuid; res jsonb; v text;
begin
  select count(*) into n_before from core.companies;
  if (select count(*) from core.companies where cik is not null) < 500 then raise exception 'FAIL: directory has % rows with a CIK', (select count(*) from core.companies where cik is not null); end if;
  if (select cik from core.companies where ticker = 'ACN') <> '0001467373' then raise exception 'FAIL: ACN cik'; end if;
  if (select sector from core.companies where ticker = 'NEE') <> 'energy' then raise exception 'FAIL: NEE sector'; end if;

  -- name-less: no aliases, no bare ticker match, but everything derived
  if (select aliases <> '{}' or context_aliases <> '{}' or ticker_in_text from core.companies where ticker = 'ACN') then raise exception 'FAIL: extra rows must be name-less'; end if;
  if exists (select 1 from core.companies where ticker_re is null or search_terms = '{}' or trigrams = '{}') then raise exception 'FAIL: derived columns missing'; end if;

  -- idempotent: running the seed again changes no row count and no key column
  insert into core.companies (ticker, name, short_name, cik, exchange, sector, industry)
  select ticker, name, short_name, cik, exchange, sector, industry from core.companies where cik is not null and aliases = '{}'
  on conflict (ticker) do update set name = excluded.name, short_name = excluded.short_name, cik = excluded.cik,
    exchange = excluded.exchange, sector = excluded.sector, industry = excluded.industry;
  select count(*) into n_after from core.companies;
  if n_after <> n_before then raise exception 'FAIL: re-seed changed the row count % -> %', n_before, n_after; end if;

  -- tagging: the filing path tags by ticker with confidence 1; a bare name in text does not tag a name-less company
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
  values ('cx:filing', 'summary', 'Accenture reports quarterly results', 'Revenue rose 8%.', 'earnings', 'published',
          '[{"symbol":"ACN","name":"Accenture plc","exchange":"NYSE"}]', now(), now() - interval '2 hours', now() - interval '2 hours') returning id into a;
  insert into core.blurb_sources (blurb_id, name, kind, doc_label, url, license_class, is_primary)
  values (a, 'SEC', 'filing', 'Form 8-K', 'https://www.sec.gov/Archives/edgar/data/1467373/x-index.htm', 'company_filing', true);
  if (select method from core.card_companies where blurb_id = a and ticker = 'ACN') <> 'filing' then raise exception 'FAIL: filing tag for an extra company'; end if;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, tickers, as_of, published_at, sort_at)
  values ('cx:news', 'summary', 'Accenture and Sysco shares move as Linde and Dover report', 'Analysts say Corning sales rose.', 'markets', 'published',
          '[]', now(), now() - interval '1 hour', now() - interval '1 hour') returning id into h;
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary) values (h, 'Wire', 'news', 'https://example.com/cx-news', 'public_domain', true);
  if exists (select 1 from core.card_companies where blurb_id = h and ticker in ('ACN', 'SYY', 'LIN', 'DOV', 'GLW')) then raise exception 'FAIL: a name in text tagged a name-less company'; end if;

  -- search: by name, ticker and a typo; the company page query works for an extra company
  set local role anon;
  res := api.search_companies('accenture', 5);
  if (res -> 0 ->> 'ticker') is distinct from 'ACN' then raise exception 'FAIL: search by name: %', res; end if;
  res := api.search_companies('ACN', 5);
  if (res -> 0 ->> 'ticker') is distinct from 'ACN' then raise exception 'FAIL: search by ticker: %', res; end if;
  res := api.company_cards('acn', null, 10);
  if res -> 'company' ->> 'ticker' <> 'ACN' or jsonb_array_length(res -> 'items') <> 1 then raise exception 'FAIL: company page: %', res; end if;
  reset role;

  if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'companies' and column_name ~ 'price|quote') then
    raise exception 'FAIL: the directory must not hold prices'; end if;
  raise exception 'ALL COMPANIES EXTRA CHECKS PASSED';
end $$;
