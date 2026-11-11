-- Checks for 20261142000000_release_queue.sql (publication smoother). Rolls back at the final error.
do $$
declare
  v_p jsonb; r jsonb; a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; n int;
  v_h int := extract(hour from now() at time zone 'America/New_York')::int;
  v_later timestamptz := now() + interval '20 minutes';
begin
  -- test window: all day, every day (the real window is 06-20 ET weekdays)
  update core.drip_config set enabled = true, window_start_hour_et = 0, window_end_hour_et = 24, weekdays_only = false where id;
  update core.app_config set linkout_cards = true where id;

  -- helper payload
  v_p := jsonb_build_object('kind', 'summary', 'headline', 'x', 'body', 'Short text.', 'category', 'markets', 'event_type', null,
    'ai_generated', false, 'tickers', '[]'::jsonb, 'macro', '[]'::jsonb, 'as_of', now(), 'sort_at', now(), 'attribution', null,
    'sources', jsonb_build_array(jsonb_build_object('name', 'SEC', 'kind', 'filing', 'doc_label', 'Form 8-K',
      'url', 'https://www.sec.gov/x', 'published_at', now(), 'license_class', 'company_filing', 'attribution', null, 'is_primary', true)));

  -- 1. quiet feed: first card goes live at once; the next one inside 15 minutes is held
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/a","headline":"Card A goes live"}'::jsonb);
  a := (r ->> 'id')::uuid;
  if (select status from core.blurbs where id = a) <> 'published' then raise exception 'FAIL: first card not published'; end if;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/b","headline":"Card B is held"}'::jsonb);
  b := (r ->> 'id')::uuid;
  if (select status from core.blurbs where id = b) <> 'queued' then raise exception 'FAIL: second card not queued'; end if;
  if (select queued_at from core.blurbs where id = b) is null then raise exception 'FAIL: queued_at empty'; end if;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/c","headline":"Card C is held too"}'::jsonb);
  c := (r ->> 'id')::uuid;
  update core.blurbs set importance = 9 where id = c;      -- C is more important than B

  -- 2. never held: data card, fed event, AI relevance 5, old (history) card
  r := api.publish_blurb(v_p || '{"dedupe_key":"CPIAUCSL:2026-10-01","kind":"data","headline":"CPI data card","body":null}'::jsonb);
  if (select status from core.blurbs where id = (r ->> 'id')::uuid) <> 'published' then raise exception 'FAIL: data card held'; end if;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.federalreserve.gov/p1","event_type":"fed","headline":"Fed statement"}'::jsonb);
  if (select status from core.blurbs where id = (r ->> 'id')::uuid) <> 'published' then raise exception 'FAIL: fed card held'; end if;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/ai5","ai_generated":true,"everyday_relevance":5,"headline":"Very relevant AI card"}'::jsonb);
  if (select status from core.blurbs where id = (r ->> 'id')::uuid) <> 'published' then raise exception 'FAIL: relevance-5 card held'; end if;
  r := api.publish_blurb(v_p || jsonb_build_object('dedupe_key', 'https://www.sec.gov/old', 'headline', 'Old backfill card', 'sort_at', now() - interval '3 days', 'as_of', now() - interval '3 days'));
  if (select status from core.blurbs where id = (r ->> 'id')::uuid) <> 'published' then raise exception 'FAIL: old card held'; end if;

  -- 3. held cards are invisible to the feed and visible to the duplicate check
  if exists (select 1 from jsonb_array_elements(api.feed('latest', null, 100, null) -> 'items') i where i ->> 'headline' in ('Card B is held', 'Card C is held too')) then
    raise exception 'FAIL: a queued card is in the feed';
  end if;
  if not (api.recent_headlines(100) ? 'Card B is held') then raise exception 'FAIL: recent_headlines misses a queued card'; end if;

  -- 4. release inside the window: nothing while a card went live a minute ago; later exactly one, the most important
  if core.release_queued_cards(now()) <> 0 then raise exception 'FAIL: released while the last card is under 14 min old'; end if;
  if core.release_queued_cards(v_later) <> 1 then raise exception 'FAIL: expected exactly one release'; end if;
  if (select status from core.blurbs where id = c) <> 'published' or (select status from core.blurbs where id = b) <> 'queued' then
    raise exception 'FAIL: the more important card should go first';
  end if;
  if (select published_at from core.blurbs where id = c) <> v_later then raise exception 'FAIL: published_at is not the release time'; end if;
  if (select sort_at from core.blurbs where id = c) <> v_later then raise exception 'FAIL: sort_at not moved to the release time'; end if;
  if core.release_queued_cards(v_later + interval '1 minute') <> 0 then raise exception 'FAIL: second release in the same slot'; end if;
  if core.release_queued_cards(v_later + interval '15 minutes') <> 1 then raise exception 'FAIL: next slot should release B'; end if;

  -- 5. a link_out card keeps its source time on release (it sinks, rule 7)
  r := api.publish_blurb(v_p || jsonb_build_object('dedupe_key', 'https://example.com/lo1', 'kind', 'link_out', 'headline', 'Fed holds rates, link out one', 'body', null,
        'attribution', 'via NewsData.io', 'sort_at', now() - interval '13 hours', 'as_of', now() - interval '13 hours',
        'sources', jsonb_build_array(jsonb_build_object('name', 'Example Times', 'kind', 'news', 'doc_label', null, 'url', 'https://example.com/lo1',
          'published_at', now() - interval '13 hours', 'license_class', 'link_out', 'attribution', 'via NewsData.io', 'is_primary', true))));
  d := (r ->> 'id')::uuid;
  if (select status from core.blurbs where id = d) <> 'queued' then raise exception 'FAIL: link_out card not queued (a card went live under 15 min ago)'; end if;
  perform core.release_queued_cards(v_later + interval '40 minutes');
  if (select status from core.blurbs where id = d) <> 'published' then raise exception 'FAIL: link_out not released'; end if;
  if (select sort_at from core.blurbs where id = d) > now() - interval '12 hours' then raise exception 'FAIL: link_out sort_at was moved'; end if;
  if (select delayed_hours from core.blurbs where id = d) is distinct from 12 then raise exception 'FAIL: link_out lost its 12 h delay'; end if;

  -- 6. outside the window everything is flushed
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/q1","headline":"Queued one"}'::jsonb);
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/q2","headline":"Queued two"}'::jsonb);
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/q3","headline":"Queued three"}'::jsonb);
  select count(*) into n from core.blurbs where status = 'queued';
  if n < 2 then raise exception 'FAIL: expected queued cards, got %', n; end if;
  update core.drip_config set window_start_hour_et = (v_h + 12) % 24, window_end_hour_et = (v_h + 12) % 24 + 1 where id;
  if core.release_queued_cards(now()) <> n then raise exception 'FAIL: off-window flush did not release all % queued cards', n; end if;
  if exists (select 1 from core.blurbs where status = 'queued') then raise exception 'FAIL: queue not empty after flush'; end if;

  -- 7. expiry: a card queued for more than 8 hours is hidden, not released
  update core.drip_config set window_start_hour_et = 0, window_end_hour_et = 24 where id;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/stale","headline":"Stale queued card"}'::jsonb);
  e := (r ->> 'id')::uuid;
  update core.blurbs set status = 'queued', queued_at = now() - interval '9 hours' where id = e;
  perform core.release_queued_cards(now() + interval '1 hour');
  if (select status from core.blurbs where id = e) <> 'hidden' then raise exception 'FAIL: stale queued card not hidden'; end if;

  -- 8. switched off: publishes at once; a leftover queue is released by the cron run
  update core.drip_config set enabled = false where id;
  r := api.publish_blurb(v_p || '{"dedupe_key":"https://www.sec.gov/off1","headline":"No drip card"}'::jsonb);
  f := (r ->> 'id')::uuid;
  if (select status from core.blurbs where id = f) <> 'published' then raise exception 'FAIL: drip off but card held'; end if;
  update core.blurbs set status = 'queued', queued_at = now() where id = f;
  if core.release_queued_cards(now()) <> 1 then raise exception 'FAIL: drip off should flush the queue'; end if;

  -- 9. privacy: the config and the functions are not open to readers
  if has_table_privilege('anon', 'core.drip_config', 'select') then raise exception 'FAIL: anon can read drip_config'; end if;
  if has_function_privilege('anon', 'core.release_queued_cards(timestamptz)', 'execute') then raise exception 'FAIL: anon can run the release'; end if;
  if has_function_privilege('anon', 'api.recent_headlines(int)', 'execute') then raise exception 'FAIL: anon can read recent_headlines'; end if;

  raise exception 'ALL RELEASE QUEUE CHECKS PASSED';
end $$;
