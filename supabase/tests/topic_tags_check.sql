-- Checks for 20261135000100_topic_tags.sql. All rows roll back at the deliberate final error.
do $$
begin
  if core.topic_tags_of('Mortgage rates fall as the Fed holds', 'Housing starts rose.', 'economy') <> array['rates','housing'] then
    raise exception 'FAIL rates+housing: %', core.topic_tags_of('Mortgage rates fall as the Fed holds', 'Housing starts rose.', 'economy'); end if;
  if core.topic_tags_of('Jobs report: payrolls grow, unemployment steady', null, 'economy') <> array['labor'] then raise exception 'FAIL labor'; end if;
  if core.topic_tags_of('Tariffs lift the trade deficit', null, 'economy') <> array['trade'] then raise exception 'FAIL trade'; end if;
  if not ('retirement' = any (core.topic_tags_of('Retiree 401(k) and Social Security changes', null, 'personal-finance'))) then raise exception 'FAIL retirement'; end if;
  if core.topic_tags_of('Recall: bank branded wages cereal', null, 'safety') <> '{}'::text[] then raise exception 'FAIL recall must carry no macro topic'; end if;
  if core.topic_tags_of('SEC charges a crypto exchange', 'The SEC filed a complaint about Bitcoin.', 'policy') <> array['crypto'] then raise exception 'FAIL crypto'; end if;
  if not ('tech-ai' = any (core.topic_tags_of('Nvidia AI chips demand', null, 'tech'))) then raise exception 'FAIL tech-ai'; end if;
  if core.topic_tags_of('The said sky', null, 'tech') <> '{}'::text[] then raise exception 'FAIL: lowercase "said" must not tag AI'; end if;
  if core.topic_tags_of('Plain earnings beat', 'Revenue rose.', 'earnings') <> '{}'::text[] then raise exception 'FAIL plain card must have no tags'; end if;
  if core.topic_tags_of(null, null, null) <> '{}'::text[] then raise exception 'FAIL nulls'; end if;
  if has_function_privilege('anon', 'core.topic_tags_of(text,text,text)', 'execute') then raise exception 'FAIL anon must not run it'; end if;
  if has_function_privilege('authenticated', 'core.topic_tags_of(text,text,text)', 'execute') then raise exception 'FAIL authenticated must not run it'; end if;
  if not has_function_privilege('service_role', 'core.topic_tags_of(text,text,text)', 'execute') then raise exception 'FAIL service_role must run it'; end if;
  if not (select proconfig @> array['search_path=""'] from pg_proc where oid = 'core.topic_tags_of(text,text,text)'::regprocedure) then raise exception 'FAIL search_path must be empty'; end if;
  raise exception 'ALL TOPIC_TAGS CHECKS PASSED';
end $$;
