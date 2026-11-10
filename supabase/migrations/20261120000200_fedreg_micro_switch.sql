-- Optional cap for non-economic Federal Register cards (FAA aircraft rules, FCC robocall rules ...): with the
-- switch on they count as micro cards, so together with recalls and science at most micro_max_per_10 (1) of them
-- appear in any 10 cards in a row of Trending, Latest and For you. Open item (Dec 11):
-- Drew has not decided, so it SHIPS OFF: core.rank_params 'fedreg_noneconomic_micro' = 0 changes nothing.
-- Must run after 20261116000000_macro_focus.sql. Idempotent. NOT applied.
--
-- Why: on the live project (2026-11-09, anonymous read-only calls) the guest Trending top 50 was 78% macro/finance
-- (target >= 85%, CLAUDE.md standing content rule): 5 science cards (already capped at 1 in 10) and 6 non-economic
-- Federal Register cards (FAA orders for Boeing / Airbus parts, an FCC robocall rule), up to 3 in 10 in a row.
-- With the switch on, the shared cap allows at most 5 such cards in the top 50 (>= 90% macro if the rest is macro).
--
-- "Non-economic Federal Register card" = a card with a source named 'Federal Register' for which
-- core.fedreg_economic(headline, attribution) is false: the same definition api.macro_share() measures with.
-- Only core.micro_cap_pick (the page cap every feed wrapper applies last) is redefined; core.diversify, the gate,
-- topic chips, company pages, search and Following are unchanged. Nothing is hidden: capped cards move down.
-- Turn on:  update core.rank_params set value = 1 where key = 'fedreg_noneconomic_micro';
-- Checked by tests/fedreg_micro_switch_check.sql.

insert into core.rank_params (key, value) values
  ('fedreg_noneconomic_micro', 0)   -- 1: non-economic Federal Register cards share the micro page cap; 0: off (ships off)
on conflict (key) do nothing;

alter table core.rank_params drop constraint if exists rank_params_fedreg_micro_range;
alter table core.rank_params add constraint rank_params_fedreg_micro_range
  check (key <> 'fedreg_noneconomic_micro' or value in (0, 1));

-- One card (core.cards_json shape): a Federal Register card that is not economic.
create or replace function core.fedreg_noneconomic_json(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (select 1 from jsonb_array_elements(coalesce(p -> 'sources', '[]')) s where s ->> 'name' = 'Federal Register')
     and not core.fedreg_economic(p ->> 'headline',
                                  coalesce(nullif(p ->> 'attribution', ''),
                                           (select string_agg(s ->> 'attribution', ' ') from jsonb_array_elements(coalesce(p -> 'sources', '[]')) s)));
$$;
revoke all on function core.fedreg_noneconomic_json(jsonb) from public, anon, authenticated;

-- Same contract as 20261116000000 (arguments, return shape, soft cap); a card is micro when its topic is a micro
-- topic, or (switch on) it is a non-economic Federal Register card.
create or replace function core.micro_cap_pick(p_cards jsonb, p_mh text, p_take int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mcap  int;
  v_mcats text[];
  v_fr    boolean;
  v_mh    text := right(regexp_replace(coalesce(p_mh, ''), '[^01]', '', 'g'), 9);
  v_n     int := coalesce(jsonb_array_length(p_cards), 0);
  v_micro boolean[];
  v_used  boolean[];
  v_out   int[] := '{}';
  v_pick  int;
  v_full  boolean;
  v_soft  boolean := false;
begin
  select max(value)::int into v_mcap from core.rank_params where key = 'micro_max_per_10';
  v_mcats := array(select substr(key, 16) from core.rank_params where starts_with(key, 'micro_category:') and value > 0);
  v_fr := coalesce((select value = 1 from core.rank_params where key = 'fedreg_noneconomic_micro'), false);
  v_micro := array(select coalesce(c ->> 'category' = any (v_mcats), false) or (v_fr and core.fedreg_noneconomic_json(c))
                     from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) with ordinality as x(c, o) order by o);
  v_used  := array_fill(false, array[greatest(v_n, 1)]);
  for slot in 1 .. least(v_n, greatest(coalesce(p_take, v_n), 0)) loop
    v_full := v_mcap is not null and length(replace(v_mh, '0', '')) >= v_mcap;
    v_pick := null;
    for j in 1 .. v_n loop
      if not v_used[j] and not (v_full and v_micro[j]) then v_pick := j; exit; end if;
    end loop;
    if v_pick is null then                                                -- soft: only micro cards left
      v_soft := true;
      for j in 1 .. v_n loop
        if not v_used[j] then v_pick := j; exit; end if;
      end loop;
    end if;
    v_used[v_pick] := true;
    v_out := v_out || v_pick;
    v_mh  := right(v_mh || case when v_micro[v_pick] then '1' else '0' end, 9);
  end loop;
  return jsonb_build_object('picked', to_jsonb(v_out),
                            'left', to_jsonb(coalesce(array(select j from generate_series(1, v_n) j where not v_used[j] order by j), '{}')),
                            'mh', v_mh, 'soft', v_soft);
end;
$$;
revoke all on function core.micro_cap_pick(jsonb, text, int) from public, anon, authenticated;
