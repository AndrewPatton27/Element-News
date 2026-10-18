-- =============================================================================
-- Element: users can delete their own account (2026-10-17)
--
-- api.delete_account()  -> {"deleted": true}
--   SECURITY DEFINER, signed-in users only. Deletes the caller's own row in auth.users
--   (where id = auth.uid(), never any other id). The foreign keys on core.user_prefs and
--   core.user_events (on delete cascade) remove their data; Supabase's own auth tables
--   (sessions, refresh tokens, identities) cascade the same way, so the user can no longer
--   sign in or refresh.
--
-- Ownership: the function is owned by the role that runs this migration (postgres in the
-- SQL editor). Deleting rows from auth.users as postgres is the usual Supabase pattern for
-- "delete my account"; postgres keeps DML rights on auth.users even though the auth schema
-- is owned by supabase_auth_admin. If Supabase ever removes that right, the call fails
-- with "permission denied for table users" and nothing is deleted (fail closed).
--
-- Caveats:
--   * The current access token stays valid until it expires (up to 1 hour). The app must
--     sign out locally right after a successful call. The token can no longer be refreshed.
--   * A user who owns Storage objects could not be deleted this way (foreign key). Element
--     uses no Storage, so this does not apply.
--
-- Idempotent: create or replace + explicit revokes/grants. Run after 20261017030000_accounts.sql.
-- =============================================================================

create or replace function api.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'PT401'; end if;

  -- own data first (also covered by the cascades; explicit so nothing is left if a FK changes)
  delete from core.user_events where user_id = v_uid;
  delete from core.user_prefs  where user_id = v_uid;

  delete from auth.users where id = v_uid;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'account_not_found' using errcode = 'PT404';
  end if;
  return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function api.delete_account() from public, anon;
grant execute on function api.delete_account() to authenticated;

-- HOW TO CHECK: paste this file (expected "Success. No rows returned"), then run
-- supabase/tests/account_delete_check.sql (needs the two test users, see that file).
