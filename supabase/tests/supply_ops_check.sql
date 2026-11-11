-- Checks for 20261129000000_supply_ops.sql: ops_status cards_24h / cards_1h (published only, time windows),
-- api.upsert_item returns status_note, the retry-counter path through api.set_item_status(..., 'new', note),
-- the new indexes. Rows roll back at the deliberate final error.
do $$
declare
  j jsonb; r jsonb; v_id uuid; v_cat text;
  tok constant text := 'test-watchdog-token-0123456789';
begin
  delete from core.blurbs;
  select slug into v_cat from core.categories limit 1;
  create schema if not exists vault;
  create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
  insert into vault.decrypted_secrets values ('element_watchdog_token', tok);

  j := api.ops_status(tok);
  if (j->>'cards_24h')::int <> 0 or (j->>'cards_1h')::int <> 0 then raise exception 'FAIL: empty counts %', j; end if;

  insert into core.blurbs (dedupe_key, kind, headline, category, as_of, sort_at, published_at, status) values
    ('so-a', 'summary', 'In the last 30 minutes', v_cat, now(), now(), now() - interval '30 minutes', 'published'),
    ('so-b', 'summary', 'Five hours ago',        v_cat, now(), now(), now() - interval '5 hours', 'published'),
    ('so-c', 'summary', 'Thirty hours ago',      v_cat, now(), now(), now() - interval '30 hours', 'published'),
    ('so-d', 'summary', 'Hidden, recent',        v_cat, now(), now(), now() - interval '10 minutes', 'hidden');
  j := api.ops_status(tok);
  if (j->>'cards_24h')::int <> 2 then raise exception 'FAIL: cards_24h % (expected 2: hidden and old cards do not count)', j; end if;
  if (j->>'cards_1h')::int <> 1 then raise exception 'FAIL: cards_1h % (expected 1)', j; end if;
  if jsonb_typeof(j->'ai') <> 'array' or j->>'hung_open' is null or j->>'db_size_mb' is null then raise exception 'FAIL: older fields lost %', j; end if;

  -- upsert_item: status_note comes back (null for a fresh item), the counter note survives a second upsert
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/so-1","title":"T","license_class":"company_filing"}');
  v_id := (r->>'id')::uuid;
  if not (r ? 'status_note') or r->>'status_note' is not null or (r->>'is_new')::boolean is not true or r->>'status' <> 'new' then
    raise exception 'FAIL: fresh upsert %', r;
  end if;
  perform api.set_item_status(v_id, 'new', 'report_card_retry:1:report_card_revise_failed');
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/so-1","title":"T","license_class":"company_filing"}');
  if r->>'status' <> 'new' or r->>'status_note' <> 'report_card_retry:1:report_card_revise_failed' or (r->>'is_new')::boolean then
    raise exception 'FAIL: retry note not returned %', r;
  end if;
  perform api.set_item_status(v_id, 'skipped', 'report_card_revise_failed');
  r := api.upsert_item('{"source":"sec_8k","url":"https://www.sec.gov/so-1","title":"T","license_class":"company_filing"}');
  if r->>'status' <> 'skipped' then raise exception 'FAIL: skipped item came back as %', r; end if;

  -- grants unchanged: still service role only
  if has_function_privilege('anon', 'api.upsert_item(jsonb)', 'execute') or has_function_privilege('authenticated', 'api.upsert_item(jsonb)', 'execute')
     or has_function_privilege('service_role', 'api.upsert_item(jsonb)', 'execute') is not true then
    raise exception 'FAIL: upsert_item grants';
  end if;
  if has_function_privilege('anon', 'api.ops_status(text)', 'execute') is not true then raise exception 'FAIL: ops_status grant'; end if;

  if to_regclass('core.blurbs_published_at_idx') is null or to_regclass('ingest.items_fetched_at_idx') is null
     or to_regclass('ingest.items_status_fetched_idx') is null then
    raise exception 'FAIL: indexes missing';
  end if;
  raise exception 'ALL SUPPLY OPS CHECKS PASSED';
end $$;
