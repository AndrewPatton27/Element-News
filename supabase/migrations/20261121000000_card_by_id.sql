-- One published card by id, for the shared-card page /b/<id> (app/b/[id].tsx and the Cloudflare Pages
-- Function functions/b/[id].ts). Written, NOT applied: Drew applies it in the Supabase SQL editor after the
-- previous migrations (see supabase/supabase.md). Safe to re-run.
-- Anonymous like api.feed: same card JSON as every list (core.cards_json), without my_reaction. Returns null
-- for an unknown, hidden or retired card, so a share link never reveals a card that is not published.
-- (dev_only data cannot be a published card: rule 4, separate project + CHECK.)

create or replace function api.card_by_id(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select x.c - 'my_reaction'
  from core.blurbs b, lateral jsonb_array_elements(core.cards_json(array[b.id], null)) x(c)
  where b.id = p_id and b.status = 'published'
  limit 1;
$$;
revoke all on function api.card_by_id(uuid) from public;
grant execute on function api.card_by_id(uuid) to anon, authenticated;
