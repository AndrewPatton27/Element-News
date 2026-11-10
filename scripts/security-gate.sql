-- Read-only security gate query (scripts/security-gate.mjs --db). Run only with --read-only:
--   npx supabase db query --remote --read-only -f scripts/security-gate.sql --output-format json
-- Returns one row per object with the facts the gate checks. Never reads secret values (Vault names only are
-- not even listed here).
select 'fn' as k, n.nspname as s, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as secdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authd,
       null::boolean as rls
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('api', 'core', 'ingest', 'public', 'net', 'vault')
union all
select 'rel', n.nspname, c.relname, c.relkind::text, null, '',
       has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'),
       has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
         or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'),
       c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('api', 'core', 'ingest', 'public') and c.relkind in ('r', 'v', 'm', 'p')
union all
select 'schema', n.nspname, '', '', null, '', has_schema_privilege('anon', n.oid, 'usage'),
       has_schema_privilege('authenticated', n.oid, 'usage'), null
from pg_namespace n where n.nspname in ('api', 'core', 'ingest', 'vault', 'cron')
order by 1, 2, 3;
