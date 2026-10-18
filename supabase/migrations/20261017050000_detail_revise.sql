-- In-depth summary ("detail") + rewriting older cards in place (2026-10-17, D-37).
-- A. core.blurbs.detail: {paragraphs: string[], key_points: string[]} or null. Shown when a card is opened.
-- B. api.feed and core.cards_json (used by api.feed_for_you) return `detail`. Same bodies as before
--    plus that one key (api.feed from the init migration, core.cards_json from the accounts migration).
-- C. api.publish_blurb stores `detail` (same body as the init migration plus that column).
-- D. Service-role-only RPCs for the ingest script's `--rewrite` mode: api.blurbs_to_revise, api.revise_blurb.
-- Requires the accounts migration (core.cards_json). Idempotent: safe to run more than once.

-- ---------- A. column ------------------------------------------------------------------
alter table core.blurbs add column if not exists detail jsonb;
alter table core.blurbs drop constraint if exists blurbs_detail_shape;
alter table core.blurbs add constraint blurbs_detail_shape check (
  detail is null or coalesce(jsonb_typeof(detail) = 'object'
                             and jsonb_typeof(detail -> 'paragraphs') = 'array'
                             and jsonb_typeof(detail -> 'key_points') = 'array', false));

-- ---------- B. api.feed (adds 'detail') --------------------------------------------------------
create or replace function api.feed(
  p_mode     text default 'top',
  p_cursor   text default null,
  p_limit    int  default 20,
  p_category text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode     text := coalesce(p_mode, 'top');
  v_limit    int  := least(greatest(coalesce(p_limit, 20), 10), 30);
  v_rank_key numeric;
  v_time_key timestamptz;
  v_id       uuid;
  v_ids      uuid[];
  v_keys     text[];
  v_next     text;
  v_items    jsonb;
begin
  if v_mode not in ('top', 'latest') then
    raise exception 'invalid_mode' using errcode = 'PT422';
  end if;

  -- no cursor = start above everything (keeps the range test index-friendly)
  if p_cursor is null then
    v_rank_key := 1e12;
    v_time_key := 'infinity';
    v_id       := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  else
    begin
      v_id := split_part(p_cursor, '|', 2)::uuid;
      if v_mode = 'top' then v_rank_key := split_part(p_cursor, '|', 1)::numeric;
      else                   v_time_key := split_part(p_cursor, '|', 1)::timestamptz;
      end if;
    exception when others then
      raise exception 'invalid_cursor' using errcode = 'PT422';
    end;
  end if;

  -- step 1: ids of this page, plus one extra row to know if a next page exists
  if v_mode = 'top' then
    select array_agg(s.id order by s.rank_score desc, s.id desc),
           array_agg(s.rank_score::text order by s.rank_score desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.rank_score
          from core.blurbs b
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and (b.rank_score, b.id) < (v_rank_key, v_id)
         order by b.rank_score desc, b.id desc
         limit v_limit + 1
      ) s;
  else
    select array_agg(s.id order by s.sort_at desc, s.id desc),
           array_agg(to_char(s.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                     order by s.sort_at desc, s.id desc)
      into v_ids, v_keys
      from (
        select b.id, b.sort_at
          from core.blurbs b
         where b.status = 'published'
           and (p_category is null or b.category = p_category)
           and (b.sort_at, b.id) < (v_time_key, v_id)
         order by b.sort_at desc, b.id desc
         limit v_limit + 1
      ) s;
  end if;

  v_ids := coalesce(v_ids, '{}');
  if cardinality(v_ids) > v_limit then
    v_next := v_keys[v_limit] || '|' || v_ids[v_limit];   -- cursor = last row returned
    v_ids  := v_ids[1:v_limit];
  end if;

  -- step 2: card JSON in the same order (shape = BlurbCard in the contract)
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'headline', b.headline, 'body', b.body,
      'category', b.category, 'event_type', b.event_type,
      'tickers', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'symbol', t.value ->> 'symbol',
                   'name', t.value ->> 'name',
                   'exchange', t.value -> 'exchange',
                   'quote', null)                       -- prices are never shown
                 order by t.ordinality)
            from jsonb_array_elements(b.tickers) with ordinality as t(value, ordinality)), '[]'::jsonb),
      'macro', b.macro,
      'sources', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', s.name, 'kind', s.kind, 'doc_label', s.doc_label, 'url', s.url,
                   'published_at', s.published_at, 'license_class', s.license_class,
                   'attribution', s.attribution, 'is_primary', s.is_primary)
                 order by s.is_primary desc, s.position, s.id)
            from core.blurb_sources s where s.blurb_id = b.id), '[]'::jsonb),
      'source_count', b.source_count,
      'as_of', b.as_of, 'published_at', b.published_at, 'sort_at', b.sort_at,
      'updated_at', b.updated_at, 'revision', b.revision,
      'freshness', jsonb_build_object('delayed_hours', b.delayed_hours),
      'ai', jsonb_build_object('generated', b.ai_generated, 'label', b.ai_label),
      'attribution', b.attribution,
      'image', null,
      'is_saved', false,
      'share_path', '/b/' || b.id,
      'importance', b.importance,
      'detail', b.detail                                -- in-depth summary (null = none)
    ) order by u.ord), '[]'::jsonb)
  into v_items
  from unnest(v_ids) with ordinality as u(id, ord)
  join core.blurbs b on b.id = u.id;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

revoke execute on function api.feed(text, text, int, text) from public;
grant  execute on function api.feed(text, text, int, text) to anon, authenticated, service_role;

-- ---------- B. core.cards_json (adds 'detail'; used by api.feed_for_you) --------------------------
create or replace function core.cards_json(p_ids uuid[], p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'headline', b.headline, 'body', b.body,
      'category', b.category, 'event_type', b.event_type,
      'tickers', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'symbol', t.value ->> 'symbol',
                   'name', t.value ->> 'name',
                   'exchange', t.value -> 'exchange',
                   'quote', null)                       -- prices are never shown
                 order by t.ordinality)
            from jsonb_array_elements(b.tickers) with ordinality as t(value, ordinality)), '[]'::jsonb),
      'macro', b.macro,
      'sources', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', s.name, 'kind', s.kind, 'doc_label', s.doc_label, 'url', s.url,
                   'published_at', s.published_at, 'license_class', s.license_class,
                   'attribution', s.attribution, 'is_primary', s.is_primary)
                 order by s.is_primary desc, s.position, s.id)
            from core.blurb_sources s where s.blurb_id = b.id), '[]'::jsonb),
      'source_count', b.source_count,
      'as_of', b.as_of, 'published_at', b.published_at, 'sort_at', b.sort_at,
      'updated_at', b.updated_at, 'revision', b.revision,
      'freshness', jsonb_build_object('delayed_hours', b.delayed_hours),
      'ai', jsonb_build_object('generated', b.ai_generated, 'label', b.ai_label),
      'attribution', b.attribution,
      'image', null,
      'is_saved', false,
      'share_path', '/b/' || b.id,
      'importance', b.importance,
      'detail', b.detail,
      'my_reaction', (select e.kind from core.user_events e
                       where e.user_id = p_user and e.blurb_id = b.id
                         and e.kind in ('like', 'dislike')
                       order by e.created_at desc limit 1)
    ) order by u.ord), '[]'::jsonb)
  from unnest(p_ids) with ordinality as u(id, ord)
  join core.blurbs b on b.id = u.id;
$$;

revoke all on function core.cards_json(uuid[], uuid) from public, anon, authenticated;

-- ---------- C. api.publish_blurb (stores 'detail') --------------------------------------------
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
                           as_of, sort_at, model, prompt_version, detail)
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
          case when jsonb_typeof(p -> 'detail') = 'object' then p -> 'detail' else null end)
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

-- ---------- D. rewrite RPCs ------------------------------------------------------------------
-- ---------- api.blurbs_to_revise ---------------------------------------------------------
-- Published cards whose prompt_version is not in p_current (null counts as "not current"),
-- most visible first (rank_score desc), at most p_limit (1..200).
-- Returns a jsonb array of {id, kind, headline, body, category, event_type, ai_generated,
-- prompt_version, tickers, macro, attribution, as_of, sort_at, dedupe_key, sources[], item}.
-- item = the collected ingest.items row behind the card (source, external_id, url, title,
-- license_class), or null (data cards have none).
create or replace function api.blurbs_to_revise(p_current text[], p_limit int default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.card order by x.rank_score desc, x.id desc), '[]'::jsonb)
    from (
      select b.id, b.rank_score,
             jsonb_build_object(
               'id', b.id, 'kind', b.kind, 'headline', b.headline, 'body', b.body,
               'category', b.category, 'event_type', b.event_type, 'ai_generated', b.ai_generated,
               'prompt_version', b.prompt_version, 'tickers', b.tickers, 'macro', b.macro,
               'attribution', b.attribution, 'as_of', b.as_of, 'sort_at', b.sort_at, 'dedupe_key', b.dedupe_key,
               'detail', b.detail,
               'sources', (select coalesce(jsonb_agg(jsonb_build_object(
                             'name', s.name, 'kind', s.kind, 'doc_label', s.doc_label, 'url', s.url,
                             'published_at', s.published_at, 'license_class', s.license_class,
                             'attribution', s.attribution, 'is_primary', s.is_primary) order by s.position), '[]'::jsonb)
                             from core.blurb_sources s where s.blurb_id = b.id),
               'item', (select jsonb_build_object('source', i.source, 'external_id', i.external_id, 'url', i.url,
                                                  'title', i.title, 'license_class', i.license_class)
                          from ingest.items i where i.blurb_id = b.id
                          order by i.fetched_at limit 1)
             ) as card
        from core.blurbs b
       where b.status = 'published'
         and (b.prompt_version is null or not (b.prompt_version = any (coalesce(p_current, '{}'))))
       order by b.rank_score desc, b.id desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) x;
$$;

-- ---------- api.revise_blurb ---------------------------------------------------------------
-- p: {id, action: 'revise', headline, body, ai_generated, model, prompt_version, detail}
--  | {id, action: 'hide', note}
-- revise: same id, category, event_type, sources, sort_at; new headline/body/AI fields;
--         detail replaced when the key is present (null or a non-object clears it);
--         revision + 1; updated_at = now(). The AI label comes from app_config only.
-- hide:   status 'hidden' (reversible: set it back to 'published').
-- Only published cards are changed. Returns {status: 'revised'|'hidden'|'not_found', id}.
create or replace function api.revise_blurb(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid := (p ->> 'id')::uuid;
  v_ai   boolean := coalesce((p ->> 'ai_generated')::boolean, false);
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
         revision       = revision + 1,
         updated_at     = now()
   where id = v_id and status = 'published';
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'revised' else 'not_found' end, 'id', v_id);
end;
$$;

revoke execute on function api.blurbs_to_revise(text[], int) from public, anon, authenticated;
revoke execute on function api.revise_blurb(jsonb) from public, anon, authenticated;
grant  execute on function api.blurbs_to_revise(text[], int) to service_role;
grant  execute on function api.revise_blurb(jsonb) to service_role;

-- ---------- for Drew -------------------------------------------------------------------------
-- Paste into the Supabase SQL editor and run (after the accounts migration). Expected:
-- "Success. No rows returned". Old cards keep working (detail is null until --rewrite fills it).
