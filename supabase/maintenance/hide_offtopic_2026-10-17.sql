-- Maintenance script (NOT a migration): hide published cards that the new topic rules
-- (watch-list companies, wallet-relevant Federal Register agencies, AI everyday-relevance score)
-- would not have produced. Paste into the Supabase SQL editor. Reversible: see UNDO at the end.
--
-- Uses core.blurbs.status = 'hidden' (allowed by the CHECK in the init migration). Hidden cards
-- drop out of api.feed (it only returns status = 'published'). The ids are saved in
-- core.maint_hidden_20261017 so the undo restores exactly these cards.
--
-- Step 1 (optional): run only the PREVIEW select to see what would be hidden.
-- Step 2: run the whole file.

-- ---------- what gets hidden ------------------------------------------------------------
-- A. SEC cards whose ticker is not on the watch list (ingest config watchCompanies).
-- B. Costco's bonus-criteria 5.02 (routine pay plan; Costco stays on the watch list).
-- C. Federal Register cards, except the two wallet-relevant ones kept below
--    (IRS paying taxes by card, DOT airline delay rule).
-- D. Fed cards: small-bank enforcement (Gardner Bancshares) and discount-rate minutes.
-- Live Nation (LYV) is on the watch list and is NOT hidden here; if its card is a routine
-- filing, uncomment the optional line in section A2.

create table if not exists core.maint_hidden_20261017 (
  blurb_id  uuid primary key,
  headline  text,
  reason    text,
  hidden_at timestamptz not null default now()
);
alter table core.maint_hidden_20261017 enable row level security;
revoke all on core.maint_hidden_20261017 from public, anon, authenticated;

with watch(symbol) as (
  select unnest(array[
    'AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA','NFLX','SNAP','RDDT','RBLX','TTWO','PINS','MTCH','BMBL','DUOL','ADBE','CRM','ORCL','INTC','AMD','QCOM','AVGO','IBM','DELL',
    'DIS','WBD','PSKY','ROKU','SIRI','LYV','AMC','CMCSA','CHTR','VZ','T','TMUS',
    'UBER','LYFT','DASH','ABNB','BKNG','EXPE','ETSY','EBAY','CVNA','W','CHWY','PTON','GME',
    'HOOD','SOFI','COIN','PYPL','XYZ','V','MA','AXP','AFRM','SLM','NNI','COF','JPM','BAC','WFC','C','GS','MS','SCHW','SYF',
    'WMT','TGT','COST','HD','LOW','BBY','KR','DG','DLTR','TJX','ROST','GAP','ANF','AEO','URBN','LULU','NKE','CROX','DECK','UAA','ELF','ULTA',
    'CMG','SBUX','MCD','YUM','DPZ','WING','CAVA','SHAK','DRI','KO','PEP','KDP','MNST','CELH','PG','HSY',
    'F','GM','RIVN','LCID','DAL','UAL','AAL','LUV','JBLU','ALK','MAR','HLT','CCL','RCL','NCLH',
    'CVS','UNH','PFE','MRNA','JNJ','LLY','ABBV','MRK','BMY','AMGN','GILD','HIMS',
    'BA','XOM','CVX','UPS','FDX','BRK-B',
    'Z','RKT','CHGG','COUR','PGR','ALL','EFX','TRU','FICO','HRB','INTU'
  ])
),
src as (                                           -- primary source name per card
  select distinct on (bs.blurb_id) bs.blurb_id, bs.name, bs.url
    from core.blurb_sources bs
   order by bs.blurb_id, bs.is_primary desc, bs.position
),
candidates as (
  -- A. SEC cards with no watch-list ticker (NioCorp, Silver Bow Mining, LifeStance, GoPro, ...)
  select b.id, b.headline, 'sec_not_watched' as reason
    from core.blurbs b join src on src.blurb_id = b.id
   where b.status = 'published' and src.name = 'SEC'
     and not exists (select 1 from jsonb_array_elements(b.tickers) t
                      where t ->> 'symbol' in (select symbol from watch))
  union all
  -- B. Costco bonus criteria (routine compensation, 5.02)
  select b.id, b.headline, 'sec_routine_5.02'
    from core.blurbs b join src on src.blurb_id = b.id
   where b.status = 'published' and src.name = 'SEC'
     and b.tickers @> '[{"symbol":"COST"}]'
     and (b.headline ilike '%bonus%' or b.body ilike '%bonus%' or b.headline ilike '%compensation%' or b.headline ilike '%pay %')
  -- A2. optional: uncomment to also hide Live Nation's card
  -- union all select b.id, b.headline, 'sec_manual' from core.blurbs b where b.status = 'published' and b.tickers @> '[{"symbol":"LYV"}]'
  union all
  -- C. Federal Register: every card except the two kept (IRS card payments, DOT airline delays)
  select b.id, b.headline, 'fedreg_offtopic'
    from core.blurbs b join src on src.blurb_id = b.id
   where b.status = 'published' and src.name = 'Federal Register'
     and not (
       (b.headline ilike '%tax%' and (b.headline ilike '%card%' or b.body ilike '%card%'))      -- IRS: paying taxes by card
       or b.headline ilike '%airline%' or b.headline ilike '%flight%'                           -- DOT: airline delay rule
     )
  union all
  -- D. Fed: small-bank enforcement and discount-rate minutes
  select b.id, b.headline, 'fed_offtopic'
    from core.blurbs b join src on src.blurb_id = b.id
   where b.status = 'published' and src.name = 'Federal Reserve Board'
     and (b.headline ilike '%Gardner%' or b.headline ilike '%discount rate%')
),
saved as (
  insert into core.maint_hidden_20261017 (blurb_id, headline, reason)
  select distinct on (id) id, headline, reason from candidates
  on conflict (blurb_id) do nothing
  returning blurb_id
)
update core.blurbs b
   set status = 'hidden'
 where b.id in (select blurb_id from saved);

-- Result: what was hidden by this script.
select reason, headline from core.maint_hidden_20261017 order by reason, headline;

-- ---------- PREVIEW (run alone instead of the file to see the list without changing anything) ----
-- Copy the "with watch ... candidates as (...)" block above and end it with:
--   select reason, headline from candidates order by reason, headline;

-- ---------- UNDO (restores exactly the cards this script hid) ---------------------------------
-- update core.blurbs set status = 'published'
--  where id in (select blurb_id from core.maint_hidden_20261017) and status = 'hidden';
-- drop table core.maint_hidden_20261017;
