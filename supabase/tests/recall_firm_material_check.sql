-- Recall gate fix (20261120000100_recall_firm_material.sql): only the recalling company makes a recall material.
-- Checks: core.recall_firm_tickers reads the headline before "recall"; a small seller's recall "sold on Amazon /
-- at Walmart" is tagged with the retailer but its text verdict is NOT material and it stays out of guest Trending
-- and Latest; "Walmart recalls ..." is material (watch-list firm) and shown; the units rule still works; an ingest
-- verdict is never overwritten; re-running is idempotent; the Safety chip and search still list every recall;
-- api.followed_micro no longer returns the seller's recall for an AMZN follower.
-- Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_sold uuid; c_wmt uuid; c_big uuid; c_ing uuid; c_econ uuid;
  r jsonb; v jsonb; ids text[];
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  insert into core.categories (slug, name, sort_order) values ('safety','Recalls & Safety',22) on conflict (slug) do nothing;

  -- 1. the firm is what comes before "recall"
  if core.recall_firm_tickers('Walmart recalls Mainstays fabric dressers over tip-over hazard') is distinct from array['WMT'] then
    raise exception 'FAIL: "Walmart recalls ..." must give WMT, got %', core.recall_firm_tickers('Walmart recalls Mainstays fabric dressers over tip-over hazard'); end if;
  if cardinality(core.recall_firm_tickers('Hasuit recalls 7-drawer dressers sold on Amazon')) <> 0
     or cardinality(core.recall_firm_tickers('Recall issued for Steelite pressure washers')) <> 0
     or cardinality(core.recall_firm_tickers('TOMY recalls baby bottles sold at Walmart')) <> 0
     or cardinality(core.recall_firm_tickers(null)) <> 0 then
    raise exception 'FAIL: a retailer named after "recall" (or no firm) must give no ticker'; end if;

  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score) values
   ('rf-sold','summary','Hasuit recalls 7-drawer dressers sold on Amazon','The dressers were sold on Amazon and at Walmart stores. Stop using them right away.','safety','recall','published',now(),now(),now(),1.875,base+7.25),
   ('rf-wmt','summary','Walmart recalls Mainstays fabric dressers over tip-over hazard','Stop using unanchored dressers and contact Walmart for a refund.','safety','recall','published',now(),now(),now()-interval '1 hour',1.875,base+6.25),
   ('rf-big','summary','Kelvo recalls space heaters over fire hazard','About 250,000 heaters were sold on Amazon.','safety','recall','published',now(),now(),now()-interval '2 hours',1.875,base+5.25),
   ('rf-ing','summary','Ozzi recalls toy blocks sold on Amazon','Stop using the blocks.','safety','recall','published',now(),now(),now()-interval '3 hours',1.875,base+4.25),
   ('rf-econ','data','Consumer prices up 3.7% from a year earlier','Inflation stayed high.','economy','data','published',now(),now(),now()-interval '4 hours',10,base+22.6);
  select id into c_sold from core.blurbs where dedupe_key='rf-sold';
  select id into c_wmt  from core.blurbs where dedupe_key='rf-wmt';
  select id into c_big  from core.blurbs where dedupe_key='rf-big';
  select id into c_ing  from core.blurbs where dedupe_key='rf-ing';
  select id into c_econ from core.blurbs where dedupe_key='rf-econ';
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'U.S. Consumer Product Safety Commission','government','https://www.cpsc.gov/'||dedupe_key,'public_domain',true from core.blurbs where dedupe_key like 'rf-%';
  -- an ingest verdict (no 'text:' reason) that a text pass must never change
  insert into core.card_material (blurb_id, material, reasons, tickers) values (c_ing, true, array['units_300000'], '{}');

  -- 2. the old bug's precondition: the seller's recall IS tagged with a retailer by the company tagger
  if not exists (select 1 from core.card_companies where blurb_id = c_sold and ticker in ('AMZN','WMT')) then
    raise notice 'note: the tagger did not tag the seller recall with a retailer in this database';
  end if;

  v := core.backfill_recall_material(true);
  if (select material from core.card_material where blurb_id=c_sold) is distinct from false then
    raise exception 'FAIL: the seller recall must not be material: %', (select row_to_json(m) from core.card_material m where blurb_id=c_sold); end if;
  if (select cardinality(tickers) from core.card_material where blurb_id=c_sold) <> 0 then
    raise exception 'FAIL: the seller recall must store no company tickers'; end if;
  if (select material from core.card_material where blurb_id=c_wmt) is distinct from true
     or not (select reasons @> array['text:watch_company_WMT'] from core.card_material where blurb_id=c_wmt) then
    raise exception 'FAIL: "Walmart recalls ..." must be material for WMT'; end if;
  if (select material from core.card_material where blurb_id=c_big) is distinct from true then
    raise exception 'FAIL: about 250,000 units must stay material'; end if;
  if (select reasons from core.card_material where blurb_id=c_ing) is distinct from array['units_300000'] then
    raise exception 'FAIL: an ingest verdict must never be overwritten'; end if;
  if core.backfill_recall_material(true) ->> 'set' is distinct from v ->> 'set' then raise exception 'FAIL: re-run must touch the same cards'; end if;

  -- 3. guest Trending and Latest: the seller recall is left out, the others shown
  foreach r in array array[api.feed('top', null, 20, null), api.feed('latest', null, 20, null)] loop
    select array_agg(x->>'id') into ids from jsonb_array_elements(r->'items') x;
    if c_sold::text = any(ids) then raise exception 'FAIL: the seller recall must not be in Trending / Latest'; end if;
    if not (c_wmt::text = any(ids) and c_econ::text = any(ids)) then raise exception 'FAIL: material recall and macro card must be shown: %', ids; end if;
  end loop;

  -- 4. still reachable: Safety chip and search
  select array_agg(x->>'id') into ids from jsonb_array_elements(api.feed('top', null, 20, 'safety')->'items') x;
  if not (c_sold::text = any(ids)) then raise exception 'FAIL: the Safety chip must list every recall'; end if;
  if not (api.search('dressers', null, 10)->'items' @> jsonb_build_array(jsonb_build_object('id', c_sold))) then
    raise exception 'FAIL: search must still find the seller recall'; end if;

  -- 5. a follower of AMZN is not sent the seller's recall
  if to_regprocedure('api.followed_micro(text[],int)') is not null then
    r := api.followed_micro(array['AMZN'], 10);
    if r::text like '%' || c_sold::text || '%' then raise exception 'FAIL: followed_micro(AMZN) must not return the seller recall'; end if;
  end if;
  raise exception 'ALL RECALL FIRM MATERIAL CHECKS PASSED (test rows rolled back on purpose)';
end $$;
