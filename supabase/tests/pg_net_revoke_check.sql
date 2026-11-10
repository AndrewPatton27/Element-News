-- Checks for 20261130000000_revoke_pg_net.sql. pg_net is not available in PGlite: when schema net is absent the
-- check only proves the migration was a no-op (it ran without error) and skips the privilege assertions.
-- On a real database (psql against dev, or the same DO block through `supabase db query`) it asserts that the
-- client roles cannot execute net.* or use the schema. Ends with the usual deliberate error.
do $$
declare
  f record; r text; bad text[] := '{}';
begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise exception 'ALL PG_NET REVOKE CHECKS PASSED (schema net absent: skipped, test rows rolled back on purpose)';
  end if;
  foreach r in array array['anon','authenticated','authenticator'] loop
    continue when to_regrole(r) is null;
    if has_schema_privilege(r, 'net', 'usage') then bad := bad || (r || ' has USAGE on schema net'); end if;
    for f in select p.oid, p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net' loop
      if has_function_privilege(r, f.oid, 'execute') then bad := bad || (r || ' can execute ' || f.sig::text); end if;
    end loop;
  end loop;
  if array_length(bad, 1) > 0 then raise exception 'FAIL: %', array_to_string(bad, '; '); end if;
  raise exception 'ALL PG_NET REVOKE CHECKS PASSED (test rows rolled back on purpose)';
end $$;
