-- Broad topics (2026-10-17): three new categories (world, science, safety), plain display names
-- for three existing ones, the cc_by_sa license class (Wikipedia "In the news"), event weights
-- for the new event types, a CC BY-SA notice, and api.categories limited to categories that
-- have at least one published card (so the app never shows an empty chip).
-- Idempotent: safe to run more than once. Slugs are unchanged, so old cards and app builds keep working.

-- ---------- categories: 12 rows, final order and display names ----------------------
insert into core.categories (slug, name, sort_order) values
  ('world',            'World',             1),
  ('policy',           'Government',        2),
  ('economy',          'Economy',           3),
  ('personal-finance', 'Money',             4),
  ('markets',          'Business',          5),
  ('tech',             'Tech',              6),
  ('science',          'Science & Space',   7),
  ('safety',           'Recalls & Safety',  8),
  ('earnings',         'Earnings',          9),
  ('deals',            'Deals',            10),
  ('energy',           'Energy',           11),
  ('insider',          'Insider trades',   12)
on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order;

-- ---------- license classes: add cc_by_sa (still never dev_only) ----------------------
alter table ingest.items drop constraint if exists items_license_class_check;
alter table ingest.items add constraint items_license_class_check
  check (license_class in ('public_domain', 'company_filing', 'guardian_noncomm', 'link_out', 'iex_hist', 'cc_by_sa'));

alter table core.blurb_sources drop constraint if exists blurb_sources_license_class_check;
alter table core.blurb_sources add constraint blurb_sources_license_class_check
  check (license_class in ('public_domain', 'company_filing', 'guardian_noncomm', 'link_out', 'iex_hist', 'cc_by_sa'));

-- ---------- api.categories: only categories with at least one published card ----------
create or replace view api.categories as
select c.slug, c.name, c.sort_order
  from core.categories c
 where exists (select 1 from core.blurbs b where b.category = c.slug and b.status = 'published')
 order by c.sort_order;

revoke all on api.categories from public;
grant select on api.categories to anon, authenticated, service_role;

-- ---------- ranking weights for the new event types ------------------------------------
insert into core.rank_event_weights (event_type, weight) values
  ('world_event', 6), ('recall', 5), ('science', 3)
on conflict (event_type) do nothing;

-- ---------- CC BY-SA notice (license link for Wikipedia-based cards) ----------------------
update core.app_config
   set required_notices = required_notices || jsonb_build_array(jsonb_build_object(
         'key', 'cc_by_sa',
         'text', 'Adapted from Wikipedia · CC BY-SA 4.0',
         'url', 'https://creativecommons.org/licenses/by-sa/4.0/',
         'placements', jsonb_build_array('about')))
 where id
   and not exists (select 1 from jsonb_array_elements(required_notices) n where n ->> 'key' = 'cc_by_sa');

-- ---------- for Drew ---------------------------------------------------------------------
-- Paste this whole file into the Supabase SQL editor and run it. Expected: "Success. No rows returned".
-- Check (as anon, e.g. the app's chip row or: select * from api.categories;):
--   only categories that already have cards appear, with the new names (Government, Money, Business).
--   World, Science & Space and Recalls & Safety appear after their first cards are published.
-- select required_notices from api.app_config;  -> now also lists the cc_by_sa notice.
