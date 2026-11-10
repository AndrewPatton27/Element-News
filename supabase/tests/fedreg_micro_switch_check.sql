-- Non-economic Federal Register cap (20261120000200_fedreg_micro_switch.sql), ships OFF.
-- Checks: the switch exists at 0 with a range guard; off = guest Trending and Latest pages are exactly what they
-- were (FAA cards bunch up as before); on = at most 1 micro card (recall, science or non-economic Federal Register
-- card) in any 10 in a row on Trending, Latest and For you while other cards are left, an economic Federal
-- Register card (IRS) is not capped, every card still appears once over a full scroll (soft cap: nothing hidden),
-- and the Policy chip is unchanged. Test rows are rolled back on purpose (the closing error).
do $$
declare
  base numeric := round((extract(epoch from now())/3600)::numeric,6);
  ua uuid; off_top jsonb; off_lat jsonb; r jsonb; ids text[]; cur text; i int; m text; n int; w int; mx int; total int;
  micro boolean[]; v_mode text;
begin
  select id into ua from auth.users where email = 'element-test-a@example.com';
  update core.blurbs set status = 'hidden' where status = 'published';

  if (select value from core.rank_params where key = 'fedreg_noneconomic_micro') is distinct from 0 then
    raise exception 'FAIL: fedreg_noneconomic_micro must ship at 0'; end if;
  begin
    update core.rank_params set value = 2 where key = 'fedreg_noneconomic_micro';
    raise exception 'FAIL: value 2 must be refused';
  exception when check_violation then null; end;

  -- 12 FAA rules (fresh, so they lead), 2 IRS rules (economic), 26 macro cards (older)
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,attribution,as_of,published_at,sort_at,importance,rank_score)
  select 'fr-faa'||g,'summary','FAA orders fixes for some Boeing 737 planes '||g,'Airlines must inspect parts.','policy','rule','published',
    'Source: Federal Register (National Archives), Federal Aviation Administration',now(),now(),now()-(g||' minutes')::interval,2.5,base+20-g*0.01
  from generate_series(1,12) g;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,attribution,as_of,published_at,sort_at,importance,rank_score)
  select 'fr-irs'||g,'summary','IRS finalises rules for paying taxes by card '||g,'Taxpayers can pay by card.','policy','rule','published',
    'Source: Federal Register (National Archives), Internal Revenue Service',now(),now(),now()-(g||' minutes')::interval,2.5,base+19.9-g*0.01
  from generate_series(1,2) g;
  insert into core.blurbs(dedupe_key,kind,headline,body,category,event_type,status,as_of,published_at,sort_at,importance,rank_score)
  select 'fr-mac'||g,'data','Macro number '||g||' rises','A data release.',(array['economy','markets','earnings','deals'])[1+g%4],'data'||(g%4),'published',
    now(),now(),now()-(g||' hours')::interval,6,base+10-g*0.1
  from generate_series(1,26) g;
  insert into core.blurb_sources(blurb_id,name,kind,url,license_class,is_primary,attribution)
  select id,case when dedupe_key like 'fr-mac%' then 'Bureau of Labor Statistics' else 'Federal Register' end,'government',
         'https://www.federalregister.gov/'||dedupe_key,'public_domain',true,attribution
    from core.blurbs where dedupe_key like 'fr-%';

  -- off: pages unchanged by this migration (micro_cap_pick sees no micro card), FAA cards bunch at the top
  off_top := api.feed('top', null, 20, null);
  off_lat := api.feed('latest', null, 20, null);
  select count(*) into n from jsonb_array_elements(off_top->'items') with ordinality x(c,o) where o <= 10 and c->>'headline' like 'FAA%';
  if n < 2 then raise exception 'FAIL: setup: with the switch off FAA cards should bunch in the first 10 (got %)', n; end if;

  update core.rank_params set value = 1 where key = 'fedreg_noneconomic_micro';
  foreach v_mode in array array['top','latest','foryou'] loop
    ids := '{}'; cur := null; i := 0;
    loop
      if v_mode = 'foryou' then
        perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
        r := api.feed_for_you(cur, 10);
        perform set_config('request.jwt.claims', '', true);
      else
        r := api.feed(v_mode, cur, 10, null);
      end if;
      ids := ids || array(select x->>'id' from jsonb_array_elements(r->'items') x);
      cur := r->>'next_cursor'; i := i + 1;
      exit when cur is null or i > 20;
    end loop;
    total := cardinality(ids);
    if total <> 40 or (select count(distinct x) from unnest(ids) x) <> 40 then
      raise exception 'FAIL: % with the switch on must list all 40 cards once (got %)', v_mode, total; end if;
    micro := array(select coalesce(b.headline like 'FAA%', false) from unnest(ids) with ordinality u(id,o) join core.blurbs b on b.id = u.id::uuid order by u.o);
    -- while macro cards are left (the first 26 + 2 IRS + ~3 FAA), no window of 10 holds 2 FAA cards
    mx := 0;
    for w in 1 .. 21 loop
      mx := greatest(mx, (select count(*) from generate_series(w, w + 9) j where micro[j]));
    end loop;
    if mx > 1 then raise exception 'FAIL: % with the switch on: % FAA cards in some 10 of the first 30', v_mode, mx; end if;
    -- (For you orders by its own score, so only the guest lists are checked for where the IRS cards land)
    if v_mode <> 'foryou' and not exists (select 1 from unnest(ids[1:10]) x join core.blurbs b on b.id = x::uuid where b.headline like 'IRS%') then
      raise exception 'FAIL: % economic Federal Register cards must not be capped', v_mode; end if;
  end loop;

  -- Policy chip: the page cap is applied to topic pages too in macro_focus; FAA cards must all still be listed
  select count(*) into n from jsonb_array_elements(api.feed('top', null, 30, 'policy')->'items');
  if n <> 14 then raise exception 'FAIL: the Policy chip must list all 14 policy cards (got %)', n; end if;

  -- off again: identical to before
  update core.rank_params set value = 0 where key = 'fedreg_noneconomic_micro';
  if api.feed('top', null, 20, null)->'items' is distinct from off_top->'items'
     or api.feed('latest', null, 20, null)->'items' is distinct from off_lat->'items' then
    raise exception 'FAIL: switch off must give exactly the old pages'; end if;
  raise exception 'ALL FEDREG MICRO SWITCH CHECKS PASSED (test rows rolled back on purpose)';
end $$;
