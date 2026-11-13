-- D-296 / D-297: link-out cards need a full summary. One-off fill pass support (service role only).
-- A. api.link_out_without_summary(p_limit): published AND queued link_out cards that still have no body (same card shape as
--    api.blurbs_to_revise), so the fill pass also reaches cards waiting in the 12 h release queue.
-- B. api.revise_blurb: a link_out card in the queue ('queued') can be revised or hidden like a published one. Other kinds unchanged.
-- Idempotent. Apply with `db query -f`, never `db push`. Check:
--   select kind, status, count(*), count(body) from core.blurbs where kind = 'link_out' group by 1, 2;

-- ---------- A. lister ----------------------------------------------------------------------
create or replace function api.link_out_without_summary(p_limit int default 200)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.card order by x.sort_at desc, x.id desc), '[]'::jsonb)
    from (
      select b.id, b.sort_at,
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
       where b.kind = 'link_out'
         and b.status in ('published', 'queued')
         and (b.body is null or b.body = '')
       order by b.sort_at desc, b.id desc
       limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) x;
$$;

revoke execute on function api.link_out_without_summary(int) from public, anon, authenticated;
grant  execute on function api.link_out_without_summary(int) to service_role;

-- ---------- B. revise_blurb: queued link_out cards ------------------------------------------
-- Same function as 20261123000000_everyday_relevance.sql; the only change is the status test in both updates.
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
    update core.blurbs set status = 'hidden'
     where id = v_id and (status = 'published' or (kind = 'link_out' and status = 'queued'));
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
   where id = v_id and (status = 'published' or (kind = 'link_out' and status = 'queued'));
  get diagnostics v_n = row_count;
  return jsonb_build_object('status', case when v_n = 1 then 'revised' else 'not_found' end, 'id', v_id);
end;
$$;

revoke execute on function api.revise_blurb(jsonb) from public, anon, authenticated;
grant  execute on function api.revise_blurb(jsonb) to service_role;
