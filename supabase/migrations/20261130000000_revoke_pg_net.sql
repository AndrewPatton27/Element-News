-- Revoke pg_net (schema net) from the client roles. Idempotent; a no-op when pg_net is not installed (PGlite, dev).
--
-- Why the 20261118000000 revoke did not take: pg_net's functions and schema are owned by supabase_admin and the
-- extension script GRANTed EXECUTE / USAGE to anon, authenticated and service_role as supabase_admin. A REVOKE run
-- by `postgres` only removes grants whose grantor is postgres, so it silently did nothing. This migration runs each
-- REVOKE as the object's owner (SET LOCAL ROLE <owner>) so the grantor matches. If postgres may not assume the owner
-- role the block raises a WARNING and leaves things as they were; then run the same statements in the Supabase
-- dashboard SQL editor (which runs as supabase_admin). Re-check with the verification query at the bottom.
--
-- Kept on purpose: postgres, service_role and supabase_functions_admin (database webhooks, pg_cron jobs that call
-- net.http_post run as postgres). Client roles: public, anon, authenticated, authenticator lose everything.
-- Only the `api` schema is exposed through PostgREST, so this closes the direct-database-login path, not an API one.
do $net$
declare
  f record;
  clients text[];
  owner_name text;
  rn text;
  leftover text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise notice 'revoke_pg_net: schema net not present, nothing to do';
    return;
  end if;
  -- roles that exist here (authenticator is absent on some setups)
  select coalesce(array_agg(r), '{}') into clients from unnest(array['anon','authenticated','authenticator']) r where to_regrole(r) is not null;

  -- schema USAGE
  select pg_get_userbyid(nspowner) into owner_name from pg_namespace where nspname = 'net';
  begin
    execute format('set local role %I', owner_name);
    execute 'revoke usage on schema net from public' || (select coalesce(', ' || string_agg(quote_ident(c), ', '), '') from unnest(clients) c);
    -- later objects the owner creates in net (pg_net upgrades) must not be re-granted to the client roles
    execute format('alter default privileges for role %I in schema net revoke all on functions from public', owner_name)
      || (select coalesce(', ' || string_agg(quote_ident(c), ', '), '') from unnest(clients) c);
    reset role;
  exception when others then
    reset role;
    raise warning 'revoke_pg_net: schema step failed (%), run as supabase_admin in the dashboard SQL editor', sqlerrm;
  end;

  -- every function in net
  for f in
    select p.oid::regprocedure as sig, pg_get_userbyid(p.proowner) as owner_name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net'
  loop
    begin
      execute format('set local role %I', f.owner_name);
      execute format('revoke all on function %s from public', f.sig);
      foreach rn in array clients loop
        execute format('revoke all on function %s from %I', f.sig, rn);
      end loop;
      reset role;
    exception when others then
      reset role;
      raise warning 'revoke_pg_net: could not revoke on % (%), run as supabase_admin in the dashboard SQL editor', f.sig, sqlerrm;
    end;
  end loop;

  -- final check: fail loudly (rolls the migration back) if any client role can still execute a net.* function
  select string_agg(p.oid::regprocedure::text || ' -> ' || r, '; ') into leftover
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(clients) r
  where n.nspname = 'net' and has_function_privilege(r, p.oid, 'execute');
  if leftover is not null then
    raise exception 'revoke_pg_net: client roles can still execute net functions: %. Run the revokes as supabase_admin in the dashboard SQL editor.', leftover;
  end if;
end
$net$;

-- Verification (run read-only after applying; every column must be false):
--   select p.oid::regprocedure as fn,
--          has_function_privilege('anon', p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--          has_function_privilege('authenticator', p.oid, 'execute') as authenticator
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net';
--   select has_schema_privilege('anon','net','usage') anon, has_schema_privilege('authenticated','net','usage') authenticated,
--          has_schema_privilege('authenticator','net','usage') authenticator;
--   node scripts/security-gate.mjs --db      (FAILs while a client role can execute net.*)
-- Expected still true: postgres and service_role can execute net.http_post (cron jobs, webhooks).
