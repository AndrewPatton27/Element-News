-- Checks for 20261201000000_newsdata_linkout.sql: a link_out card publishes only while app_config.linkout_cards is true,
-- gets delayed_hours 12, keeps its source and no body; run_log accepts the new source names. Rolls back at the final error.
do $$
declare
  r jsonb; p jsonb; v_id uuid;
begin
  p := jsonb_build_object('dedupe_key', 'https://example.com/a-linkout-story', 'kind', 'link_out',
    'headline', 'Fed holds rates steady as inflation cools', 'body', null, 'category', 'markets', 'event_type', null,
    'ai_generated', false, 'tickers', '[]'::jsonb, 'macro', '[]'::jsonb,
    'as_of', now() - interval '13 hours', 'sort_at', now() - interval '13 hours', 'attribution', 'via NewsData.io',
    'sources', jsonb_build_array(jsonb_build_object('name', 'Example Times', 'kind', 'news', 'doc_label', null,
      'url', 'https://example.com/a-linkout-story', 'published_at', now() - interval '13 hours',
      'license_class', 'link_out', 'attribution', 'via NewsData.io', 'is_primary', true)));

  -- flag off (the default): refused
  update core.app_config set linkout_cards = false where id;
  begin perform api.publish_blurb(p); raise exception 'FAIL: link_out published while linkout_cards is false';
  exception when others then if sqlerrm not like '%link_out cards are disabled%' then raise; end if; end;

  -- flag on: published, delayed 12 h, no body, source and credit kept
  update core.app_config set linkout_cards = true where id;
  r := api.publish_blurb(p);
  if r ->> 'status' <> 'published' then raise exception 'FAIL: link_out not published: %', r; end if;
  v_id := (r ->> 'id')::uuid;
  if (select delayed_hours from core.blurbs where id = v_id) is distinct from 12 then raise exception 'FAIL: delayed_hours is not 12'; end if;
  if (select body from core.blurbs where id = v_id) is not null then raise exception 'FAIL: link_out has a body'; end if;
  if (select attribution from core.blurbs where id = v_id) <> 'via NewsData.io' then raise exception 'FAIL: credit missing'; end if;
  if not exists (select 1 from core.blurb_sources where blurb_id = v_id and license_class = 'link_out' and url = 'https://example.com/a-linkout-story') then
    raise exception 'FAIL: publisher source missing';
  end if;

  -- a summary card keeps its null delay
  update core.app_config set linkout_cards = false where id;
  r := api.publish_blurb(p || jsonb_build_object('dedupe_key', 'https://example.com/summary', 'kind', 'summary', 'body', 'Short text.',
    'sources', jsonb_build_array(jsonb_build_object('name', 'SEC', 'kind', 'filing', 'doc_label', 'Form 8-K',
      'url', 'https://www.sec.gov/x', 'published_at', now(), 'license_class', 'company_filing', 'attribution', null, 'is_primary', true))));
  if (select delayed_hours from core.blurbs where id = (r ->> 'id')::uuid) is not null then raise exception 'FAIL: summary got a delay'; end if;

  -- run_log accepts the new names
  perform api.log_run('{"source":"newsdata_market"}');
  perform api.log_run('{"source":"newsdata_latest"}');

  raise exception 'ALL LINKOUT CHECKS PASSED';
end $$;
