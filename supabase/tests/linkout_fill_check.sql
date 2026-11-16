-- Checks for 20261202000000_linkout_fill.sql: api.link_out_without_summary lists published and queued link_out cards with no body;
-- api.revise_blurb fills one in (body + detail + AI label, headline kept) or hides it, also while it waits in the queue; other kinds in
-- the queue stay untouched. Rolls back at the final error.
do $$
declare
  p jsonb; r jsonb; v_a uuid; v_b uuid; v_c uuid; v_n int;
begin
  update core.app_config set linkout_cards = true where id;
  p := jsonb_build_object('kind', 'link_out', 'headline', 'Fed holds rates steady as inflation cools', 'body', null,
    'category', 'markets', 'event_type', null, 'ai_generated', false, 'tickers', '[]'::jsonb, 'macro', '[]'::jsonb,
    'as_of', now() - interval '13 hours', 'sort_at', now() - interval '13 hours', 'attribution', 'via NewsData.io');
  v_a := (api.publish_blurb(p || jsonb_build_object('dedupe_key', 'https://example.com/fill-a', 'sources', jsonb_build_array(jsonb_build_object(
    'name', 'Example Times', 'kind', 'news', 'doc_label', null, 'url', 'https://example.com/fill-a', 'published_at', now() - interval '13 hours',
    'license_class', 'link_out', 'attribution', 'via NewsData.io', 'is_primary', true)))) ->> 'id')::uuid;
  v_b := (api.publish_blurb(p || jsonb_build_object('dedupe_key', 'https://example.com/fill-b', 'headline', 'Second story', 'sources', jsonb_build_array(jsonb_build_object(
    'name', 'Example Times', 'kind', 'news', 'doc_label', null, 'url', 'https://example.com/fill-b', 'published_at', now() - interval '13 hours',
    'license_class', 'link_out', 'attribution', 'via NewsData.io', 'is_primary', true)))) ->> 'id')::uuid;
  v_c := (api.publish_blurb(p || jsonb_build_object('dedupe_key', 'https://example.com/fill-c', 'kind', 'summary', 'body', 'A summary.', 'headline', 'Summary card',
    'sources', jsonb_build_array(jsonb_build_object('name', 'SEC', 'kind', 'filing', 'doc_label', 'Form 8-K', 'url', 'https://www.sec.gov/fill-c',
      'published_at', now(), 'license_class', 'company_filing', 'attribution', null, 'is_primary', true)))) ->> 'id')::uuid;

  -- B waits in the queue, C (a summary card) too
  update core.blurbs set status = 'queued' where id in (v_b, v_c);

  -- lister: A (published) and B (queued) are there, the summary card is not; each carries its publisher source
  r := api.link_out_without_summary(200);
  if not (r @> jsonb_build_array(jsonb_build_object('id', v_a)) or exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = v_a::text)) then raise exception 'FAIL: published link_out missing from the lister'; end if;
  if not exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = v_b::text) then raise exception 'FAIL: queued link_out missing from the lister'; end if;
  if exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = v_c::text) then raise exception 'FAIL: a summary card is in the lister'; end if;
  if (select e -> 'sources' -> 0 ->> 'url' from jsonb_array_elements(r) e where e ->> 'id' = v_a::text) <> 'https://example.com/fill-a' then raise exception 'FAIL: lister lost the publisher source'; end if;

  -- revise A (published): body, detail and AI label set, headline kept
  r := api.revise_blurb(jsonb_build_object('id', v_a, 'action', 'revise', 'headline', 'Fed holds rates steady as inflation cools',
    'body', 'The Fed left rates unchanged.', 'ai_generated', true, 'model', 'claude-haiku-5-5', 'prompt_version', 'sum-v7',
    'detail', jsonb_build_object('paragraphs', jsonb_build_array('One.', 'Two.'), 'key_points', jsonb_build_array('a', 'b', 'c')), 'everyday_relevance', 4));
  if r ->> 'status' <> 'revised' then raise exception 'FAIL: published link_out not revised: %', r; end if;
  if (select body from core.blurbs where id = v_a) is distinct from 'The Fed left rates unchanged.' then raise exception 'FAIL: body not set'; end if;
  if (select jsonb_array_length(detail -> 'key_points') from core.blurbs where id = v_a) <> 3 then raise exception 'FAIL: detail not set'; end if;
  if (select ai_label from core.blurbs where id = v_a) is null then raise exception 'FAIL: AI label missing'; end if;
  if exists (select 1 from jsonb_array_elements(api.link_out_without_summary(200)) e where e ->> 'id' = v_a::text) then raise exception 'FAIL: a filled card is still listed'; end if;

  -- revise B while queued works; hide a queued link_out works
  r := api.revise_blurb(jsonb_build_object('id', v_b, 'action', 'revise', 'headline', 'Second story', 'body', 'Text.', 'ai_generated', true, 'model', 'm', 'prompt_version', 'sum-v7'));
  if r ->> 'status' <> 'revised' then raise exception 'FAIL: queued link_out not revised: %', r; end if;
  update core.blurbs set body = null where id = v_b;
  r := api.revise_blurb(jsonb_build_object('id', v_b, 'action', 'hide', 'note', 'no_summary'));
  if r ->> 'status' <> 'hidden' then raise exception 'FAIL: queued link_out not hidden: %', r; end if;
  if (select status from core.blurbs where id = v_b) <> 'hidden' then raise exception 'FAIL: status not hidden'; end if;

  -- a queued summary card is not touched by revise or hide
  r := api.revise_blurb(jsonb_build_object('id', v_c, 'action', 'hide', 'note', 'x'));
  if r ->> 'status' <> 'not_found' then raise exception 'FAIL: queued summary card was hidden: %', r; end if;
  r := api.revise_blurb(jsonb_build_object('id', v_c, 'action', 'revise', 'headline', 'Changed'));
  if r ->> 'status' <> 'not_found' then raise exception 'FAIL: queued summary card was revised: %', r; end if;

  -- anon/authenticated cannot call the lister
  select count(*) into v_n from information_schema.routine_privileges
   where routine_schema = 'api' and routine_name = 'link_out_without_summary' and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_n <> 0 then raise exception 'FAIL: lister is callable by anon or authenticated'; end if;

  raise exception 'ALL LINKOUT FILL CHECKS PASSED';
end $$;
