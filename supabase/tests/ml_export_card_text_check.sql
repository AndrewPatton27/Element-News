-- =============================================================================
-- ml_export_card_text_check.sql: checks for 20261210000000_ml_export_card_text.sql
--   privileges (service role only, security definer, empty search_path), text and ids, hidden cards included,
--   paging without repeats, invalid input.
--   expected:     ERROR: ALL ML_EXPORT_CARD_TEXT CHECKS PASSED (test data rolled back on purpose)
--   any failure:  ERROR: FAIL: <what failed>
-- =============================================================================
do $$
declare
  r   jsonb;
  r2  jsonb;
  rl  text;
  ok  boolean;
  i   int;
  t   text := 'api.ml_export_card_text(timestamptz,text,integer)';
begin
  -- ---- 1. privileges --------------------------------------------------------------------------------------------
  foreach rl in array array['anon', 'authenticated'] loop
    perform set_config('role', rl, true);
    ok := false; begin perform api.ml_export_card_text(now()); exception when insufficient_privilege then ok := true; end;
    if not ok then raise exception 'FAIL: % can call api.ml_export_card_text', rl; end if;
    perform set_config('role', 'none', true);
  end loop;
  if not has_function_privilege('service_role', t, 'execute') then raise exception 'FAIL: service_role cannot execute'; end if;
  if exists (select 1 from pg_proc p where p.oid = t::regprocedure
                and (not p.prosecdef or not (p.proconfig @> array['search_path=""'])
                     or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))) then
    raise exception 'FAIL: must be security definer, search_path empty, not PUBLIC';
  end if;

  -- ---- 2. cards: 25 published (one without body) and 2 hidden ----------------------------------------------------
  for i in 1 .. 27 loop
    insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, sort_at, rank_score)
    values ('mect-' || i, 'summary', 'ECT headline ' || i, case when i = 3 then null else 'ECT body ' || i end, 'markets',
            case when i > 25 then 'hidden' else 'published' end, now(), now() - make_interval(secs => i * 60), 1000 + i);
  end loop;

  r := api.ml_export_card_text(now() - interval '1 day', null, 20);
  if jsonb_array_length(r -> 'rows') <> 20 or r ->> 'next' is null then raise exception 'FAIL: page 1 size or next'; end if;
  if not (r -> 'rows' -> 0 ? 'id') or not (r -> 'rows' -> 0 ? 'headline') or not (r -> 'rows' -> 0 ? 'body') then
    raise exception 'FAIL: row keys';
  end if;
  r2 := api.ml_export_card_text(now() - interval '1 day', r ->> 'next', 20);
  if jsonb_array_length(r2 -> 'rows') < 7 or r2 ->> 'next' is not null then raise exception 'FAIL: page 2 size or end'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'rows') a join jsonb_array_elements(r2 -> 'rows') c on a ->> 'id' = c ->> 'id') then
    raise exception 'FAIL: paging repeats a card';
  end if;
  if (select count(*) from jsonb_array_elements(r -> 'rows') x where x ->> 'headline' like 'ECT headline %')
   + (select count(*) from jsonb_array_elements(r2 -> 'rows') x where x ->> 'headline' like 'ECT headline %') <> 27 then
    raise exception 'FAIL: published and hidden cards must all be exported';
  end if;
  if exists (select 1 from jsonb_array_elements(r -> 'rows') x where x ->> 'body' is null) then raise exception 'FAIL: null body'; end if;

  -- ---- 3. since filter and invalid input -------------------------------------------------------------------------
  if jsonb_array_length((api.ml_export_card_text(now() + interval '1 day')) -> 'rows') <> 0 then raise exception 'FAIL: since filter'; end if;
  ok := false; begin perform api.ml_export_card_text(null); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: null since accepted'; end if;
  ok := false; begin perform api.ml_export_card_text(now(), 'garbage'); exception when sqlstate 'PT422' then ok := true; end;
  if not ok then raise exception 'FAIL: bad next accepted'; end if;

  raise exception 'ALL ML_EXPORT_CARD_TEXT CHECKS PASSED (test data rolled back on purpose)';
end;
$$;
