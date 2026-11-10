-- Checks for 20261123000000_everyday_relevance.sql. All rows roll back at the deliberate final error.
do $$
declare
  r jsonb; v smallint; id1 uuid; id2 uuid; id3 uuid;
  src text := '"sources":[{"name":"SEC","kind":"filing","url":"https://www.sec.gov/test/rel","license_class":"company_filing"}]';
begin
  -- column exists, nullable smallint with a 1..5 check
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'core' and table_name = 'blurbs' and column_name = 'everyday_relevance'
                    and data_type = 'smallint' and is_nullable = 'YES') then
    raise exception 'FAIL: core.blurbs.everyday_relevance missing or wrong type';
  end if;
  begin
    update core.blurbs set everyday_relevance = 9 where false;           -- no rows: constraint is checked on a real insert below
    insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, everyday_relevance)
    values ('rel-bad', 'summary', 'x', 'markets', now(), now(), 9);
    raise exception 'FAIL: score 9 accepted';
  exception when check_violation then null; end;

  -- publish: an AI card stores its score
  r := api.publish_blurb(('{"dedupe_key":"rel-ai","kind":"summary","headline":"AI card","category":"economy","ai_generated":true,"everyday_relevance":4,"sort_at":"2026-10-17T10:00:00Z",' || src || '}')::jsonb);
  if r->>'status' <> 'published' then raise exception 'FAIL: publish returned %', r; end if;
  id1 := (r->>'id')::uuid;
  select everyday_relevance into v from core.blurbs where id = id1;
  if v is distinct from 4 then raise exception 'FAIL: AI score not stored (got %)', v; end if;

  -- publish: a template card never carries a score, even if the payload has one
  r := api.publish_blurb(('{"dedupe_key":"rel-tpl","kind":"summary","headline":"Template card","category":"economy","ai_generated":false,"everyday_relevance":5,"sort_at":"2026-10-17T11:00:00Z",' || src || '}')::jsonb);
  id2 := (r->>'id')::uuid;
  if (select everyday_relevance from core.blurbs where id = id2) is not null then raise exception 'FAIL: template card got a score'; end if;

  -- publish: junk and out-of-range scores become null instead of failing the publish
  r := api.publish_blurb(('{"dedupe_key":"rel-junk","kind":"summary","headline":"Junk score","category":"economy","ai_generated":true,"everyday_relevance":"9","sort_at":"2026-10-17T12:00:00Z",' || src || '}')::jsonb);
  id3 := (r->>'id')::uuid;
  if r->>'status' <> 'published' or (select everyday_relevance from core.blurbs where id = id3) is not null then
    raise exception 'FAIL: out-of-range score not nulled: %', r;
  end if;
  r := api.publish_blurb(('{"dedupe_key":"rel-none","kind":"summary","headline":"No score","category":"economy","ai_generated":true,"sort_at":"2026-10-17T13:00:00Z",' || src || '}')::jsonb);
  if r->>'status' <> 'published' then raise exception 'FAIL: publish without score returned %', r; end if;

  -- revise: a payload with the key replaces the score; without the key it is kept; a template revise clears it
  r := api.revise_blurb(jsonb_build_object('id', id1, 'action', 'revise', 'headline', 'AI card v2', 'body', 'b', 'ai_generated', true, 'model', 'm', 'prompt_version', 'sum-v7', 'everyday_relevance', 2));
  if r->>'status' <> 'revised' or (select everyday_relevance from core.blurbs where id = id1) <> 2 then raise exception 'FAIL: revise did not replace the score: %', r; end if;
  r := api.revise_blurb(jsonb_build_object('id', id1, 'action', 'revise', 'headline', 'AI card v3', 'ai_generated', true, 'model', 'm', 'prompt_version', 'sum-v7'));
  if (select everyday_relevance from core.blurbs where id = id1) is distinct from 2 then raise exception 'FAIL: revise without the key changed the score'; end if;
  r := api.revise_blurb(jsonb_build_object('id', id1, 'action', 'revise', 'headline', 'Template again', 'ai_generated', false, 'model', null, 'prompt_version', 'tpl-v5'));
  if (select everyday_relevance from core.blurbs where id = id1) is not null then raise exception 'FAIL: template revise kept the score'; end if;

  -- the score is not part of the card JSON
  if exists (select 1 from jsonb_array_elements(api.feed('latest', null, 30, null) -> 'items') x where x ? 'everyday_relevance') then
    raise exception 'FAIL: api.feed returns everyday_relevance';
  end if;

  -- grants unchanged: service_role only
  if has_function_privilege('service_role', 'api.publish_blurb(jsonb)', 'execute') is not true
     or has_function_privilege('service_role', 'api.revise_blurb(jsonb)', 'execute') is not true then
    raise exception 'FAIL: service_role lost execute';
  end if;
  if has_function_privilege('anon', 'api.publish_blurb(jsonb)', 'execute') or has_function_privilege('authenticated', 'api.publish_blurb(jsonb)', 'execute')
     or has_function_privilege('anon', 'api.revise_blurb(jsonb)', 'execute') or has_function_privilege('authenticated', 'api.revise_blurb(jsonb)', 'execute') then
    raise exception 'FAIL: app roles may call the write RPCs';
  end if;

  raise exception 'ALL everyday_relevance CHECKS PASSED';
end $$;
