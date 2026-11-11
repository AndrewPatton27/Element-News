-- api.items_handled(p_urls): which of these item URLs an earlier run already finished (status other than 'new').
-- Why (M9c yield work, R-300): an SEC run lists ~520 filings and the pipeline asked the database about each one with its
-- own api.upsert_item call (about 0.2 s each), so the 100 s time budget ran out with 180 filings unvisited. The
-- pipeline now asks once per source for the whole list and only upserts what is not handled yet.
-- Read-only, service role only (the ingest Edge Function and the laptop script). Capped at 2000 URLs per call.
-- Idempotent: create or replace, grants repeated.
create or replace function api.items_handled(p_urls text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(i.url), '{}'::text[])
    from ingest.items i
   where i.url = any (p_urls[1:2000])
     and i.status <> 'new';
$$;
revoke execute on function api.items_handled(text[]) from public, anon, authenticated;
grant  execute on function api.items_handled(text[]) to service_role;
