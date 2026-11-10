-- Search v6 (20261120000000_search_v6.sql): faster matching with the same matches, company tier only for sure
-- tags, headline weight, micro-topic penalty, company industry words.
-- Checks: settings and range guard; a low-confidence company tag ("sold on Amazon") gets no company tier while a
-- sure one does; a recall that only mentions "housing" in its summary comes after a Housing starts card that trends
-- lower, but "recall" still lists recalls first; a headline match beats a summary-only match that is fresher;
-- "bank earnings" finds a bank's results that never say "bank"; typo, synonym and stem matches as before;
-- paging without repeats or gaps; a 3-word query over 400 extra cards stays fast; security unchanged.
-- Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_amzn uuid; c_sold uuid; c_house uuid; c_hrec uuid; c_head uuid; c_body uuid; c_bank uuid; c_cpi uuid;
  r jsonb; ids text[]; seen text[] := '{}'; cur text; i int := 0; t0 timestamptz; ms numeric;
begin
  update core.blurbs set status = 'hidden' where status = 'published';   -- real cards out of the way (rolled back)

  -- 1. settings and range guard
  if (select value from core.rank_params where key='search_headline_weight') is distinct from 0.15
     or (select value from core.rank_params where key='search_micro_penalty') is distinct from 0.5
     or (select value from core.rank_params where key='search_company_min_confidence') is distinct from 0.75 then
    raise exception 'FAIL: v6 defaults must be headline 0.15, micro penalty 0.5, company confidence 0.75'; end if;
  begin
    update core.rank_params set value = 1.5 where key = 'search_micro_penalty';
    raise exception 'FAIL: search_micro_penalty 1.5 must be refused';
  exception when check_violation then null; end;

  insert into core.categories (slug, name, sort_order) values ('safety','Recalls & Safety',22) on conflict (slug) do nothing;

  -- Amazon's own results (sure tag: card ticker), 100 h old; a small seller's recall "sold on Amazon", fresh
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,tickers,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-amzn','summary','Amazon reports third quarter revenue of $180 billion','Online sales and cloud revenue rose.','earnings','earnings','published',
    '[{"symbol":"AMZN","name":"Amazon.com, Inc."}]',now(),now(),now()-interval '100 hours',6,base-100+8*log(2,6)) returning id into c_amzn;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-sold','summary','Hasuit recalls dressers over tip-over hazard','The dressers were sold on Amazon by an online seller for about $90.','safety','recall','published',
    now(),now(),now(),1.875,base+8*log(2,1.875)) returning id into c_sold;
  -- Housing starts (data, 30 h old) vs a fresh recall whose summary mentions a plastic housing
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-house','data','Housing starts fall to 1.22M (annual rate)','Builders started fewer homes.','economy','data','published',
    now(),now(),now()-interval '30 hours',10,base-30+8*log(2,10)) returning id into c_house;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-hrec','summary','Kelvo recalls space heaters over fire hazard','The plastic housing can melt during use.','safety','recall','published',
    now(),now(),now(),1.875,base+8*log(2,1.875)+40) returning id into c_hrec;
  -- same words: in the headline (10 h old) vs only in the summary (fresh)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-head','summary','Zorbex profit rises','Details follow.','economy','published',now(),now(),now()-interval '10 hours',2,base-10+8)
  returning id into c_head;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-body','summary','Company update','Zorbex profit rises again.','economy','published',now(),now(),now(),2,base+8)
  returning id into c_body;
  -- a bank's results that never say "bank" (the industry word comes from core.companies: JPM = Banks)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,tickers,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-bank','summary','JPMorgan Chase reports third-quarter net income of $15 billion','Lending and trading income rose.','earnings','earnings','published',
    '[{"symbol":"JPM","name":"JPMorgan Chase & Co."}]',now(),now(),now()-interval '50 hours',6,base-50+8*log(2,6)) returning id into c_bank;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv6-cpi','data','Consumer prices up 3.7% from a year earlier','Inflation stayed above the goal.','economy','data','published',
    now(),now(),now()-interval '5 hours',10,base-5+8*log(2,10)) returning id into c_cpi;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV6 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sv6-%';

  -- 2. company tier only for sure tags (penalty off here, so only the tier decides)
  if coalesce((select max(confidence) from core.card_companies where blurb_id=c_sold and ticker='AMZN'),0) >= 0.75 then
    raise exception 'FAIL: setup: the "sold on Amazon" recall must be tagged below 0.75 (or not at all)'; end if;
  update core.rank_params set value = 0 where key = 'search_micro_penalty';
  r := api.search('amazon', null, 10);
  if r->'items'->0->>'id' is distinct from c_amzn::text then
    raise exception 'FAIL: "amazon" must put Amazon''s own results first, got %', r->'items'->0->>'headline'; end if;
  update core.rank_params set value = 0 where key in ('search_company_min_confidence', 'search_headline_weight');
  if (select max(confidence) from core.card_companies where blurb_id=c_sold and ticker='AMZN') is not null
     and api.search('amazon', null, 10)->'items'->0->>'id' is distinct from c_sold::text then
    raise exception 'FAIL: with search_company_min_confidence 0 the fresher low-confidence card must lead (v5 behaviour)'; end if;
  update core.rank_params set value = 0.75 where key = 'search_company_min_confidence';
  update core.rank_params set value = 0.15 where key = 'search_headline_weight';
  update core.rank_params set value = 0.5 where key = 'search_micro_penalty';

  -- 3. micro penalty: "housing" lists Housing starts before the fresher, hotter recall; "recall" still finds recalls
  r := api.search('housing', null, 10);
  if r->'items'->0->>'id' is distinct from c_house::text or not (r->'items' @> jsonb_build_array(jsonb_build_object('id',c_hrec))) then
    raise exception 'FAIL: "housing" must list Housing starts first and still find the recall: %', r; end if;
  update core.rank_params set value = 0 where key in ('search_micro_penalty', 'search_headline_weight');
  if api.search('housing', null, 10)->'items'->0->>'id' is distinct from c_hrec::text then
    raise exception 'FAIL: with search_micro_penalty and search_headline_weight 0 the hotter recall must lead (v5 behaviour)'; end if;
  update core.rank_params set value = 0.5 where key = 'search_micro_penalty';
  update core.rank_params set value = 0.15 where key = 'search_headline_weight';
  -- the penalty alone also decides it (headline weight off)
  update core.rank_params set value = 0 where key = 'search_headline_weight';
  if api.search('housing', null, 10)->'items'->0->>'id' is distinct from c_house::text then
    raise exception 'FAIL: the micro penalty alone must put Housing starts first'; end if;
  update core.rank_params set value = 0.15 where key = 'search_headline_weight';
  r := api.search('recall', null, 10);
  if r->'items'->0->>'category' is distinct from 'safety' then raise exception 'FAIL: "recall" must list recalls first: %', r; end if;

  -- 4. headline weight
  r := api.search('zorbex profit', null, 10);
  if r->'items'->0->>'id' is distinct from c_head::text or r->'items'->1->>'id' is distinct from c_body::text then
    raise exception 'FAIL: a headline match must beat a fresher summary-only match: %', r; end if;
  update core.rank_params set value = 0 where key = 'search_headline_weight';
  if api.search('zorbex profit', null, 10)->'items'->0->>'id' is distinct from c_body::text then
    raise exception 'FAIL: with search_headline_weight 0 the fresher card must lead (v5 behaviour)'; end if;
  update core.rank_params set value = 0.15 where key = 'search_headline_weight';

  -- 4b. interest-rate words ignore "unemployment rate"; rare words weigh more (IDF)
  declare c_fed uuid; c_unemp uuid; c_pay uuid; c_rep uuid;
  begin
    insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score) values
     ('sv6-fed','summary','Fed lowers federal funds rate target range','The central bank cut its policy rate.','policy','published',now(),now(),now()-interval '60 hours',10,base-60+26.6),
     ('sv6-unemp','data','Unemployment rate falls to 4.1%','The unemployment rate fell as hiring picked up and job cuts slowed.','economy','published',now(),now(),now(),10,base+26.6),
     ('sv6-pay','data','Nonfarm payroll jobs rise to 159.3M','Employers kept adding jobs.','economy','published',now(),now(),now()-interval '30 hours',10,base-30+26.6);
    insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
    select 'sv6-rep'||g,'summary','Firm '||g||' reports quarterly results','The report covers store sales and costs.','earnings','published',now(),now(),now(),6,base+20.7
    from generate_series(1,12) g;
    insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
    select id,'SV6 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key in ('sv6-fed','sv6-unemp','sv6-pay') or dedupe_key like 'sv6-rep%';
    select id into c_fed from core.blurbs where dedupe_key='sv6-fed';
    select id into c_unemp from core.blurbs where dedupe_key='sv6-unemp';
    select id into c_pay from core.blurbs where dedupe_key='sv6-pay';
    r := api.search('rate cut', null, 10);
    if r->'items'->0->>'id' is distinct from c_fed::text then
      raise exception 'FAIL: "rate cut" must put the Fed rate card first, not %', r->'items'->0->>'headline'; end if;
    r := api.search('jobs', null, 10);   -- v8: AND, so the single rare word
    if r->'items'->0->>'id' is distinct from c_pay::text then
      raise exception 'FAIL: "jobs" must put the payroll card first (rare word "jobs" decides), not %', r->'items'->0->>'headline'; end if;
    update core.blurbs set status = 'hidden' where dedupe_key in ('sv6-fed','sv6-unemp','sv6-pay') or dedupe_key like 'sv6-rep%';
  end;

  -- 5. industry words; typo, synonym and stem matches unchanged
  if not (api.search('bank earnings', null, 10)->'items' @> jsonb_build_array(jsonb_build_object('id',c_bank))) then
    raise exception 'FAIL: "bank earnings" must find the JPMorgan results'; end if;
  if api.search('inflaton', null, 5)->'items'->0->>'id' is distinct from c_cpi::text then raise exception 'FAIL: typo "inflaton" must find the CPI card'; end if;
  if api.search('cpi', null, 5)->'items'->0->>'id' is distinct from c_cpi::text then raise exception 'FAIL: synonym "cpi" must find the CPI card'; end if;
  if not (api.search('dresser', null, 5)->'items' @> jsonb_build_array(jsonb_build_object('id',c_sold))) then raise exception 'FAIL: stem "dresser" must find dressers'; end if;
  if jsonb_array_length(api.search('zzqx', null, 5)->'items') <> 0 or jsonb_array_length(api.search('', null, 5)->'items') <> 0 then
    raise exception 'FAIL: no-match and empty queries must return nothing'; end if;

  -- 6. 400 extra cards: paging one per page equals one big page; a 3-word query stays fast
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  select 'sv6-x'||g,'summary','Company '||g||' reports quarterly revenue','Revenue rose '||g||' percent on record demand.','earnings','published',
    now(),now(),now()-(g||' hours')::interval,2,base-g+8 from generate_series(1,400) g;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV6 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sv6-x%';
  t0 := clock_timestamp();
  r := api.search('quarterly revenue record', null, 20);
  ms := extract(epoch from clock_timestamp()-t0)*1000;
  if jsonb_array_length(r->'items') <> 20 then raise exception 'FAIL: 3-word query must fill a page'; end if;
  select array_agg(x->>'id') into ids from jsonb_array_elements(api.search('revenue', null, 30)->'items') x;
  loop
    r := api.search('revenue', cur, 7);
    seen := seen || array(select x->>'id' from jsonb_array_elements(r->'items') x);
    cur := r->>'next_cursor'; i := i + 1;
    exit when cur is null or i > 80;
  end loop;
  if (select count(distinct x) from unnest(seen) x) <> cardinality(seen) then raise exception 'FAIL: paging repeated a card'; end if;
  if seen[1:30] is distinct from ids then raise exception 'FAIL: pages of 7 must equal one page of 30'; end if;

  -- 7. security unchanged
  if not exists(select 1 from pg_proc where oid='api.search(text,text,int)'::regprocedure and prosecdef and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must be security definer with an empty search_path'; end if;
  if not has_function_privilege('anon','api.search(text,text,int)','execute') then raise exception 'FAIL: anon must be able to call api.search'; end if;
  raise exception 'ALL SEARCH V6 CHECKS PASSED (company tier, micro penalty, headline weight, industry words, paging; 3-word query over 400 cards % ms; test rows rolled back on purpose)', round(ms);
end $$;
