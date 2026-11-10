-- Recall gate fix: only the RECALLING company makes a recall "material", not a retailer named in the text.
-- Must run after 20261116000000_macro_focus.sql and 20261115000000_companies.sql. Idempotent. NOT applied.
--
-- Found by the recommendation audit (2026-11-09, live project, anonymous read-only calls): 16 recalls were in
-- the guest Trending and Latest lists although the standing content rule hides small recalls there. 15 of them
-- were small sellers' products "sold on Amazon" / "sold at Walmart" (e.g. "Hasuit recalls 7-drawer dressers sold
-- on Amazon", "Gihnjsi squeezy dumplings toys recalled over choking hazard"). Cause: the text backfill
-- (core.backfill_recall_material, macro_focus section C2) took every company tag of the card from
-- core.card_companies, and the company tagger tags "Amazon" / "Walmart" wherever the text names them, so the
-- watch-list rule (micro_watch_material = 1) made every such recall material. The ingest (cpsc.ts classifyRecall)
-- already looks only at the recall's manufacturer / importer / distributor names, so new ingest verdicts are right.
--
-- Fix: the text backfill now uses only (a) the card's own tickers (set by the ingest for the recalling firm) and
-- (b) companies named in the headline BEFORE the first "recall" word ("Walmart recalls Mainstays dressers" ->
-- WMT; "Hasuit recalls dressers sold on Amazon" -> none; "Recall issued for ..." -> none). Then every earlier
-- 'text:' verdict is redone (core.backfill_recall_material(true)); ingest verdicts are never touched.
-- The stored verdict tickers (used by api.followed_micro) are corrected the same way. Units, deaths, serious
-- injuries and stop-sale rules are unchanged. Checked by tests/recall_firm_material_check.sql.

-- Companies named in a recall headline before its first "recall" word (the recalling firm).
create or replace function core.recall_firm_tickers(p_headline text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct m.ticker order by m.ticker), '{}')
    from (select substring(coalesce(p_headline, '') from '^(.*?)\m[Rr]ecall') as pre) h
    cross join lateral core.match_companies(coalesce(h.pre, ''), '{}', false) m
   where coalesce(btrim(h.pre), '') <> ''
     and m.confidence >= coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);
$$;
revoke all on function core.recall_firm_tickers(text) from public, anon, authenticated;

-- Same contract as 20261116000000 (signature, return shape, bounds); only the company list changes.
create or replace function core.backfill_recall_material(p_overwrite boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r      record;
  v_t    text[];
  v_v    jsonb;
  v_n    int := 0;
  v_set  int := 0;
  v_mat  int := 0;
  v_cc   boolean := to_regclass('core.companies') is not null;
begin
  for r in
    select b.id, b.tickers, b.headline,
           concat_ws('. ', b.headline, b.body,
                     (select string_agg(x, ' ') from jsonb_array_elements_text(
                        case when jsonb_typeof(b.detail -> 'paragraphs') = 'array' then b.detail -> 'paragraphs' else '[]'::jsonb end) x)) as txt
      from core.blurbs b
      left join core.card_material m on m.blurb_id = b.id
     where b.category in (select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value = 2)
       and (m.blurb_id is null or (p_overwrite and not exists (select 1 from unnest(m.reasons) x where not starts_with(x, 'text:'))))
     order by b.sort_at desc, b.id
     limit 5000
  loop
    v_n := v_n + 1;
    v_t := array(select upper(t ->> 'symbol') from jsonb_array_elements(coalesce(r.tickers, '[]'::jsonb)) t
                  where upper(t ->> 'symbol') ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$');
    if v_cc then
      v_t := array(select distinct x from unnest(v_t || core.recall_firm_tickers(r.headline)) x order by x);
    end if;
    v_t := v_t[1:5];
    v_v := core.recall_text_verdict(r.txt, v_t);
    insert into core.card_material (blurb_id, material, reasons, tickers, set_at)
    values (r.id, (v_v ->> 'material')::boolean, array(select jsonb_array_elements_text(v_v -> 'reasons')), coalesce(v_t, '{}'), now())
    on conflict (blurb_id) do update
       set material = excluded.material, reasons = excluded.reasons, tickers = excluded.tickers, set_at = excluded.set_at;
    v_set := v_set + 1;
    if (v_v ->> 'material')::boolean then v_mat := v_mat + 1; end if;
  end loop;
  return jsonb_build_object('checked', v_n, 'set', v_set, 'material', v_mat);
end;
$$;
revoke all on function core.backfill_recall_material(boolean) from public, anon, authenticated;

-- redo every earlier text verdict with the corrected company list (ingest verdicts are left alone)
select core.backfill_recall_material(true);

-- api.followed_micro (the left-out recalls of followed companies) read every company tag, so a follower of AMZN
-- would be sent each small seller's "sold on Amazon" recall. It now reads company tags only at confidence
-- >= followed_recall_min_confidence (0.75: ticker, filing, alias or a name with a company cue; the "sold on Amazon"
-- mention is 0.6). Same signature, shape and grants; the body is 20261116000000's apart from that line.
insert into core.rank_params (key, value) values ('followed_recall_min_confidence', 0.75) on conflict (key) do nothing;
alter table core.rank_params drop constraint if exists rank_params_micro_follow_conf_range;
alter table core.rank_params add constraint rank_params_micro_follow_conf_range
  check (key <> 'followed_recall_min_confidence' or (value >= 0 and value <= 1));

create or replace function api.followed_micro(p_tickers text[], p_limit int default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_t     text[] := array(select distinct upper(x) from unnest(coalesce(p_tickers, '{}')) x
                           where upper(x) ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$' limit 20);
  v_days  numeric;
  v_max   int;
  v_lim   int;
  v_conf  numeric;
  v_since timestamptz;
  v_ids   uuid[] := '{}';
  v_more  uuid[];
  v_hid   text[];
  v_hsrc  text[];
begin
  if cardinality(v_t) = 0 then return jsonb_build_object('items', '[]'::jsonb); end if;
  select coalesce(max(value) filter (where key = 'micro_follow_days'), 14),
         coalesce(max(value) filter (where key = 'micro_follow_max'), 30)::int,
         coalesce(max(value) filter (where key = 'followed_recall_min_confidence'), 0.75)
    into v_days, v_max, v_conf from core.rank_params;
  v_lim   := least(greatest(coalesce(p_limit, 10), 1), v_max);
  v_since := now() - make_interval(secs => v_days * 86400);

  v_ids := array(select m.blurb_id from core.card_material m join core.blurbs b on b.id = m.blurb_id
                  where m.tickers && v_t and b.sort_at > v_since
                  order by b.sort_at desc, b.id desc limit v_max * 2);
  if to_regclass('core.card_companies') is not null then                  -- company-m8 tags (optional)
    execute 'select coalesce(array_agg(blurb_id), ''{}'') from (select blurb_id from core.card_companies
              where ticker = any ($1) and sort_at > $2 and confidence >= $4 order by sort_at desc limit $3) z'
      into v_more using v_t, v_since, v_max * 2, v_conf;
    v_ids := v_ids || v_more;
  end if;
  if v_uid is not null then
    select hidden_categories, hidden_sources into v_hid, v_hsrc from core.user_prefs where user_id = v_uid;
  end if;
  v_hid  := coalesce(v_hid, '{}');
  v_hsrc := coalesce(v_hsrc, '{}');
  v_ids := array(select b.id from core.blurbs b
                  where b.id = any (core.micro_gated_ids(v_ids))
                    and b.status = 'published' and b.sort_at > v_since
                    and not (b.category = any (v_hid))
                    and (cardinality(v_hsrc) = 0 or not (core.source_key_of(b.kind, b.id) = any (v_hsrc)))
                  order by b.sort_at desc, b.id desc limit v_lim);
  return jsonb_build_object('items', (select coalesce(jsonb_agg(x.c - 'my_reaction' order by x.o), '[]'::jsonb)
                                        from jsonb_array_elements(core.cards_json(v_ids, null)) with ordinality as x(c, o)));
end;
$$;
revoke all on function api.followed_micro(text[], int) from public;
grant execute on function api.followed_micro(text[], int) to anon, authenticated, service_role;

-- ---------- for Drew -------------------------------------------------------------------------------
-- Paste this file into the SQL editor after the search v6 file. Expected: one row {checked, set, material}.
-- Check: select api.macro_share();  -> gated_14d.left_out goes up; Trending shows only big-company or large recalls.
