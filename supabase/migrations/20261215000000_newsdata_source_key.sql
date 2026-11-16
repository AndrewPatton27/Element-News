-- NewsData.io is a switchable source that is OFF by default.
-- 'newsdata'    : maps link-out cards (source name "NewsData.io") so a reader can hide them.
-- 'newsdata_on' : opt-in marker. A reader who switches NewsData.io on stores it in
--                 hidden_sources; the app treats "newsdata" as hidden unless it is present.
--                 It matches no card; it exists so api.set_prefs accepts it (unknown_source).
insert into core.source_keys (key, name, match_names, sort_order) values
  ('newsdata',    'NewsData.io headlines',        '{"NewsData.io"}', 10),
  ('newsdata_on', 'NewsData.io headlines (opt-in)', '{}',             11)
on conflict (key) do update
  set name = excluded.name, match_names = excluded.match_names, sort_order = excluded.sort_order;
