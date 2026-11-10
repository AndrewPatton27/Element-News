-- Checks for 20261122000000_entity_tags_related.sql. Test rows roll back at the deliberate final error.
-- Microsoft Q4-style card: related_cards returns no other issuer (no category fallback), only same ticker/CIK;
-- "159.3M" is not tagged as 3M; data cards carry no tickers; cleanup removes tickers without a whole-word match.
do $$
declare
  msft uuid; msft2 uuid; aapl uuid; pay uuid; dat uuid; bad uuid; r jsonb;
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:msft','summary','Microsoft reports fourth-quarter results','Microsoft said cloud revenue grew.','earnings','published',
          '[{"symbol":"MSFT","name":"Microsoft Corp."}]',now(),now(),now(),10) returning id into msft;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:msft2','summary','Microsoft announces a cloud deal','Microsoft signed a new customer.','earnings','published',
          '[{"symbol":"MSFT","name":"Microsoft Corp."}]',now(),now(),now()-interval '1 day',5) returning id into msft2;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:aapl','summary','Apple reports quarterly results','Apple said iPhone sales rose.','earnings','published',
          '[{"symbol":"AAPL","name":"Apple Inc."}]',now(),now(),now(),10) returning id into aapl;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:pay','summary','Payrolls rose in October','Employers added jobs; wages grew and average pay hit 159.3M dollars of total weekly payroll.','economy','published',
          '[]',now(),now(),now(),10) returning id into pay;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:data','data','Payrolls 159.3M','Total nonfarm payrolls were 159.3M.','economy','published',
          '[{"symbol":"MSFT","name":"Microsoft Corp."}]',now(),now(),now(),10) returning id into dat;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'Entity check','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'et:%';

  -- related_cards: same issuer only, never another issuer in the same category
  r := api.related_cards(msft, 10);
  if exists (select 1 from jsonb_array_elements(r) x where x->>'id' = aapl::text) then raise exception 'FAIL: related_cards returned another issuer: %', r; end if;
  if not exists (select 1 from jsonb_array_elements(r) x where x->>'id' = msft2::text) then raise exception 'FAIL: related_cards missed the same ticker: %', r; end if;
  if jsonb_array_length(r) <> 1 then raise exception 'FAIL: related_cards must return only the same-ticker card: %', r; end if;
  r := api.related_cards(pay, 10);
  if jsonb_array_length(r) <> 0 then raise exception 'FAIL: a macro card has no entity overlap: %', r; end if;

  -- 3M: a decimal value with a suffix is not the company
  if exists (select 1 from core.card_companies where blurb_id in (pay, dat) and ticker = 'MMM') then raise exception 'FAIL: 159.3M tagged as 3M'; end if;
  if (select count(*) from core.match_companies('Total payrolls were 159.3M, up from $92.3B.') where ticker = 'MMM') <> 0 then raise exception 'FAIL: match_companies read 159.3M as 3M'; end if;
  if (select count(*) from core.match_companies('3M reported results today.') where ticker = 'MMM') <> 1 then raise exception 'FAIL: match_companies must still find 3M by name'; end if;

  -- data cards never keep tickers (trigger), even when written
  if (select tickers from core.blurbs where id = dat) <> '[]'::jsonb then raise exception 'FAIL: data card kept tickers'; end if;
  update core.blurbs set tickers = '[{"symbol":"AAPL"}]' where id = dat;
  if (select tickers from core.blurbs where id = dat) <> '[]'::jsonb then raise exception 'FAIL: data card tickers update not emptied'; end if;

  -- cleanup: a ticker with no whole-word match goes, a matching one stays; idempotent
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,tickers,as_of,published_at,sort_at,importance)
  values ('et:bad','summary','Retail sales surprise to the upside','Shoppers spent more at stores in October.','economy','published',
          '[{"symbol":"MMM","name":"3M Co."},{"symbol":"AAPL","name":"Apple Inc."}]',now(),now(),now(),10) returning id into bad;
  if (select count(*) from core.card_ticker_mismatches() where blurb_id = bad) <> 2 then raise exception 'FAIL: mismatch list: %', (select array_agg(symbol) from core.card_ticker_mismatches() where blurb_id = bad); end if;
  if core.clean_card_tickers() < 1 then raise exception 'FAIL: cleanup changed nothing'; end if;
  if (select tickers from core.blurbs where id = bad) <> '[]'::jsonb then raise exception 'FAIL: cleanup left tickers: %', (select tickers from core.blurbs where id = bad); end if;
  if core.clean_card_tickers() <> 0 then raise exception 'FAIL: cleanup not idempotent'; end if;
  if (select count(*) from core.card_ticker_mismatches()) <> 0 then raise exception 'FAIL: cards with a ticker and no whole-word match remain'; end if;
  if (select jsonb_array_length(tickers) from core.blurbs where id = msft) <> 1 then raise exception 'FAIL: cleanup removed a valid ticker'; end if;

  if has_function_privilege('anon','core.clean_card_tickers()','EXECUTE') or has_function_privilege('authenticated','core.card_ticker_mismatches()','EXECUTE') then
    raise exception 'FAIL: client roles can run the cleanup'; end if;
  raise exception 'ALL ENTITY TAG CHECKS PASSED (test rows rolled back on purpose)';
end $$;
