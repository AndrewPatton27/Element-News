-- =============================================================================
-- 20261210000000_ml_export_card_text.sql
-- Adds api.ml_export_card_text: headline and body of cards, for the offline vector ranker's shadow job.
--
-- Why: the vector part of the ML ranker (TF-IDF + SVD of headline and body, ml/elementml/features/embed.py)
-- needs card text. api.ml_export_cards deliberately exports only ids, tags and numbers. The shadow job runs on
-- the owner's laptop with the service-role key and writes scores to core.ml_shadow; readers never see them.
-- Changes no table, no feed and no setting. Service role only; same paging as api.ml_export_cards.
-- Returns {rows: [{id, headline, body}], next}. Published and hidden cards (cards a reader may have been shown).
--
-- HOW TO CHECK: paste this file twice (expected "Success. No rows returned" both times), then run
-- supabase/tests/ml_export_card_text_check.sql (expected "ALL ML_EXPORT_CARD_TEXT CHECKS PASSED").
-- =============================================================================
create or replace function api.ml_export_card_text(p_since timestamptz, p_next text default null, p_limit int default 5000)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
  v_ts   timestamptz := '-infinity';
  v_id   uuid := '00000000-0000-0000-0000-000000000000';
  v_rows jsonb;
  v_n    int;
  v_next text;
begin
  if p_since is null then raise exception 'invalid_since' using errcode = 'PT422'; end if;
  if p_next is not null then
    begin
      v_ts := split_part(p_next, '|', 1)::timestamptz;
      v_id := split_part(p_next, '|', 2)::uuid;
    exception when others then raise exception 'invalid_next' using errcode = 'PT422';
    end;
  end if;
  with page as (
    select b.id, b.headline, b.body, b.sort_at
      from core.blurbs b
     where b.status in ('published', 'hidden') and b.sort_at >= p_since and (b.sort_at, b.id) > (v_ts, v_id)
     order by b.sort_at, b.id
     limit v_lim + 1
  ), numbered as (
    select page.*, row_number() over (order by page.sort_at, page.id) as rn from page
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'headline', n.headline, 'body', coalesce(n.body, ''))
                            order by n.sort_at, n.id) filter (where n.rn <= v_lim), '[]'),
         count(*),
         max(to_char(n.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || n.id) filter (where n.rn = v_lim)
    into v_rows, v_n, v_next
    from numbered n;
  return jsonb_build_object('rows', v_rows, 'next', case when v_n > v_lim then v_next end);
end;
$$;

revoke all on function api.ml_export_card_text(timestamptz, text, int) from public, anon, authenticated;
grant execute on function api.ml_export_card_text(timestamptz, text, int) to service_role;
