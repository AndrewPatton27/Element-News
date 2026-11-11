-- Store the AI relevance score on each card (prompt sum-v7, 2026-11-10).
--
-- The summarizer scores every item 1-5 for how much it matters to a reader who follows business, the economy,
-- markets and investing (the rubric is in ingest/src/summarizer/gemini.ts). Until now the score only decided
-- publish or skip and was kept in ingest.items.status_note. Ranking needs it on the card, so a relevance-3
-- product recall can stay out of Trending, Latest and For you (standing content rule) while category browse,
-- company pages and search still reach it.
--
--   A. core.blurbs.everyday_relevance smallint (null = no AI score: template, data and older cards), 1..5.
--   B. api.publish_blurb: same body as 20261017050000_detail_revise.sql plus the new column.
--   C. api.revise_blurb:  same body as 20261017050000_detail_revise.sql plus the new column; the column is
--      replaced only when the payload carries the key (a --rewrite revise sends it; other revisers do not).
--
-- No index: nothing reads the column yet. When the ranking change filters on it
-- ("category = 'safety' and everyday_relevance <= 3") add a partial index in that migration.
-- Idempotent: safe to run twice. Apply with `supabase db query --remote --yes -f`, never `db push`.
-- The score is not part of the card JSON (api.feed does not return it).

-- ---------- A. column -------------------------------------------------------------------------
alter table core.blurbs add column if not exists everyday_relevance smallint check (everyday_relevance between 1 and 5);

comment on column core.blurbs.everyday_relevance is
  'AI relevance score 1-5 (prompt sum-v7 rubric: market and macro significance); null for template, data and pre-sum-v7 cards.';

-- ---------- B. api.publish_blurb ----------------------------------------------------------------
create or replace function api.publish_blurb(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_cfg      core.app_config%rowtype;
  v_cap      numeric;
  v_sort     timestamptz := (p ->> 'sort_at')::timestamptz;
  v_ai       boolean := coalesce((p ->> 'ai_generated')::boolean, false);
  v_nsrc     int := coalesce(jsonb_array_length(p -> 'sources'), 0);
  v_tickers  jsonb := coalesce(p -> 'tickers', '[]'::jsonb);
  v_rel      smallint := case when (p ->> 'everyday_relevance') ~ '^[1-5]$' then (p ->> 'everyday_relevance')::smallint end;
  v_sym      text;
  v_count    int;
  s          jsonb;
  i          int := 0;
begin
  select * into v_cfg from core.app_config where id;
  if not found then raise exception 'app_config row missing'; end if;

  if v_nsrc < 1 then raise exception 'publish_blurb: card needs at least one source'; end if;
  if v_nsrc > 8 then raise exception 'publish_blurb: at most 8 sources'; end if;
  if p ->> 'kind' = 'link_out' and not v_cfg.linkout_cards then
    raise exception 'publish_blurb: link_out cards are disabled';
  end if;

  -- duplicate (same filing / same data point): return the existing card
  select id into v_id from core.blurbs where dedupe_key = p ->> 'dedupe_key';
  if found then
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  -- per-ticker cap: at most N cards per ticker within 24 h of this card's time
  select value into v_cap from core.rank_params where key = 'ticker_cap_24h';
  for v_sym in select t ->> 'symbol' from jsonb_array_elements(v_tickers) t loop
    select count(*) into v_count
      from core.blurbs b
     where b.tickers @> jsonb_build_array(jsonb_build_object('symbol', v_sym))
       and b.sort_at > v_sort - interval '24 hours'
       and b.sort_at < v_sort + interval '24 hours';
    if v_count >= coalesce(v_cap, 3) then
      return jsonb_build_object('status', 'ticker_cap', 'id', null, 'symbol', v_sym);
    end if;
  end loop;

  insert into core.blurbs (dedupe_key, kind, headline, body, category, event_type,
                           ai_generated, ai_label, attribution, tickers, macro,
                           as_of, sort_at, model, prompt_version, detail, everyday_relevance)
  values (p ->> 'dedupe_key', p ->> 'kind', p ->> 'headline', p ->> 'body',
          p ->> 'category', p ->> 'event_type',
          v_ai, case when v_ai then v_cfg.ai_notice else null end,   -- label comes from app_config only
          p ->> 'attribution',
          (select coalesce(jsonb_agg(jsonb_build_object('symbol', t ->> 'symbol',
                                                        'name', t ->> 'name',
                                                        'exchange', t -> 'exchange')), '[]'::jsonb)
             from jsonb_array_elements(v_tickers) t),
          coalesce(p -> 'macro', '[]'::jsonb),
          coalesce((p ->> 'as_of')::timestamptz, v_sort), v_sort,
          p ->> 'model', p ->> 'prompt_version',
          case when jsonb_typeof(p -> 'detail') = 'object' then p -> 'detail' else null end,
          case when v_ai then v_rel else null end)                   -- only AI cards carry a score
  returning id into v_id;

  for s in select value from jsonb_array_elements(p -> 'sources') loop
    insert into core.blurb_sources (blurb_id, item_id, name, kind, doc_label, url, published_at,
                                    license_class, attribution, is_primary, position)
    values (v_id, nullif(p ->> 'item_id', '')::uuid, s ->> 'name', s ->> 'kind', s ->> 'doc_label',
            s ->> 'url', (s ->> 'published_at')::timestamptz, s ->> 'license_class',
            s ->> 'attribution', coalesce((s ->> 'is_primary')::boolean, i = 0), i);
    i := i + 1;
  end loop;

  if p ? 'item_id' and nullif(p ->> 'item_id', '') is not null then
    update ingest.items set status = 'published', blurb_id = v_id where id = (p ->> 'item_id')::uuid;
  end if;

  perform core.refresh_rank(v_id);
  return jsonb_build_object('status', 'published', 'id', v_id);
end;
$$;

revoke execute on function api.publish_blurb(jsonb) from public, anon, authenticated;
grant  execute on function api.publish_blurb(jsonb) to service_role;

-- ---------- C. api.revise_blurb ----------------------------------------------------------------
-- p: {id, action: 'revise', headline, body, ai_generated, model, prompt_version, detail, everyday_relevance}
--  | {id, action: 'hide', note}
-- The score follows the card text: a template revise (ai_generated false) clears it, an AI revise stores the new
-- score when the payload has one, and a revise without the key leaves the stored score alone.
create or replace function api.revise_blurb(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid := (p ->> 'id')::uuid;
  v_ai   boolean := coalesce((p ->> 'ai_generated')::boolean, false);
  v_rel  smallint := case when (p ->> 'everyday_relevance') ~ '^[1-5]$' then (p ->> 'everyday_relevance')::smallint end;
  v_cfg  core.app_config%rowtype;
  v_n    int;
begin
  if p ->> 'action' = 'hide' then
    update core.blurbs set status = 'hidden' where id = v_id and status = 'published';
    get diagnostics v_n = row_count;
    return jsonb_build_object('status', case when v_n = 1 then 'hidden' else 'not_found' end, 'id', v_id);
  end if;
  if coalesce(p ->> 'action', '') <> 'revise' then
    raise exception 'revise_blurb: action must be revise or hide';
  end if;
  if coalesce(p ->> 'headline', '') = '' then
    raise exception 'revise_blurb: headline missing';
  end if;
  select * into v_cfg from core.app_config where id;
  update core.blurbs
     set headline       = p ->> 'headline',
         body           = nullif(p ->> 'body', ''),
         ai_generated   = v_ai,
         ai_label       = case when v_ai then v_cfg.ai_notice else null end,
         model          = p ->> 'model',
         prompt_version = p ->> 'prompt_version',
         detail         = case when not (p ? 'detail') then detail
                               when jsonb_typeof(p -> 'detail') = 'object' then p -> 'detail'
                               else null end,
         everyday_relevance = case when not v_ai then null
                                   when p ? 'everyday_relevance' then v_rel
                                   else everyday_relevance end,
         revision       = revision + 1,
         updated_at     = now()
   where id = v_id and status = 'published';
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'revised' else 'not_found' end, 'id', v_id);
end;
$$;

revoke execute on function api.revise_blurb(jsonb) from public, anon, authenticated;
grant  execute on function api.revise_blurb(jsonb) to service_role;
