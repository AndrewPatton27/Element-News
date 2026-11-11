-- Checks for 20261133000000_items_handled.sql: only items with a status other than 'new' are returned, unknown URLs
-- are ignored, an empty list gives an empty array, grants are service role only. Rows roll back at the closing error.
do $$
declare
  r jsonb; res text[];
begin
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/ih-new","title":"T","license_class":"company_filing"}');
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/ih-skipped","title":"T","license_class":"company_filing"}');
  perform api.set_item_status((r->>'id')::uuid, 'skipped', 'low_relevance (2)');
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/ih-failed","title":"T","license_class":"company_filing"}');
  perform api.set_item_status((r->>'id')::uuid, 'failed', 'boom');
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/ih-retry","title":"T","license_class":"company_filing"}');
  perform api.set_item_status((r->>'id')::uuid, 'new', 'retry:1:template_not_allowed');

  res := api.items_handled(array['https://www.sec.gov/ih-new', 'https://www.sec.gov/ih-skipped', 'https://www.sec.gov/ih-failed',
                                 'https://www.sec.gov/ih-retry', 'https://www.sec.gov/ih-unknown']);
  if cardinality(res) <> 2 or not ('https://www.sec.gov/ih-skipped' = any(res)) or not ('https://www.sec.gov/ih-failed' = any(res)) then
    raise exception 'FAIL: handled set % (expected the skipped and failed items only)', res;
  end if;
  if cardinality(api.items_handled(array[]::text[])) <> 0 then raise exception 'FAIL: empty list'; end if;
  if api.items_handled(null) is null or cardinality(api.items_handled(null)) <> 0 then raise exception 'FAIL: null list'; end if;

  if has_function_privilege('anon', 'api.items_handled(text[])', 'execute') or has_function_privilege('authenticated', 'api.items_handled(text[])', 'execute')
     or has_function_privilege('service_role', 'api.items_handled(text[])', 'execute') is not true then
    raise exception 'FAIL: items_handled grants';
  end if;
  raise exception 'ALL ITEMS HANDLED CHECKS PASSED';
end $$;
