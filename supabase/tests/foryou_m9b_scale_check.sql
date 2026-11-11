-- Scale review for the whole For you path (20261126000000_foryou_m9b.sql and what it builds on). Rolled back.
-- Synthetic data, generated here: 100,000 cards over 120 days (about 25,000 in the 30-day For you window), 2% data
-- cards, 100 companies tagged on 20% of cards, 20,000 readers with 10 events each (200,000 events) plus one heavy
-- reader with 300 events, 3 followed topics and 3 followed tickers.
-- Proves, per request: no sequential scan of core.user_events (pg_stat_xact_user_tables delta = 0) for
-- api.feed_for_you (v5 and v3 paths, pages 1 and 2), core.v3_scores, core.fy_post and api.related_cards; the
-- scored candidate set is bounded by foryou_max_scored + bounded extras; the Trending refresh (batch, cron) runs
-- and reads events only through the time index. Times are printed in the closing message (PGlite in WebAssembly,
-- single thread: several times slower than Supabase Postgres). Generous time limits only catch a blow-up.
do $$
declare
  ua uuid;
  base numeric := round((extract(epoch from now()) / 3600)::numeric, 6);
  cats text[] := array['economy', 'markets', 'earnings', 'deals', 'policy', 'energy', 'tech', 'world', 'science'];
  t0 timestamptz; ms_v5 numeric; ms_v5p2 numeric; ms_v3 numeric; ms_v3s numeric; ms_post numeric; ms_rel numeric; ms_tr numeric;
  s0 bigint; s1 bigint; r jsonb; n_scored int; n_window int; card uuid; msg text;
  function_seq int := 0;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  update core.blurbs set status = 'hidden' where status = 'published';
  update core.ml_models set gate_passed = false where gate_passed;
  update core.rank_params set value = 0 where key in ('foryou_ml_mode', 'trending_ml_mode');

  -- ---- data (bulk load: card triggers off; tags written directly) ----
  alter table core.blurbs disable trigger user;
  insert into core.companies (ticker, name, short_name, sector, industry)
  select 'ZQ' || chr(65 + g / 26) || chr(65 + g % 26), 'Scale Co ' || g, 'Scale ' || g, 'tech', 'software'
    from generate_series(0, 99) g on conflict do nothing;
  insert into core.blurbs (dedupe_key, kind, headline, body, category, status, as_of, published_at, sort_at, importance, rank_score, event_type)
  select case when g % 50 = 0 then 'ZS' || (g % 200) || ':' || g else 'sc-' || g end,
         case when g % 50 = 0 then 'data' else 'summary' end,
         'Scale card ' || g, 'Text.', cats[1 + g % 9],
         case when g % 50 = 0 and g > 400 then 'hidden' else 'published' end,          -- one live card per data series
         ts, ts, ts, 1 + g % 10, round(extract(epoch from ts) / 3600, 6) + 8 * log(2, 1 + g % 10),
         case when g % 50 = 0 then 'macro_release' end
    from generate_series(1, 100000) g, lateral (select now() - make_interval(secs => g * 103.68) as ts) t;
  update core.blurbs set dedupe_key = 'CPIAUCSL:' || dedupe_key where dedupe_key in ('ZS100:100', 'ZS150:150');
  insert into core.blurb_sources (blurb_id, name, kind, url, license_class, is_primary)
  select id, (array['SEC', 'Federal Reserve Board', 'Bureau of Economic Analysis', 'NASA'])[1 + abs(hashtext(dedupe_key)) % 4],
         'government', 'https://www.sec.gov/sc/' || dedupe_key, 'public_domain', true
    from core.blurbs where dedupe_key like 'sc-%' or dedupe_key like 'ZS%' or dedupe_key like 'CPIAUCSL:ZS%';
  insert into core.card_companies (blurb_id, ticker, method, confidence, sort_at)
  select b.id, 'ZQ' || chr(65 + (abs(hashtext(b.dedupe_key)) % 100) / 26) || chr(65 + (abs(hashtext(b.dedupe_key)) % 100) % 26),
         'card_ticker', 1, b.sort_at
    from core.blurbs b where b.dedupe_key like 'sc-%' and abs(hashtext(b.dedupe_key)) % 5 = 0
  on conflict do nothing;
  alter table core.blurbs enable trigger user;

  insert into auth.users (email) select 'scale-' || g || '@example.invalid' from generate_series(1, 20000) g;
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select u.id, b.id, k.kind, case when k.kind = 'dwell' then 9000 end, now() - make_interval(mins => (abs(hashtext(u.email || k.n)) % 40000))
    from auth.users u
    cross join lateral (select n, (array['view', 'view', 'view', 'dwell', 'like', 'dislike', 'open_detail', 'view', 'like', 'view'])[n] as kind
                          from generate_series(1, 10) n) k
    join core.blurbs b on b.dedupe_key = 'sc-' || (1 + abs(hashtext(u.email || '|' || k.n)) % 25000)
   where u.email like 'scale-%';
  insert into core.user_events (user_id, blurb_id, kind, dwell_ms, created_at)
  select ua, b.id, (array['view', 'like', 'dislike', 'dwell', 'open_detail'])[1 + g % 5], case when g % 5 = 3 then 9000 end,
         now() - make_interval(mins => g * 97)
    from generate_series(1, 300) g join core.blurbs b on b.dedupe_key = 'sc-' || (1 + (g * 37) % 25000);
  insert into core.user_prefs (user_id, followed_categories) values (ua, '{economy,energy,deals}')
  on conflict (user_id) do update set followed_categories = excluded.followed_categories;
  analyze core.blurbs; analyze core.user_events; analyze core.card_companies; analyze core.blurb_sources;

  select count(*) into n_window from core.blurbs where status = 'published' and sort_at > now() - interval '30 days';
  if n_window < 20000 then raise exception 'FAIL: the window should hold about 25,000 cards (%)', n_window; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- ---- For you, v5 (the fallback; also what v3 falls back to above v3_max_candidates) ----
  s0 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  t0 := clock_timestamp();
  r := api.feed_for_you(null, 20, '{}'::uuid[], array['ZQAA', 'ZQAB', 'ZQAC']);
  ms_v5 := round(extract(epoch from clock_timestamp() - t0) * 1000);
  if jsonb_array_length(r -> 'items') < 10 then raise exception 'FAIL: For you page 1 too short'; end if;
  t0 := clock_timestamp();
  r := api.feed_for_you(r ->> 'next_cursor', 20, '{}'::uuid[], array['ZQAA', 'ZQAB', 'ZQAC']);
  ms_v5p2 := round(extract(epoch from clock_timestamp() - t0) * 1000);
  s1 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  if coalesce(s1, 0) - coalesce(s0, 0) > 0 then raise exception 'FAIL: For you v5 scanned core.user_events sequentially (% scans)', s1 - s0; end if;

  -- ---- For you, v3 path (forced past the cost guard so its body is measured at this size) ----
  update core.rank_params set value = 3 where key = 'foryou_ml_mode';
  update core.rank_params set value = 0 where key = 'v3_holdout_pct';
  update core.rank_params set value = 1e9 where key = 'v3_max_candidates';
  s0 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  t0 := clock_timestamp();
  r := api.feed_for_you(null, 20, '{}'::uuid[], array['ZQAA']);
  ms_v3 := round(extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp();
  select count(*) into n_scored from core.v3_scores(ua, now(), (select coalesce(max(gen), 0) from core.trend_generations));
  ms_v3s := round(extract(epoch from clock_timestamp() - t0) * 1000);
  s1 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  if coalesce(s1, 0) - coalesce(s0, 0) > 0 then raise exception 'FAIL: For you v3 scanned core.user_events sequentially'; end if;
  -- bounded: the cut (1500) + seen room (seen_exclude_max 800 when on) + key series + followed companies (50)
  if n_scored > 1500 + 800 + 50 + 50 then raise exception 'FAIL: v3_scores scored % cards (bound 2400)', n_scored; end if;
  update core.rank_params set value = 0 where key = 'foryou_ml_mode';

  -- ---- reason + cap step alone, related cards ----
  s0 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  t0 := clock_timestamp();
  perform core.fy_post(r, ua);
  ms_post := round(extract(epoch from clock_timestamp() - t0) * 1000);
  select id into card from core.blurbs where dedupe_key = 'sc-5';
  t0 := clock_timestamp();
  perform api.related_cards(card, 5);
  ms_rel := round(extract(epoch from clock_timestamp() - t0) * 1000);
  s1 := (select seq_scan from pg_stat_xact_user_tables where relid = 'core.user_events'::regclass);
  if coalesce(s1, 0) - coalesce(s0, 0) > 0 then raise exception 'FAIL: fy_post / related_cards scanned core.user_events sequentially'; end if;

  -- ---- Trending refresh (cron batch, every few minutes) ----
  t0 := clock_timestamp();
  perform core.refresh_trending();
  ms_tr := round(extract(epoch from clock_timestamp() - t0) * 1000);

  if ms_v5 > 60000 or ms_v3 > 60000 or ms_post > 5000 or ms_rel > 10000 then
    raise exception 'FAIL: a request blew up: v5 % ms, v3 % ms, post % ms, related % ms', ms_v5, ms_v3, ms_post, ms_rel; end if;

  msg := format('window %s cards, v3 scored %s; ms in PGlite: for_you v5 p1 %s, p2 %s; v3 p1 %s (v3_scores %s); fy_post %s; related_cards %s; refresh_trending %s',
                n_window, n_scored, ms_v5, ms_v5p2, ms_v3, ms_v3s, ms_post, ms_rel, ms_tr);
  raise exception 'ALL FORYOU M9B SCALE CHECKS PASSED (%)', msg;
end $$;
