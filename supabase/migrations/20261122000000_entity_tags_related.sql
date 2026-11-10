-- M9 WS5 (Following): related cards by entity only, and clean entity tags. NOT applied. Idempotent.
-- 1. api.related_cards: the category-only fallback is gone (it put other issuers under a Microsoft card). Linked
--    cards (core.story_links) come first as before; the rest must share an ENTITY with the queried card: a ticker
--    symbol (card tickers or a company tag with confidence >= 0.75) or a company with the same CIK (share classes).
-- 2. core.match_companies ignores number tokens with a decimal part and a unit suffix ("159.3M", "$92.3B"), so a
--    value is never read as the company "3M".
-- 3. Data cards (kind 'data') never carry tickers: a trigger empties them, and the cleanup below empties old ones.
-- 4. core.clean_card_tickers(): removes ticker entries from core.blurbs.tickers that have no whole-word match
--    (symbol, company name, short name or alias) in the card text; core.card_ticker_mismatches() lists them.
--    The migration runs the cleanup once and re-tags the cards whose text holds a decimal number with a suffix.
-- No new tunable: the 0.75 entity confidence equals the existing search_company_min_confidence default.

-- ---------- 2. match_companies: numeric suffixes are not names ----------
create or replace function core.match_companies(p_text text, p_tickers text[] default '{}', p_filing boolean default false)
returns table (ticker text, method text, confidence numeric)
language sql stable set search_path = '' as $$
  with f as (
    select t.x, t.x ~* core.company_biz_re() as biz, coalesce(p_tickers, '{}'::text[]) as tk
    from (select regexp_replace(translate(coalesce(p_text, ''), '’‘', ''''''), '[0-9]+([.,][0-9]+)+[A-Za-z]*', ' ', 'g') as x) t),
  m as (
    select c.ticker, case
      when c.ticker = any(f.tk) then case when coalesce(p_filing, false) then 'filing' else 'card_ticker' end
      when f.x ~ c.ticker_re then 'ticker_text'
      when c.bare_re is not null and f.x ~ c.bare_re then 'bare_ticker'
      when c.negative_re is not null and f.x ~* c.negative_re then null
      when c.strong_re is not null and f.x ~ c.strong_re then 'alias'
      when c.context_re is not null and regexp_replace(f.x, c.strip_re, '\1 ', 'g') ~ c.context_re then
        case when c.cue_re is not null and f.x ~ c.cue_re then 'context_cue' when f.biz then 'context_biz' end
    end as method
    from core.companies c cross join f
    where c.enabled)
  select m.ticker, m.method,
         (case m.method when 'filing' then 1.00 when 'card_ticker' then 0.95 when 'ticker_text' then 0.90
                        when 'bare_ticker' then 0.85 when 'alias' then 0.80 when 'context_cue' then 0.75 else 0.60 end)::numeric
  from m where m.method is not null
  order by 3 desc, m.ticker collate "C"
$$;

-- ---------- 3. no tickers on data cards ----------
create or replace function core.blurbs_data_no_tickers_trg()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind = 'data' then new.tickers := '[]'::jsonb; end if;
  return new;
end $$;
revoke all on function core.blurbs_data_no_tickers_trg() from public, anon, authenticated;
drop trigger if exists blurbs_data_no_tickers on core.blurbs;
create trigger blurbs_data_no_tickers before insert or update of kind, tickers on core.blurbs
  for each row execute function core.blurbs_data_no_tickers_trg();

-- ---------- 4. whole-word ticker check and cleanup ----------
-- One row per (card, ticker entry) whose symbol, company name, short name or alias does not occur as whole words
-- in the card's headline, body or detail text (numbers with a decimal and a suffix removed first).
create or replace function core.card_ticker_mismatches()
returns table (blurb_id uuid, symbol text)
language sql stable set search_path = '' as $$
  with t as (
    select b.id, upper(x->>'symbol') sym, lower(coalesce(x->>'name','')) jname,
      regexp_replace(concat_ws(' ', b.headline, b.body,
        (select string_agg(v #>> '{}', ' ') from jsonb_path_query(coalesce(b.detail,'{}'::jsonb), 'strict $.**') v where jsonb_typeof(v) = 'string')),
        '[0-9]+([.,][0-9]+)+[A-Za-z]*', ' ', 'g') txt
    from core.blurbs b cross join lateral jsonb_array_elements(b.tickers) x
    where coalesce(x->>'symbol','') <> ''
  )
  select t.id, t.sym from t
  where not (
    t.txt ~ ('(^|[^A-Za-z0-9])' || core.company_re_escape(t.sym) || '($|[^A-Za-z0-9])')
    or exists (
      select 1 from core.companies c
      cross join lateral unnest(array[c.name, c.short_name] || c.aliases) a(n)
      where c.ticker = t.sym and core.company_norm(a.n) <> ''
        and core.company_norm(t.txt) ~ ('(^| )' || core.company_re_escape(core.company_norm(regexp_replace(a.n, '[ ,.]+(inc|corp|corporation|co|company|ltd|plc|holdings|group)[. ]*$', '', 'i'))) || '( |$)'))
    or (btrim(regexp_replace(t.jname, '[ ,.]+(inc|corp|corporation|co|company|ltd|plc|holdings|group)[. ]*$', '')) <> ''
        and core.company_norm(t.txt) ~ ('(^| )' || core.company_re_escape(core.company_norm(regexp_replace(t.jname, '[ ,.]+(inc|corp|corporation|co|company|ltd|plc|holdings|group)[. ]*$', ''))) || '( |$)'))
  )
$$;
revoke all on function core.card_ticker_mismatches() from public, anon, authenticated;

-- Removes every mismatching ticker entry (and every ticker of a data card). Returns the number of cards changed.
create or replace function core.clean_card_tickers()
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; v_k int;
begin
  update core.blurbs set tickers = '[]'::jsonb where kind = 'data' and tickers <> '[]'::jsonb;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  with bad as (select m.blurb_id, array_agg(m.symbol) syms from core.card_ticker_mismatches() m group by m.blurb_id)
  update core.blurbs b set tickers = coalesce((
      select jsonb_agg(x) from jsonb_array_elements(b.tickers) x where not (upper(x->>'symbol') = any (bad.syms))), '[]'::jsonb)
  from bad where b.id = bad.blurb_id;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  return v_n;
end $$;
revoke all on function core.clean_card_tickers() from public, anon, authenticated;
grant execute on function core.clean_card_tickers() to service_role;

select core.clean_card_tickers();
-- re-tag cards whose text holds a decimal number with a suffix (the old tagger read "159.3M" as "3M")
do $$
declare v_id uuid;
begin
  for v_id in select b.id from core.blurbs b
               where concat_ws(' ', b.headline, b.body) ~ '[0-9]+([.,][0-9]+)+[A-Za-z]'
                  or exists (select 1 from core.card_companies cc where cc.blurb_id = b.id and cc.ticker = 'MMM') loop
    perform core.tag_card(v_id);
  end loop;
end $$;

-- ---------- 1. related_cards: same ticker or CIK only ----------
create or replace function api.related_cards(p_card_id uuid,p_limit int default 5)
returns jsonb language sql stable security definer set search_path = '' as $$
  with src as (select * from core.blurbs where id=p_card_id and status='published'), linked as (
    select sl.related_id id, sl.kind, sl.related_id, target.headline related_headline, 0 ord, sl.created_at
    from src join core.story_links sl on sl.card_id=src.id join core.blurbs target on target.id=sl.related_id
    where target.status='published'
    union all
    select sl.card_id, sl.kind, sl.related_id, target.headline, 0, sl.created_at
    from src join core.story_links sl on sl.related_id=src.id join core.blurbs target on target.id=sl.card_id
    where target.status='published'
  ), src_tk as (
    select upper(x->>'symbol') tk from src, jsonb_array_elements(src.tickers) x where coalesce(x->>'symbol','')<>''
    union
    select cc.ticker from src join core.card_companies cc on cc.blurb_id=src.id and cc.confidence>=0.75
  ), keys as (
    select tk from src_tk
    union
    select c2.ticker from core.companies c2 where c2.cik is not null and c2.cik in (select c.cik from core.companies c join src_tk k on k.tk=c.ticker where c.cik is not null)
  ), cand as (
    select cc.blurb_id id, count(*) score from core.card_companies cc join keys k on k.tk=cc.ticker where cc.confidence>=0.75 group by cc.blurb_id
    union all
    select b.id, 1 from core.blurbs b, src where b.id<>src.id and b.status='published' and exists(
      select 1 from jsonb_array_elements(b.tickers) x join keys k on k.tk=upper(x->>'symbol'))
  ), overlap_rows as (
    select b.id,null::text kind,null::uuid related_id,null::text related_headline,1 ord,now() created_at,sum(c.score) score
    from cand c join core.blurbs b on b.id=c.id, src
    where b.id<>src.id and b.status='published'
    group by b.id
  ), allrows as (
    select l.id,l.kind,l.related_id,l.related_headline,l.ord,l.created_at,0 score from linked l where l.id<>p_card_id
    union all select o.id,o.kind,o.related_id,o.related_headline,o.ord,o.created_at,o.score from overlap_rows o where not exists(select 1 from linked l where l.id=o.id)
  ), picked as (select * from allrows order by ord,case kind when 'update' then 1 when 'angle' then 2 when 'related' then 3 else 4 end,score desc,created_at desc,id desc limit least(greatest(coalesce(p_limit,5),1),10))
  select coalesce(jsonb_agg((x.c-'my_reaction') || case when p.kind is null then '{}'::jsonb else jsonb_build_object('story_link',jsonb_build_object('kind',p.kind,'related_id',p.related_id,'related_headline',p.related_headline)) end order by x.o),'[]'::jsonb)
  from picked p, lateral jsonb_array_elements(core.cards_json(array[p.id],null)) with ordinality x(c,o);
$$;
revoke all on function api.related_cards(uuid,int) from public;
grant execute on function api.related_cards(uuid,int) to anon,authenticated;
notify pgrst,'reload schema';
