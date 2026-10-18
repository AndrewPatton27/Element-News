-- Brief depth (2026-10-18, Drew): the daily and weekly Brief go deep on the most important topics.
--   * a section for EVERY topic that has cards in the window, most important first
--     (importance = highest rank_score among its cards, then card count), up to 8 sections;
--   * depth follows importance: topics ranked 1-3 return up to p_top stories (daily 6, weekly 8),
--     ranks 4-5 up to 3, ranks 6-8 up to 2; one card per story (dedupe_key), best score first;
--   * each section ADDS optional fields (old fields are unchanged, so old app builds keep working):
--       slug (same as category), rank (1 = most important), total (eligible stories the topic has
--       in the window, for "See all 14");
--   * headline_cards stay 3 cards from three different topics (the top card of the top 3 topics);
--   * daily window: 24 h, or 48 h when fewer than 12 cards in 24 h, or 72 h when fewer than 12
--     in 48 h (window_hours says which); weekly is 168 h.
-- Numbers (4) and weekly movers are unchanged. Same published / link-out / source filters as before.
-- Tunables (also in context/settings.md): top-3 limit (6 / 8), ranks 4-5 limit (3), ranks 6-8 limit (2),
-- max sections (8), widen threshold (12 cards).
-- Idempotent (create or replace). Apply with supabase db push; never applied by an agent.

-- ---------- core.brief_supply: how many eligible cards in the last p_hours --------------------
create or replace function core.brief_supply(p_hours int)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int
    from core.blurbs b join core.app_config c on c.id
   where b.status = 'published' and b.published_at <= now()
     and b.sort_at >= now() - make_interval(hours => p_hours)
     and (b.kind <> 'link_out' or c.linkout_cards)
     and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id);
$$;
revoke all on function core.brief_supply(int) from public, anon, authenticated;

-- ---------- core.brief_build: headline cards + sections for one window ------------------------
create or replace function core.brief_build(p_hours int, p_top int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_head jsonb; v_sections jsonb;
begin
  with eligible as (
    select b.id, b.category, b.dedupe_key, b.rank_score
      from core.blurbs b join core.app_config c on c.id
     where b.status = 'published' and b.published_at <= now()
       and b.sort_at >= now() - make_interval(hours => p_hours)
       and (b.kind <> 'link_out' or c.linkout_cards)
       and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
  ), uniq as (            -- one card per story
    select e.* from (
      select e.*, row_number() over (partition by e.dedupe_key order by e.rank_score desc, e.id desc) dn from eligible e
    ) e where e.dn = 1
  ), topics as (          -- topic importance: best card first, then how many cards
    select u.category, max(u.rank_score) top_score, count(*)::int total,
           row_number() over (order by max(u.rank_score) desc, count(*) desc, u.category) trank
      from uniq u group by u.category
  ), picked as (
    select u.id, u.category, u.rank_score, t.trank, t.total,
           row_number() over (partition by u.category order by u.rank_score desc, u.id desc) n
      from uniq u join topics t on t.category = u.category
     where t.trank <= 8
  ), chosen as (
    select * from picked where n <= case when trank <= 3 then greatest(p_top, 1) when trank <= 5 then 3 else 2 end
  ), section_json as (
    select c.category, c.trank, c.total,
           (select coalesce(jsonb_agg(j.c - 'my_reaction' order by j.o), '[]'::jsonb)
              from jsonb_array_elements(core.cards_json(array_agg(c.id order by c.rank_score desc, c.id desc), null)) with ordinality j(c, o)) cards
      from chosen c group by c.category, c.trank, c.total
  )
  select coalesce((select jsonb_agg(x.c - 'my_reaction' order by x.o)
                     from jsonb_array_elements(core.cards_json(
                            (select array_agg(h.id order by h.trank) from chosen h where h.n = 1 and h.trank <= 3), null)) with ordinality x(c, o)), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'category', s.category, 'slug', s.category,
                     'label', coalesce((select name from core.categories k where k.slug = s.category), s.category),
                     'rank', s.trank, 'total', s.total, 'cards', s.cards) order by s.trank) from section_json s), '[]'::jsonb)
    into v_head, v_sections;
  return jsonb_build_object('headline_cards', v_head, 'sections', v_sections);
end; $$;
revoke all on function core.brief_build(int, int) from public, anon, authenticated;

-- ---------- api.daily_brief ---------------------------------------------------------------------
create or replace function api.daily_brief()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_hours int := 24; v_built jsonb; v_numbers jsonb;
begin
  if core.brief_supply(24) < 12 then
    v_hours := 48;
    if core.brief_supply(48) < 12 then v_hours := 72; end if;
  end if;
  v_built := core.brief_build(v_hours, 6);
  select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order), '[]'::jsonb) into v_numbers
    from (select * from api.numbers_to_know order by sort_order limit 4) n;
  return jsonb_build_object('generated_at', now(), 'window_hours', v_hours,
    'headline_cards', v_built->'headline_cards', 'sections', v_built->'sections', 'numbers', v_numbers);
end; $$;
revoke all on function api.daily_brief() from public;
grant execute on function api.daily_brief() to anon, authenticated;

-- ---------- api.weekly_brief --------------------------------------------------------------------
create or replace function api.weekly_brief()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_built jsonb; v_numbers jsonb;
begin
  v_built := core.brief_build(168, 8);
  select coalesce(jsonb_agg(to_jsonb(n) order by n.sort_order), '[]'::jsonb) into v_numbers
    from (select * from api.numbers_to_know order by sort_order limit 4) n;
  return jsonb_build_object('generated_at', now(), 'window_hours', 168,
    'headline_cards', v_built->'headline_cards', 'sections', v_built->'sections', 'numbers', v_numbers,
    'movers', api.number_trends());
end; $$;
revoke all on function api.weekly_brief() from public;
grant execute on function api.weekly_brief() to anon, authenticated;

notify pgrst, 'reload schema';
