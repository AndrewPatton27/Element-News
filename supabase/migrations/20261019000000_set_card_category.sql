-- Re-file a card under another category (2026-10-19). api.revise_blurb cannot change a card's
-- category, so a mis-filed card could not be corrected. Service-role only; idempotent.
-- api.set_card_category(p_id, p_category): the slug must exist in core.categories; only published or
-- hidden cards change (a hidden card keeps its status); updated_at = now(). Returns
-- {status: 'updated'|'not_found', id, category}. Raises 'invalid_category' for an unknown slug.
create or replace function api.set_card_category(p_id uuid, p_category text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_id is null or coalesce(p_category, '') = '' then
    raise exception 'set_card_category: id and category are required';
  end if;
  if not exists (select 1 from core.categories where slug = p_category) then
    raise exception 'invalid_category: %', p_category;
  end if;
  update core.blurbs
     set category = p_category, updated_at = now()
   where id = p_id and status in ('published', 'hidden');
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'updated' else 'not_found' end, 'id', p_id, 'category', p_category);
end;
$$;

revoke all on function api.set_card_category(uuid, text) from public, anon, authenticated;
grant execute on function api.set_card_category(uuid, text) to service_role;
