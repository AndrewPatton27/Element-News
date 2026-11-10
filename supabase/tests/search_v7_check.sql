-- Search v7 (20261121000200_search_v7.sql): stored search documents, vocabulary, indexed candidates.
-- Checks: setting and range guard; every card has a document and the triggers keep it current (insert, body edit,
-- source added / removed); an old relevant card is found when many newer cards match other words and the pool cap
-- is small (v6's rank cap hid it); prefix, stem and typo matches through the vocabulary; the typo word list equals
-- v6's brute-force typo test over the whole vocabulary for several words; both private tables are closed to the
-- client roles; api.search security unchanged. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  c_old uuid; c_t uuid; r jsonb; ok boolean; w text; v_mode text := core.search_typo_mode();
begin
  update core.blurbs set status = 'hidden' where status = 'published';
  if (select value from core.rank_params where key = 'search_pool_cap') is distinct from 2000 then
    raise exception 'FAIL: search_pool_cap must default to 2000'; end if;
  ok := false; begin update core.rank_params set value = 0 where key = 'search_pool_cap'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL: search_pool_cap accepted 0'; end if;

  -- 1. documents for every card, kept current by the triggers
  if exists (select 1 from core.blurbs b where not exists (select 1 from core.search_docs d where d.blurb_id = b.id)) then
    raise exception 'FAIL: every card must have a search document'; end if;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv7-t','summary','Quintavor opens a plant','Output will grow.','markets','published',now(),now(),now(),4,base+8) returning id into c_t;
  if not exists (select 1 from core.search_docs where blurb_id = c_t and words @> array['quintavor','plant','markets']) then
    raise exception 'FAIL: a new card must get a document with its words'; end if;
  update core.blurbs set body = 'Output of widgets will grow.' where id = c_t;
  if not exists (select 1 from core.search_docs where blurb_id = c_t and words @> array['widgets']) then raise exception 'FAIL: a body edit must update the document'; end if;
  if not exists (select 1 from core.search_words where word = 'widgets') then raise exception 'FAIL: new words must reach the vocabulary'; end if;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values (c_t,'Halvex Wire','news','https://example.com/sv7-t','company_filing',true);
  if not exists (select 1 from core.search_docs where blurb_id = c_t and words @> array['halvex'] and meta0 like '%halvex wire%') then
    raise exception 'FAIL: a new source must reach the document metadata'; end if;
  delete from core.blurb_sources where blurb_id = c_t;
  if exists (select 1 from core.search_docs where blurb_id = c_t and words @> array['halvex']) then raise exception 'FAIL: a removed source must leave the document'; end if;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary) values (c_t,'SV7 Source','news','https://example.com/sv7-t2','company_filing',true);

  -- 2. an old card for a rare word is found behind 60 newer matching-other-words cards, with a pool cap of 20
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  values ('sv7-old','summary','Zentrofax recalls its quarterly outlook','The company cut its forecast.','earnings','published',
          now(),now(),now()-interval '2000 hours',4,base-2000+16) returning id into c_old;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,status,as_of,published_at,sort_at,importance,rank_score)
  select 'sv7-x'||g,'summary','Company '||g||' reports quarterly revenue','Revenue rose.','earnings','published',now(),now(),now()-(g||' hours')::interval,4,base-g+16
    from generate_series(1,60) g;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary)
  select id,'SV7 Source','news','https://example.com/'||dedupe_key,'company_filing',true from core.blurbs where dedupe_key like 'sv7-x%' or dedupe_key = 'sv7-old';
  update core.rank_params set value = 20 where key = 'search_pool_cap';
  r := api.search('zentrofax', null, 5);
  if r->'items'->0->>'id' is distinct from c_old::text then raise exception 'FAIL: the old Zentrofax card must be found with a small pool cap: %', r; end if;
  if api.search('zentro', null, 5)->'items'->0->>'id' is distinct from c_old::text then raise exception 'FAIL: prefix "zentro" must find Zentrofax'; end if;
  if api.search('zentrofx', null, 5)->'items'->0->>'id' is distinct from c_old::text then raise exception 'FAIL: typo "zentrofx" must find Zentrofax'; end if;
  if api.search('forecasts', null, 5)->'items'->0->>'id' is distinct from c_old::text then raise exception 'FAIL: stem "forecasts" must find "forecast"'; end if;
  if jsonb_array_length(api.search('quarterly revenue', null, 30)->'items') <> 20 then raise exception 'FAIL: the pool cap must bound the scored cards'; end if;
  update core.rank_params set value = 2000 where key = 'search_pool_cap';
  if jsonb_array_length(api.search('quarterly revenue', null, 30)->'items') <> 30 then raise exception 'FAIL: the default cap must score every match here'; end if;

  -- 3. typo words = v6's brute-force typo test over the whole vocabulary
  foreach w in array array['zentrofx', 'quarterli', 'revenu', 'forecsat', 'compnay', 'widgetz'] loop
    if core.search_typo_words(w) is distinct from
       (select coalesce(array_agg(x.word order by x.word), '{}'::text[]) from core.search_words x
         where x.word <> w and (v_mode = 'pg_trgm' or abs(char_length(x.word) - char_length(w)) <= 2) and core.search_typo_ok(w, x.word)) then
      raise exception 'FAIL: typo words for % differ from the brute-force list (%)', w, v_mode; end if;
  end loop;

  -- 4. private tables, security
  if has_table_privilege('anon', 'core.search_docs', 'select') or has_table_privilege('authenticated', 'core.search_words', 'select') then
    raise exception 'FAIL: search tables must be private'; end if;
  if has_function_privilege('anon', 'core.search_docs_refresh(uuid[])', 'execute') or has_function_privilege('authenticated', 'core.search_typo_words(text)', 'execute') then
    raise exception 'FAIL: search helpers must be private'; end if;
  if not exists(select 1 from pg_proc where oid='api.search(text,text,int)'::regprocedure and prosecdef and provolatile='s' and proconfig @> array['search_path=""']) then
    raise exception 'FAIL: api.search must be security definer, stable, with an empty search_path'; end if;
  if not has_function_privilege('anon','api.search(text,text,int)','execute') then raise exception 'FAIL: anon must be able to call api.search'; end if;
  raise exception 'ALL SEARCH V7 CHECKS PASSED (typo mode %; test rows rolled back on purpose)', v_mode;
end $$;
