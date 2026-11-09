-- =============================================================================
-- Element: companies (todo item 18, R-222). Search by company and cards grouped by company.
--
--   A  core.companies (directory), core.card_companies (card -> company tags), core.company_params
--   B  text helpers: normalize, regex escape, alternation, trigrams, trigram similarity
--   C  seed (generated from contract/companies.ts) and core.company_biz_re
--   D  tagging: core.match_companies (same rules as contract/companyMatch.ts), core.tag_card,
--      triggers on core.blurbs / core.blurb_sources, core.retag_cards
--   E  api: search_companies, company_cards (keyset paging), companies_directory, card_companies,
--      retag_companies (service role); core.company_query_scores (hook for api.search)
--   F  backfill of existing cards (last 365 days)
--
-- Why a separate tag table instead of writing into core.blurbs.tickers: tickers drive the per-ticker
-- publish cap (ticker_cap_24h) and the feed's diversity rules; name matches must not change either.
-- Tags are deterministic (regexes over headline + body, no AI), at most 3 per card, confidence >= 0.60.
-- No prices (rule 9): the directory holds names and categories only. Only the api schema is exposed.
-- Re-runnable: if not exists / create or replace / on conflict / drop trigger if exists.
-- =============================================================================

-- ---------- A. tables ---------------------------------------------------------------------------
create table if not exists core.company_params (
  key   text primary key,
  value numeric not null,
  note  text
);
insert into core.company_params (key, value, note) values
  ('tag_min_confidence', 0.60, 'a tag is kept at or above this confidence (context name + business word = 0.60)'),
  ('tag_max_per_card',   3,    'at most this many companies per card, strongest first'),
  ('recent_days',        30,   'card counts on the Companies screen and search rows cover this many days'),
  ('search_fuzzy_min',   0.35, 'typo matches need at least this trigram similarity (queries of 4+ characters)'),
  ('search_max',         10,   'api.search_companies returns at most this many companies'),
  ('cards_page_max',     30,   'api.company_cards page size cap'),
  ('batch_ids_max',      50,   'api.card_companies looks up at most this many card ids per call'),
  ('retag_max_cards',    20000,'api.retag_companies / core.retag_cards touch at most this many cards per call')
on conflict (key) do nothing;

create table if not exists core.companies (
  ticker          text primary key check (ticker ~ '^[A-Z]{1,5}([.-][A-Z]{1,2})?$'),
  name            text not null check (char_length(name) between 1 and 80),
  short_name      text not null check (char_length(short_name) between 1 and 40),
  cik             text unique check (cik ~ '^[0-9]{10}$'),
  exchange        text,
  sector          text not null check (sector in ('tech', 'internet', 'media', 'telecom', 'retail', 'consumer', 'restaurants',
                                                  'travel', 'autos', 'finance', 'health', 'industrials', 'energy')),
  industry        text not null,
  aliases         text[] not null default '{}',   -- match alone: exact case, whole words
  context_aliases text[] not null default '{}',   -- ambiguous: need a cue or a business word
  cues            text[] not null default '{}',
  negatives       text[] not null default '{}',   -- case-insensitive; veto name matches for this company
  ticker_in_text  boolean not null default false, -- a bare ALL-CAPS ticker in the text counts
  enabled         boolean not null default true,
  -- derived by core.companies_derive (never set by hand)
  ticker_re text, bare_re text, strong_re text, context_re text, strip_re text, cue_re text, negative_re text,
  search_terms    text[] not null default '{}',
  trigrams        text[] not null default '{}',
  updated_at      timestamptz not null default now()
);
create index if not exists companies_trigrams_gin on core.companies using gin (trigrams);
create index if not exists companies_terms_gin    on core.companies using gin (search_terms);
create index if not exists companies_sector_idx   on core.companies (sector, short_name);

create table if not exists core.card_companies (
  blurb_id   uuid not null references core.blurbs (id) on delete cascade,
  ticker     text not null references core.companies (ticker) on delete cascade on update cascade,
  method     text not null check (method in ('filing', 'card_ticker', 'ticker_text', 'bare_ticker', 'alias', 'context_cue', 'context_biz')),
  confidence numeric(3,2) not null check (confidence > 0 and confidence <= 1),
  sort_at    timestamptz not null,               -- copy of core.blurbs.sort_at for keyset paging
  primary key (blurb_id, ticker)
);
-- company page: newest first per company; Companies screen: recent window across companies
create index if not exists card_companies_ticker_sort on core.card_companies (ticker, sort_at desc, blurb_id desc);
create index if not exists card_companies_sort_idx    on core.card_companies (sort_at desc);

alter table core.companies      enable row level security;
alter table core.card_companies enable row level security;
alter table core.company_params enable row level security;
revoke all on core.companies, core.card_companies, core.company_params from public, anon, authenticated;

-- ---------- B. text helpers ---------------------------------------------------------------------
-- Lower case, apostrophes removed, every other non-letter/digit run -> one space (normalizeCompanyText).
create or replace function core.company_norm(p text)
returns text language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[’‘'']', '', 'g'), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Regex metacharacters escaped (reEscape).
create or replace function core.company_re_escape(p text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(p, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')
$$;

-- '(longest|...|shortest)' of the distinct trimmed values, or null for none (alternation).
create or replace function core.company_alt(p text[])
returns text language sql immutable set search_path = '' as $$
  select case when count(*) = 0 then null
              else '(' || string_agg(core.company_re_escape(a), '|' order by length(a) desc, a collate "C") || ')' end
  from (select distinct btrim(x) as a from unnest(coalesce(p, '{}'::text[])) x where btrim(x) <> '') s
$$;

-- pg_trgm-style trigrams per word, distinct and sorted (trigrams). No extension needed.
create or replace function core.trigrams(p text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(g order by g collate "C"), '{}'::text[]) from (
    select distinct substr('  ' || w || ' ', i, 3) as g
    from regexp_split_to_table(core.company_norm(p), ' ') w
    cross join lateral generate_series(1, length(w) + 1) i
    where w <> '') s
$$;

-- |a n b| / |a u b| (trigramSimilarity).
create or replace function core.trigram_sim(a text[], b text[])
returns numeric language sql immutable set search_path = '' as $$
  with i as (select count(*)::numeric as n from (select unnest(a) intersect select unnest(b)) x)
  select case when coalesce(cardinality(a), 0) = 0 or coalesce(cardinality(b), 0) = 0 then 0::numeric
              else (select n from i) / (cardinality(a) + cardinality(b) - (select n from i)) end
$$;

-- Builds the regexes and search terms of a directory row (companyPatterns / searchTerms).
create or replace function core.companies_derive()
returns trigger language plpgsql set search_path = '' as $$
declare
  l constant text := '(^|[^A-Za-z0-9])';
  r constant text := '($|[^A-Za-z0-9])';
  v_t text; v_s text; v_c text; v_q text; v_n text;
begin
  new.ticker := upper(btrim(new.ticker));
  v_t := core.company_re_escape(new.ticker);
  v_s := core.company_alt(new.aliases);
  v_c := core.company_alt(new.context_aliases);
  v_q := core.company_alt(new.cues);
  v_n := core.company_alt(new.negatives);
  new.ticker_re   := '(\$|(NYSE American|NYSE|NASDAQ|Nasdaq|Cboe): ?)' || v_t || r;
  new.bare_re     := case when new.ticker_in_text then '(^|[^A-Za-z0-9$])' || v_t || r end;
  new.strong_re   := case when v_s is not null then l || v_s || r end;
  new.context_re  := case when v_c is not null then l || v_c || r end;
  new.strip_re    := case when v_c is not null then '([A-Za-z0-9,;)] )[A-Z][a-z]+ ' || v_c || r end;
  new.cue_re      := case when v_q is not null then l || v_q || r end;
  new.negative_re := case when v_n is not null then l || v_n || r end;
  new.search_terms := array(
    select distinct core.company_norm(x) from unnest(array[new.ticker, new.name, new.short_name] || new.aliases || new.context_aliases) x
    where core.company_norm(x) <> '' order by 1);
  new.trigrams := core.trigrams(array_to_string(new.search_terms, ' '));
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists companies_derive on core.companies;
create trigger companies_derive before insert or update on core.companies
  for each row execute function core.companies_derive();

-- ---------- C. seed (generated from contract/companies.ts) and the business words ---------------
-- BEGIN GENERATED COMPANY SEED (scripts/gen-companies-sql.mjs; do not edit by hand)
-- Business words that let an ambiguous name count (BUSINESS_WORDS in contract/companyMatch.ts).
create or replace function core.company_biz_re()
returns text language sql immutable set search_path = '' as $$
  select '(^|[^A-Za-z0-9])' || core.company_alt(array['shares', 'stock', 'stocks', 'investors', 'earnings', 'revenue', 'profit', 'profits', 'quarter', 'quarterly', 'sales', 'CEO', 'chief executive', 'company', 'retailer', 'automaker', 'airline', 'customers', 'layoffs', 'deal', 'acquisition', 'merger', 'lawsuit', 'antitrust', 'regulators', 'recall', 'recalls', 'recalled', 'billion', 'million', 'Inc', 'Corp', 'analysts', 'Wall Street', 'outlook', 'forecast', 'subscribers']) || '($|[^A-Za-z0-9])'
$$;

insert into core.companies (ticker, name, short_name, cik, exchange, sector, industry, aliases, context_aliases, cues, negatives, ticker_in_text) values
  ('AAPL', 'Apple Inc.', 'Apple', '0000320193', 'Nasdaq', 'tech', 'Consumer electronics', array['Apple Inc'], array['Apple'], array['iPhone', 'iPhones', 'iPad', 'MacBook', 'App Store', 'Apple Watch', 'Apple Music', 'Apple TV', 'Apple Pay', 'AirPods', 'Vision Pro', 'iOS', 'Tim Cook', 'Cupertino'], array['Big Apple', 'apple pie', 'apple cider', 'apple orchard', 'apple orchards', 'apple harvest', 'apple growers', 'apple juice', 'candy apple', 'crab apple', 'Apple Valley', 'Apple River', 'apple crop', 'apple farmers'], true),
  ('MSFT', 'Microsoft Corp.', 'Microsoft', '0000789019', 'Nasdaq', 'tech', 'Software & cloud', array['Microsoft', 'Xbox', 'LinkedIn'], '{}'::text[], array['Windows', 'Azure', 'Satya Nadella'], '{}'::text[], true),
  ('NVDA', 'Nvidia Corp.', 'Nvidia', '0001045810', 'Nasdaq', 'tech', 'Chips', array['Nvidia', 'NVIDIA'], '{}'::text[], array['Jensen Huang', 'GPUs', 'GeForce'], '{}'::text[], true),
  ('GOOGL', 'Alphabet Inc.', 'Google', '0001652044', 'Nasdaq', 'tech', 'Search & cloud', array['Google', 'YouTube', 'Waymo', 'Alphabet Inc'], array['Alphabet'], array['Google', 'Sundar Pichai', 'Android', 'Gemini', 'Chrome'], array['alphabet soup'], true),
  ('ADBE', 'Adobe Inc.', 'Adobe', '0000796343', 'Nasdaq', 'tech', 'Software', array['Adobe'], '{}'::text[], array['Photoshop', 'Acrobat'], array['adobe house', 'adobe homes', 'adobe brick'], true),
  ('CRM', 'Salesforce, Inc.', 'Salesforce', '0001108524', 'NYSE', 'tech', 'Software', array['Salesforce'], '{}'::text[], array['Marc Benioff', 'Slack'], '{}'::text[], false),
  ('ORCL', 'Oracle Corp.', 'Oracle', '0001341439', 'NYSE', 'tech', 'Software & cloud', array['Oracle Corp'], array['Oracle'], array['Larry Ellison', 'database', 'cloud', 'data centers', 'data center', 'TikTok'], array['Oracle of Omaha', 'oracle at Delphi', 'Oracle at Delphi'], true),
  ('INTC', 'Intel Corp.', 'Intel', '0000050863', 'Nasdaq', 'tech', 'Chips', array['Intel Corp'], array['Intel'], array['chips', 'chipmaker', 'semiconductor', 'semiconductors', 'foundry', 'processors', 'Lip-Bu Tan', 'Pat Gelsinger'], '{}'::text[], true),
  ('AMD', 'Advanced Micro Devices', 'AMD', '0000002488', 'Nasdaq', 'tech', 'Chips', array['AMD', 'Advanced Micro Devices'], '{}'::text[], array['Lisa Su', 'chips'], '{}'::text[], false),
  ('QCOM', 'Qualcomm Inc.', 'Qualcomm', '0000804328', 'Nasdaq', 'tech', 'Chips', array['Qualcomm', 'Snapdragon'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AVGO', 'Broadcom Inc.', 'Broadcom', '0001730168', 'Nasdaq', 'tech', 'Chips', array['Broadcom'], '{}'::text[], array['VMware'], '{}'::text[], true),
  ('IBM', 'IBM', 'IBM', '0000051143', 'NYSE', 'tech', 'Software & services', array['IBM', 'International Business Machines'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('DELL', 'Dell Technologies', 'Dell', '0001571996', 'NYSE', 'tech', 'Computers', array['Dell Technologies'], array['Dell'], array['laptops', 'PCs', 'servers', 'Alienware'], '{}'::text[], true),
  ('NOW', 'ServiceNow, Inc.', 'ServiceNow', null, null, 'tech', 'Software', array['ServiceNow'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('CSCO', 'Cisco Systems', 'Cisco', null, null, 'tech', 'Networking', array['Cisco', 'Cisco Systems'], '{}'::text[], array['Webex'], '{}'::text[], true),
  ('TXN', 'Texas Instruments', 'Texas Instruments', null, null, 'tech', 'Chips', array['Texas Instruments'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AMAT', 'Applied Materials', 'Applied Materials', null, null, 'tech', 'Chip equipment', array['Applied Materials'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MU', 'Micron Technology', 'Micron', null, null, 'tech', 'Memory chips', array['Micron', 'Micron Technology'], '{}'::text[], '{}'::text[], array['micron filter'], false),
  ('LRCX', 'Lam Research', 'Lam Research', null, null, 'tech', 'Chip equipment', array['Lam Research'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('KLAC', 'KLA Corp.', 'KLA', null, null, 'tech', 'Chip equipment', array['KLA Corp', 'KLA Corporation'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ADI', 'Analog Devices', 'Analog Devices', null, null, 'tech', 'Chips', array['Analog Devices'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PANW', 'Palo Alto Networks', 'Palo Alto Networks', null, null, 'tech', 'Cybersecurity', array['Palo Alto Networks'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CRWD', 'CrowdStrike Holdings', 'CrowdStrike', null, null, 'tech', 'Cybersecurity', array['CrowdStrike'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PLTR', 'Palantir Technologies', 'Palantir', null, null, 'tech', 'Software', array['Palantir'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('INTU', 'Intuit Inc.', 'Intuit', '0000896878', 'Nasdaq', 'tech', 'Finance software', array['Intuit', 'TurboTax', 'QuickBooks', 'Credit Karma', 'Mailchimp'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TTWO', 'Take-Two Interactive', 'Take-Two', '0000946581', 'Nasdaq', 'tech', 'Video games', array['Take-Two', 'Take-Two Interactive', 'Rockstar Games', 'Grand Theft Auto'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('RBLX', 'Roblox Corp.', 'Roblox', '0001315098', 'NYSE', 'tech', 'Video games', array['Roblox'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CHGG', 'Chegg, Inc.', 'Chegg', '0001364954', 'NYSE', 'tech', 'Online learning', array['Chegg'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('COUR', 'Coursera, Inc.', 'Coursera', '0001651562', 'NYSE', 'tech', 'Online learning', array['Coursera'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('DUOL', 'Duolingo, Inc.', 'Duolingo', '0001562088', 'Nasdaq', 'tech', 'Online learning', array['Duolingo'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('META', 'Meta Platforms', 'Meta', '0001326801', 'Nasdaq', 'internet', 'Social media', array['Meta Platforms', 'Facebook', 'Instagram', 'WhatsApp'], array['Meta'], array['Mark Zuckerberg', 'Zuckerberg', 'Threads', 'Quest headset'], array['meta-analysis'], false),
  ('SNAP', 'Snap Inc.', 'Snap', '0001564408', 'NYSE', 'internet', 'Social media', array['Snap Inc', 'Snapchat'], array['Snap'], array['Evan Spiegel'], '{}'::text[], false),
  ('RDDT', 'Reddit, Inc.', 'Reddit', '0001713445', 'NYSE', 'internet', 'Social media', array['Reddit'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PINS', 'Pinterest, Inc.', 'Pinterest', '0001506293', 'NYSE', 'internet', 'Social media', array['Pinterest'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('MTCH', 'Match Group', 'Match Group', '0000891103', 'Nasdaq', 'internet', 'Dating apps', array['Match Group', 'Tinder', 'Hinge'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('BMBL', 'Bumble Inc.', 'Bumble', '0001830043', 'Nasdaq', 'internet', 'Dating apps', array['Bumble'], '{}'::text[], '{}'::text[], array['bumblebee', 'bumble bee', 'bumblebees'], true),
  ('NFLX', 'Netflix, Inc.', 'Netflix', '0001065280', 'Nasdaq', 'media', 'Streaming', array['Netflix'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('DIS', 'The Walt Disney Co.', 'Disney', '0001744489', 'NYSE', 'media', 'Entertainment', array['Disney', 'Walt Disney', 'ESPN', 'Hulu', 'Pixar', 'Disney+'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('WBD', 'Warner Bros. Discovery', 'Warner Bros. Discovery', '0001437107', 'Nasdaq', 'media', 'Entertainment', array['Warner Bros', 'Warner Bros. Discovery', 'HBO', 'HBO Max'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PSKY', 'Paramount Skydance', 'Paramount', '0002041610', 'Nasdaq', 'media', 'Entertainment', array['Paramount Skydance', 'Paramount Pictures', 'Paramount+', 'CBS'], array['Paramount'], array['Skydance', 'David Ellison', 'studio'], '{}'::text[], true),
  ('ROKU', 'Roku, Inc.', 'Roku', '0001428439', 'Nasdaq', 'media', 'Streaming', array['Roku'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('SIRI', 'Sirius XM Holdings', 'SiriusXM', '0000908937', 'Nasdaq', 'media', 'Radio & audio', array['SiriusXM', 'Sirius XM'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('LYV', 'Live Nation Entertainment', 'Live Nation', '0001335258', 'NYSE', 'media', 'Live events', array['Live Nation', 'Ticketmaster'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AMC', 'AMC Entertainment', 'AMC Theatres', '0001411579', 'NYSE', 'media', 'Movie theaters', array['AMC Entertainment', 'AMC Theatres'], array['AMC'], array['theaters', 'theatres', 'movie theater', 'box office', 'Adam Aron'], array['AMC Networks', 'The Walking Dead'], false),
  ('CMCSA', 'Comcast Corp.', 'Comcast', '0001166691', 'Nasdaq', 'telecom', 'Cable & media', array['Comcast', 'NBCUniversal', 'Xfinity'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CHTR', 'Charter Communications', 'Charter', '0001091667', 'Nasdaq', 'telecom', 'Cable', array['Charter Communications'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('VZ', 'Verizon Communications', 'Verizon', '0000732712', 'NYSE', 'telecom', 'Wireless', array['Verizon'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('T', 'AT&T Inc.', 'AT&T', '0000732717', 'NYSE', 'telecom', 'Wireless', array['AT&T'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('TMUS', 'T-Mobile US', 'T-Mobile', '0001283699', 'Nasdaq', 'telecom', 'Wireless', array['T-Mobile'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AMZN', 'Amazon.com, Inc.', 'Amazon', '0001018724', 'Nasdaq', 'retail', 'Online retail & cloud', array['Amazon.com', 'Whole Foods', 'Amazon Web Services'], array['Amazon'], array['AWS', 'Prime Video', 'Prime Day', 'Amazon Prime', 'Alexa', 'Jeff Bezos', 'Andy Jassy', 'Kindle', 'warehouse', 'warehouses', 'online retailer'], array['Amazon rainforest', 'Amazon River', 'Amazon basin', 'Brazilian Amazon', 'deforestation', 'Amazon jungle'], true),
  ('WMT', 'Walmart Inc.', 'Walmart', '0000104169', 'Nasdaq', 'retail', 'Discount stores', array['Walmart', 'Sam''s Club'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TGT', 'Target Corp.', 'Target', '0000027419', 'NYSE', 'retail', 'Discount stores', array['Target Corp'], array['Target'], array['retailer', 'stores', 'store', 'shoppers', 'Brian Cornell', 'Minneapolis-based'], array['Target Field', 'Target Center', 'target rate', 'inflation target', 'target date', 'target-date'], false),
  ('COST', 'Costco Wholesale', 'Costco', '0000909832', 'Nasdaq', 'retail', 'Warehouse clubs', array['Costco'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('HD', 'The Home Depot', 'Home Depot', '0000354950', 'NYSE', 'retail', 'Home improvement', array['Home Depot'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('LOW', 'Lowe''s Companies', 'Lowe''s', '0000060667', 'NYSE', 'retail', 'Home improvement', array['Lowe''s'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('BBY', 'Best Buy Co.', 'Best Buy', '0000764478', 'NYSE', 'retail', 'Electronics stores', array['Best Buy'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('KR', 'The Kroger Co.', 'Kroger', '0000056873', 'NYSE', 'retail', 'Grocery', array['Kroger'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('DG', 'Dollar General', 'Dollar General', '0000029534', 'NYSE', 'retail', 'Discount stores', array['Dollar General'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('DLTR', 'Dollar Tree', 'Dollar Tree', '0000935703', 'Nasdaq', 'retail', 'Discount stores', array['Dollar Tree'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TJX', 'The TJX Companies', 'TJX', '0000109198', 'NYSE', 'retail', 'Off-price stores', array['TJX', 'TJ Maxx', 'T.J. Maxx', 'Marshalls', 'HomeGoods'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ROST', 'Ross Stores', 'Ross', '0000745732', 'Nasdaq', 'retail', 'Off-price stores', array['Ross Stores', 'Ross Dress for Less'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('GAP', 'Gap Inc.', 'Gap', '0000039911', 'NYSE', 'retail', 'Clothing', array['Gap Inc', 'Old Navy', 'Banana Republic', 'Athleta'], array['Gap'], array['retailer', 'stores', 'apparel', 'clothing', 'jeans'], array['wage gap', 'pay gap', 'gender gap', 'Gap year', 'gap year'], false),
  ('ANF', 'Abercrombie & Fitch', 'Abercrombie', '0001018840', 'NYSE', 'retail', 'Clothing', array['Abercrombie', 'Abercrombie & Fitch'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AEO', 'American Eagle Outfitters', 'American Eagle', '0000919012', 'NYSE', 'retail', 'Clothing', array['American Eagle Outfitters', 'Aerie'], array['American Eagle'], array['jeans', 'retailer', 'stores', 'apparel'], array['bald eagle', 'bird'], true),
  ('URBN', 'Urban Outfitters', 'Urban Outfitters', '0000912615', 'Nasdaq', 'retail', 'Clothing', array['Urban Outfitters', 'Anthropologie', 'Free People'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('M', 'Macy''s, Inc.', 'Macy''s', null, null, 'retail', 'Department stores', array['Macy''s', 'Bloomingdale''s'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('JWN', 'Nordstrom, Inc.', 'Nordstrom', null, null, 'retail', 'Department stores', array['Nordstrom'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('FIVE', 'Five Below', 'Five Below', null, null, 'retail', 'Discount stores', array['Five Below'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('ORLY', 'O''Reilly Automotive', 'O''Reilly', null, null, 'retail', 'Auto parts', array['O''Reilly Automotive', 'O''Reilly Auto Parts'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AZO', 'AutoZone, Inc.', 'AutoZone', null, null, 'retail', 'Auto parts', array['AutoZone'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TSCO', 'Tractor Supply', 'Tractor Supply', null, null, 'retail', 'Farm & ranch stores', array['Tractor Supply'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ETSY', 'Etsy, Inc.', 'Etsy', '0001370637', 'NYSE', 'retail', 'Online marketplace', array['Etsy'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('EBAY', 'eBay Inc.', 'eBay', '0001065088', 'Nasdaq', 'retail', 'Online marketplace', array['eBay'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CVNA', 'Carvana Co.', 'Carvana', '0001690820', 'NYSE', 'retail', 'Online car sales', array['Carvana'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('W', 'Wayfair Inc.', 'Wayfair', '0001616707', 'NYSE', 'retail', 'Online furniture', array['Wayfair'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('CHWY', 'Chewy, Inc.', 'Chewy', '0001766502', 'NYSE', 'retail', 'Online pet supplies', array['Chewy Inc'], array['Chewy'], array['pet', 'pets', 'retailer'], '{}'::text[], true),
  ('GME', 'GameStop Corp.', 'GameStop', '0001326380', 'NYSE', 'retail', 'Video game stores', array['GameStop'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ULTA', 'Ulta Beauty', 'Ulta', '0001403568', 'Nasdaq', 'retail', 'Beauty stores', array['Ulta', 'Ulta Beauty'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('NKE', 'Nike, Inc.', 'Nike', '0000320187', 'NYSE', 'consumer', 'Sportswear', array['Nike'], '{}'::text[], array['sneakers', 'Jordan brand'], '{}'::text[], true),
  ('LULU', 'Lululemon Athletica', 'Lululemon', '0001397187', 'Nasdaq', 'consumer', 'Sportswear', array['Lululemon', 'lululemon'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CROX', 'Crocs, Inc.', 'Crocs', '0001334036', 'Nasdaq', 'consumer', 'Footwear', array['Crocs Inc'], array['Crocs'], array['footwear', 'shoes', 'clogs', 'HeyDude'], array['crocodile', 'crocodiles', 'alligator', 'alligators', 'reptile'], true),
  ('DECK', 'Deckers Brands', 'Deckers', '0000910521', 'NYSE', 'consumer', 'Footwear', array['Deckers', 'Hoka', 'HOKA', 'UGG'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('UAA', 'Under Armour', 'Under Armour', '0001336917', 'NYSE', 'consumer', 'Sportswear', array['Under Armour'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ELF', 'e.l.f. Beauty', 'e.l.f.', '0001600033', 'NYSE', 'consumer', 'Cosmetics', array['e.l.f.', 'e.l.f. Beauty', 'elf Beauty'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('KO', 'The Coca-Cola Co.', 'Coca-Cola', '0000021344', 'NYSE', 'consumer', 'Drinks', array['Coca-Cola'], array['Coke'], array['soda', 'drinks', 'beverage', 'bottler'], array['cocaine'], false),
  ('PEP', 'PepsiCo, Inc.', 'PepsiCo', '0000077476', 'Nasdaq', 'consumer', 'Drinks & snacks', array['PepsiCo', 'Pepsi', 'Frito-Lay', 'Gatorade', 'Doritos'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('KDP', 'Keurig Dr Pepper', 'Keurig Dr Pepper', '0001418135', 'Nasdaq', 'consumer', 'Drinks', array['Keurig', 'Keurig Dr Pepper', 'Dr Pepper', 'Dr. Pepper'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MNST', 'Monster Beverage', 'Monster', '0000865752', 'Nasdaq', 'consumer', 'Energy drinks', array['Monster Beverage', 'Monster Energy'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CELH', 'Celsius Holdings', 'Celsius', '0001341766', 'Nasdaq', 'consumer', 'Energy drinks', array['Celsius Holdings'], array['Celsius'], array['energy drink', 'energy drinks', 'drinks', 'beverage'], array['degrees Celsius', 'degrees', 'temperatures', 'heat wave', 'Fahrenheit'], true),
  ('PG', 'Procter & Gamble', 'P&G', '0000080424', 'NYSE', 'consumer', 'Household products', array['Procter & Gamble', 'P&G', 'Pampers'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('HSY', 'The Hershey Co.', 'Hershey', '0000047111', 'NYSE', 'consumer', 'Candy', array['Hershey Co', 'Hershey Company', 'Reese''s'], array['Hershey'], array['chocolate', 'candy', 'cocoa'], '{}'::text[], true),
  ('PTON', 'Peloton Interactive', 'Peloton', '0001639825', 'Nasdaq', 'consumer', 'Fitness', array['Peloton'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CMG', 'Chipotle Mexican Grill', 'Chipotle', '0001058090', 'NYSE', 'restaurants', 'Fast casual', array['Chipotle'], '{}'::text[], '{}'::text[], array['chipotle pepper', 'chipotle peppers', 'chipotle sauce'], true),
  ('SBUX', 'Starbucks Corp.', 'Starbucks', '0000829224', 'Nasdaq', 'restaurants', 'Coffee shops', array['Starbucks'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MCD', 'McDonald''s Corp.', 'McDonald''s', '0000063908', 'NYSE', 'restaurants', 'Fast food', array['McDonald''s', 'McDonalds'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('YUM', 'Yum! Brands', 'Yum Brands', '0001041061', 'NYSE', 'restaurants', 'Fast food', array['Yum Brands', 'Yum! Brands', 'Taco Bell', 'KFC', 'Pizza Hut'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('DPZ', 'Domino''s Pizza', 'Domino''s', '0001286681', 'Nasdaq', 'restaurants', 'Pizza', array['Domino''s', 'Domino''s Pizza'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('WING', 'Wingstop Inc.', 'Wingstop', '0001636222', 'Nasdaq', 'restaurants', 'Fast food', array['Wingstop'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('CAVA', 'Cava Group', 'Cava', '0001639438', 'NYSE', 'restaurants', 'Fast casual', array['Cava Group', 'CAVA'], array['Cava'], array['restaurant', 'restaurants', 'Mediterranean', 'bowls'], array['sparkling wine', 'cava wine', 'Spanish cava', 'champagne', 'prosecco'], true),
  ('SHAK', 'Shake Shack', 'Shake Shack', '0001620533', 'NYSE', 'restaurants', 'Fast casual', array['Shake Shack'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('DRI', 'Darden Restaurants', 'Darden', '0000940944', 'NYSE', 'restaurants', 'Sit-down dining', array['Darden', 'Olive Garden', 'LongHorn Steakhouse'], '{}'::text[], '{}'::text[], array['Darden School'], true),
  ('UBER', 'Uber Technologies', 'Uber', '0001543151', 'NYSE', 'travel', 'Ride hailing & delivery', array['Uber', 'Uber Eats'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('LYFT', 'Lyft, Inc.', 'Lyft', '0001759509', 'Nasdaq', 'travel', 'Ride hailing', array['Lyft'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('DASH', 'DoorDash, Inc.', 'DoorDash', '0001792789', 'Nasdaq', 'travel', 'Food delivery', array['DoorDash'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('ABNB', 'Airbnb, Inc.', 'Airbnb', '0001559720', 'Nasdaq', 'travel', 'Home rentals', array['Airbnb'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('BKNG', 'Booking Holdings', 'Booking', '0001075531', 'Nasdaq', 'travel', 'Online travel', array['Booking Holdings', 'Booking.com', 'Priceline', 'OpenTable'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('EXPE', 'Expedia Group', 'Expedia', '0001324424', 'Nasdaq', 'travel', 'Online travel', array['Expedia', 'Vrbo', 'Hotels.com'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('DAL', 'Delta Air Lines', 'Delta', '0000027904', 'NYSE', 'travel', 'Airlines', array['Delta Air Lines'], array['Delta'], array['airline', 'airlines', 'flights', 'flight', 'Ed Bastian', 'Atlanta-based', 'carrier', 'passengers'], array['Delta variant', 'Mississippi Delta', 'river delta', 'Delta Force', 'Niger Delta', 'Nile Delta', 'Delta smelt'], false),
  ('UAL', 'United Airlines Holdings', 'United Airlines', '0000100517', 'Nasdaq', 'travel', 'Airlines', array['United Airlines'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('AAL', 'American Airlines Group', 'American Airlines', '0000006201', 'Nasdaq', 'travel', 'Airlines', array['American Airlines'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('LUV', 'Southwest Airlines', 'Southwest', '0000092380', 'NYSE', 'travel', 'Airlines', array['Southwest Airlines'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('JBLU', 'JetBlue Airways', 'JetBlue', '0001158463', 'Nasdaq', 'travel', 'Airlines', array['JetBlue'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ALK', 'Alaska Air Group', 'Alaska Airlines', '0000766421', 'NYSE', 'travel', 'Airlines', array['Alaska Airlines', 'Alaska Air', 'Hawaiian Airlines'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('MAR', 'Marriott International', 'Marriott', '0001048286', 'Nasdaq', 'travel', 'Hotels', array['Marriott'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('HLT', 'Hilton Worldwide', 'Hilton', '0001585689', 'NYSE', 'travel', 'Hotels', array['Hilton Worldwide', 'Hilton Hotels'], array['Hilton'], array['hotel', 'hotels', 'hotelier', 'rooms'], array['Paris Hilton'], true),
  ('CCL', 'Carnival Corp.', 'Carnival', '0000815097', 'NYSE', 'travel', 'Cruises', array['Carnival Corp', 'Carnival Cruise', 'Carnival Cruise Line'], array['Carnival'], array['cruise', 'cruises', 'ships', 'cruise line'], array['Notting Hill', 'carnival rides', 'Rio carnival', 'Mardi Gras'], false),
  ('RCL', 'Royal Caribbean Group', 'Royal Caribbean', '0000884887', 'NYSE', 'travel', 'Cruises', array['Royal Caribbean'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('NCLH', 'Norwegian Cruise Line Holdings', 'Norwegian Cruise Line', '0001513761', 'NYSE', 'travel', 'Cruises', array['Norwegian Cruise Line', 'Norwegian Cruise'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TSLA', 'Tesla, Inc.', 'Tesla', '0001318605', 'Nasdaq', 'autos', 'Electric cars', array['Tesla'], '{}'::text[], array['Elon Musk', 'Cybertruck', 'Model Y', 'Model 3', 'robotaxi'], array['Nikola Tesla', 'Tesla coil'], true),
  ('F', 'Ford Motor Co.', 'Ford', '0000037996', 'NYSE', 'autos', 'Carmakers', array['Ford Motor'], array['Ford'], array['F-150', 'Mustang', 'Bronco', 'automaker', 'carmaker', 'Dearborn', 'Jim Farley', 'vehicles', 'trucks', 'pickup'], array['Harrison Ford', 'Gerald Ford', 'President Ford', 'Doug Ford', 'Tom Ford', 'Betty Ford', 'Ford Foundation', 'Ford''s Theatre', 'Ford Theatre'], false),
  ('GM', 'General Motors', 'GM', '0001467858', 'NYSE', 'autos', 'Carmakers', array['General Motors', 'Chevrolet', 'Cadillac'], array['GM'], array['automaker', 'carmaker', 'Mary Barra', 'vehicles', 'trucks', 'Detroit'], array['GM crops', 'GM food', 'GM foods', 'genetically modified', 'Chevy Chase', 'Cadillac tax', 'the Cadillac of'], false),
  ('RIVN', 'Rivian Automotive', 'Rivian', '0001874178', 'Nasdaq', 'autos', 'Electric cars', array['Rivian'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('LCID', 'Lucid Group', 'Lucid', '0001811210', 'Nasdaq', 'autos', 'Electric cars', array['Lucid Motors', 'Lucid Group'], array['Lucid'], array['electric vehicle', 'EV', 'EVs', 'automaker', 'Air sedan'], array['lucid dream', 'lucid dreaming'], true),
  ('JPM', 'JPMorgan Chase & Co.', 'JPMorgan', '0000019617', 'NYSE', 'finance', 'Banks', array['JPMorgan', 'JPMorgan Chase', 'J.P. Morgan'], array['Chase'], array['bank', 'banks', 'Jamie Dimon', 'credit card', 'Sapphire'], array['Chase Center', 'police chase', 'car chase'], true),
  ('BAC', 'Bank of America', 'Bank of America', '0000070858', 'NYSE', 'finance', 'Banks', array['Bank of America', 'BofA', 'Merrill Lynch'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('WFC', 'Wells Fargo & Co.', 'Wells Fargo', '0000072971', 'NYSE', 'finance', 'Banks', array['Wells Fargo'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('C', 'Citigroup Inc.', 'Citi', '0000831001', 'NYSE', 'finance', 'Banks', array['Citigroup', 'Citi', 'Citibank'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('GS', 'Goldman Sachs Group', 'Goldman Sachs', '0000886982', 'NYSE', 'finance', 'Investment banks', array['Goldman Sachs'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('MS', 'Morgan Stanley', 'Morgan Stanley', '0000895421', 'NYSE', 'finance', 'Investment banks', array['Morgan Stanley', 'E*Trade', 'E*TRADE'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('SCHW', 'Charles Schwab Corp.', 'Schwab', '0000316709', 'NYSE', 'finance', 'Brokers', array['Charles Schwab', 'Schwab'], '{}'::text[], '{}'::text[], array['Klaus Schwab', 'World Economic Forum'], true),
  ('COF', 'Capital One Financial', 'Capital One', '0000927628', 'NYSE', 'finance', 'Banks & cards', array['Capital One'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('USB', 'U.S. Bancorp', 'U.S. Bank', null, null, 'finance', 'Banks', array['U.S. Bancorp', 'U.S. Bank', 'US Bancorp'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('PNC', 'PNC Financial Services', 'PNC', null, null, 'finance', 'Banks', array['PNC', 'PNC Bank', 'PNC Financial'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('TFC', 'Truist Financial', 'Truist', null, null, 'finance', 'Banks', array['Truist'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('BK', 'BNY', 'BNY', null, null, 'finance', 'Banks', array['BNY Mellon', 'Bank of New York Mellon', 'BNY'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('STT', 'State Street Corp.', 'State Street', null, null, 'finance', 'Asset managers', array['State Street Corp', 'State Street Global Advisors'], array['State Street'], array['bank', 'asset manager', 'funds', 'Boston-based'], '{}'::text[], false),
  ('BLK', 'BlackRock, Inc.', 'BlackRock', null, null, 'finance', 'Asset managers', array['BlackRock', 'iShares'], '{}'::text[], array['Larry Fink'], '{}'::text[], true),
  ('V', 'Visa Inc.', 'Visa', '0001403161', 'NYSE', 'finance', 'Payments', array['Visa Inc'], array['Visa'], array['payments', 'card network', 'card networks', 'credit card', 'debit card', 'Mastercard', 'swipe fees', 'transactions'], array['student visa', 'student visas', 'work visa', 'visa holders', 'visa rules', 'visa applicants', 'visa application', 'H-1B', 'immigration', 'embassy', 'consulate', 'travel ban', 'Visa rules', 'Visa applicants'], false),
  ('MA', 'Mastercard Inc.', 'Mastercard', '0001141391', 'NYSE', 'finance', 'Payments', array['Mastercard'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('AXP', 'American Express', 'American Express', '0000004962', 'NYSE', 'finance', 'Cards', array['American Express', 'Amex'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PYPL', 'PayPal Holdings', 'PayPal', '0001633917', 'Nasdaq', 'finance', 'Payments', array['PayPal', 'Venmo'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('XYZ', 'Block, Inc.', 'Block', '0001512673', 'NYSE', 'finance', 'Payments', array['Block Inc', 'Cash App', 'Afterpay'], '{}'::text[], array['Jack Dorsey'], '{}'::text[], false),
  ('AFRM', 'Affirm Holdings', 'Affirm', '0001820953', 'Nasdaq', 'finance', 'Buy now, pay later', array['Affirm Holdings'], array['Affirm'], array['buy now, pay later', 'BNPL', 'Max Levchin', 'installment', 'loans'], '{}'::text[], true),
  ('HOOD', 'Robinhood Markets', 'Robinhood', '0001783879', 'Nasdaq', 'finance', 'Brokers', array['Robinhood'], '{}'::text[], '{}'::text[], array['Robin Hood'], false),
  ('SOFI', 'SoFi Technologies', 'SoFi', '0001818874', 'Nasdaq', 'finance', 'Online banks', array['SoFi'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('COIN', 'Coinbase Global', 'Coinbase', '0001679788', 'Nasdaq', 'finance', 'Crypto exchanges', array['Coinbase'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('SLM', 'SLM Corp. (Sallie Mae)', 'Sallie Mae', '0001032033', 'Nasdaq', 'finance', 'Student loans', array['Sallie Mae'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('NNI', 'Nelnet, Inc.', 'Nelnet', '0001258602', 'NYSE', 'finance', 'Student loans', array['Nelnet'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('SYF', 'Synchrony Financial', 'Synchrony', '0001601712', 'NYSE', 'finance', 'Cards', array['Synchrony'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ICE', 'Intercontinental Exchange', 'ICE', null, null, 'finance', 'Exchanges', array['Intercontinental Exchange'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('CME', 'CME Group', 'CME Group', null, null, 'finance', 'Exchanges', array['CME Group'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('SPGI', 'S&P Global', 'S&P Global', null, null, 'finance', 'Ratings & data', array['S&P Global'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MCO', 'Moody''s Corp.', 'Moody''s', null, null, 'finance', 'Ratings & data', array['Moody''s'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('BRK-B', 'Berkshire Hathaway', 'Berkshire Hathaway', '0001067983', 'NYSE', 'finance', 'Conglomerates', array['Berkshire Hathaway', 'Oracle of Omaha'], '{}'::text[], array['Warren Buffett', 'Greg Abel'], '{}'::text[], true),
  ('PGR', 'Progressive Corp.', 'Progressive', '0000080661', 'NYSE', 'finance', 'Insurance', array['Progressive Corp', 'Progressive Insurance'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('ALL', 'Allstate Corp.', 'Allstate', '0000899051', 'NYSE', 'finance', 'Insurance', array['Allstate'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('EFX', 'Equifax Inc.', 'Equifax', '0000033185', 'NYSE', 'finance', 'Credit bureaus', array['Equifax'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('TRU', 'TransUnion', 'TransUnion', '0001552033', 'NYSE', 'finance', 'Credit bureaus', array['TransUnion'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('FICO', 'Fair Isaac Corp.', 'FICO', '0000814547', 'NYSE', 'finance', 'Credit scores', array['FICO', 'Fair Isaac'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('HRB', 'H&R Block', 'H&R Block', '0000012659', 'NYSE', 'finance', 'Tax preparation', array['H&R Block'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('Z', 'Zillow Group', 'Zillow', '0001617640', 'Nasdaq', 'finance', 'Real estate', array['Zillow'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('RKT', 'Rocket Companies', 'Rocket', '0001805284', 'NYSE', 'finance', 'Mortgages', array['Rocket Companies', 'Rocket Mortgage'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CVS', 'CVS Health', 'CVS', '0000064803', 'NYSE', 'health', 'Pharmacies & insurance', array['CVS', 'CVS Health', 'Aetna'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('UNH', 'UnitedHealth Group', 'UnitedHealth', '0000731766', 'NYSE', 'health', 'Health insurance', array['UnitedHealth', 'UnitedHealthcare', 'Optum'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('PFE', 'Pfizer Inc.', 'Pfizer', '0000078003', 'NYSE', 'health', 'Drugmakers', array['Pfizer'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MRNA', 'Moderna, Inc.', 'Moderna', '0001682852', 'Nasdaq', 'health', 'Vaccines', array['Moderna'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('JNJ', 'Johnson & Johnson', 'J&J', '0000200406', 'NYSE', 'health', 'Drugmakers', array['Johnson & Johnson', 'J&J'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('LLY', 'Eli Lilly & Co.', 'Eli Lilly', '0000059478', 'NYSE', 'health', 'Drugmakers', array['Eli Lilly'], array['Lilly'], array['Mounjaro', 'Zepbound', 'drugmaker', 'weight-loss', 'obesity drug', 'drug'], '{}'::text[], true),
  ('ABBV', 'AbbVie Inc.', 'AbbVie', '0001551152', 'NYSE', 'health', 'Drugmakers', array['AbbVie'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('MRK', 'Merck & Co.', 'Merck', '0000310158', 'NYSE', 'health', 'Drugmakers', array['Merck'], '{}'::text[], '{}'::text[], array['Merck KGaA'], true),
  ('BMY', 'Bristol Myers Squibb', 'Bristol Myers', '0000014272', 'NYSE', 'health', 'Drugmakers', array['Bristol Myers Squibb', 'Bristol-Myers Squibb', 'Bristol Myers'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('AMGN', 'Amgen Inc.', 'Amgen', '0000318154', 'Nasdaq', 'health', 'Biotech', array['Amgen'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('GILD', 'Gilead Sciences', 'Gilead', '0000882095', 'Nasdaq', 'health', 'Biotech', array['Gilead', 'Gilead Sciences'], '{}'::text[], '{}'::text[], array['Handmaid'], true),
  ('HIMS', 'Hims & Hers Health', 'Hims & Hers', '0001773751', 'NYSE', 'health', 'Telehealth', array['Hims & Hers', 'Hims'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('BA', 'The Boeing Co.', 'Boeing', '0000012927', 'NYSE', 'industrials', 'Aerospace', array['Boeing'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('LMT', 'Lockheed Martin', 'Lockheed Martin', null, null, 'industrials', 'Defense', array['Lockheed Martin', 'Lockheed'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('RTX', 'RTX Corp.', 'RTX', null, null, 'industrials', 'Aerospace & defense', array['Raytheon', 'Pratt & Whitney', 'RTX Corp'], array['RTX'], array['Raytheon', 'defense', 'missiles', 'missile', 'Pentagon', 'jet engines'], array['GeForce RTX', 'RTX 40', 'RTX 50', 'graphics card', 'graphics cards'], false),
  ('GD', 'General Dynamics', 'General Dynamics', null, null, 'industrials', 'Defense', array['General Dynamics', 'Gulfstream'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('NOC', 'Northrop Grumman', 'Northrop Grumman', null, null, 'industrials', 'Defense', array['Northrop Grumman', 'Northrop'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('HON', 'Honeywell International', 'Honeywell', null, null, 'industrials', 'Conglomerates', array['Honeywell'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('CAT', 'Caterpillar Inc.', 'Caterpillar', null, null, 'industrials', 'Machinery', array['Caterpillar Inc'], array['Caterpillar'], array['equipment', 'machinery', 'bulldozers', 'excavators', 'construction', 'mining'], array['butterfly', 'butterflies', 'moth', 'moths', 'larvae'], false),
  ('DE', 'Deere & Co.', 'John Deere', null, null, 'industrials', 'Machinery', array['John Deere', 'Deere'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('GE', 'GE Aerospace', 'GE Aerospace', null, null, 'industrials', 'Aerospace', array['GE Aerospace', 'General Electric'], array['GE'], array['jet engines', 'engines', 'aerospace', 'Larry Culp'], array['GE Vernova', 'GE HealthCare', 'GE Appliances'], false),
  ('MMM', '3M Co.', '3M', null, null, 'industrials', 'Conglomerates', array['3M'], '{}'::text[], '{}'::text[], array['$3M', '3M users', '3M people', '3M customers', '3M subscribers', '3M views'], false),
  ('UPS', 'United Parcel Service', 'UPS', '0001090727', 'NYSE', 'industrials', 'Shipping', array['UPS', 'United Parcel Service'], '{}'::text[], '{}'::text[], '{}'::text[], false),
  ('FDX', 'FedEx Corp.', 'FedEx', '0001048911', 'NYSE', 'industrials', 'Shipping', array['FedEx'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('XOM', 'Exxon Mobil Corp.', 'Exxon', '0002115436', 'NYSE', 'energy', 'Oil & gas', array['Exxon', 'ExxonMobil', 'Exxon Mobil'], '{}'::text[], '{}'::text[], '{}'::text[], true),
  ('CVX', 'Chevron Corp.', 'Chevron', '0000093410', 'NYSE', 'energy', 'Oil & gas', array['Chevron'], '{}'::text[], '{}'::text[], array['Chevron deference', 'Chevron doctrine', 'Chevron ruling', 'Chevron precedent'], true)
on conflict (ticker) do update set
  name = excluded.name, short_name = excluded.short_name, cik = coalesce(excluded.cik, core.companies.cik),
  exchange = coalesce(excluded.exchange, core.companies.exchange), sector = excluded.sector, industry = excluded.industry,
  aliases = excluded.aliases, context_aliases = excluded.context_aliases, cues = excluded.cues, negatives = excluded.negatives,
  ticker_in_text = excluded.ticker_in_text, updated_at = now();
-- END GENERATED COMPANY SEED

-- ---------- D. tagging -------------------------------------------------------------------------

-- Companies a text is about, strongest first. Same evidence order and confidences as matchCompanies().
create or replace function core.match_companies(p_text text, p_tickers text[] default '{}', p_filing boolean default false)
returns table (ticker text, method text, confidence numeric)
language sql stable set search_path = '' as $$
  with f as (
    select t.x, t.x ~* core.company_biz_re() as biz, coalesce(p_tickers, '{}'::text[]) as tk
    from (select translate(coalesce(p_text, ''), '’‘', '''''') as x) t),
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

-- Re-tags one card: deletes its tags and writes the kept ones. Returns how many were kept.
create or replace function core.tag_card(p_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_min numeric := coalesce((select value from core.company_params where key = 'tag_min_confidence'), 0.60);
  v_max int     := coalesce((select value from core.company_params where key = 'tag_max_per_card'), 3)::int;
  v_n   int;
begin
  delete from core.card_companies where blurb_id = p_id;
  insert into core.card_companies (blurb_id, ticker, method, confidence, sort_at)
  select b.id, m.ticker, m.method, m.confidence, b.sort_at
  from core.blurbs b
  cross join lateral core.match_companies(
    b.headline || ' ' || coalesce(b.body, ''),
    coalesce((select array_agg(upper(t ->> 'symbol')) from jsonb_array_elements(b.tickers) t where coalesce(t ->> 'symbol', '') <> ''), '{}'::text[]),
    exists (select 1 from core.blurb_sources s where s.blurb_id = b.id and s.kind = 'filing' and s.is_primary)) m
  where b.id = p_id and m.confidence >= v_min
  order by m.confidence desc, m.ticker collate "C"
  limit v_max;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function core.blurbs_tag_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.tag_card(new.id);
  return null;
end $$;

-- The filing source is written after the card (api.publish_blurb), so it re-tags with method 'filing'.
create or replace function core.blurb_sources_tag_trg()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.tag_card(new.blurb_id);
  return null;
end $$;

drop trigger if exists blurbs_tag_companies on core.blurbs;
create trigger blurbs_tag_companies after insert or update of headline, body, tickers, sort_at on core.blurbs
  for each row execute function core.blurbs_tag_trg();
drop trigger if exists blurb_sources_tag_companies on core.blurb_sources;
create trigger blurb_sources_tag_companies after insert on core.blurb_sources
  for each row when (new.kind = 'filing' and new.is_primary) execute function core.blurb_sources_tag_trg();

-- Re-tags cards with sort_at >= p_since, newest first, at most p_limit. Idempotent. Returns cards touched.
create or replace function core.retag_cards(p_since timestamptz, p_limit int default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_cap int := least(coalesce(p_limit, 2147483647), coalesce((select value from core.company_params where key = 'retag_max_cards'), 20000)::int);
  v_id uuid; v_n int := 0;
begin
  for v_id in select b.id from core.blurbs b where b.sort_at >= p_since order by b.sort_at desc, b.id desc limit v_cap loop
    perform core.tag_card(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------- E. api -----------------------------------------------------------------------------
-- How well a query names each company (companyQueryScore): ticker 1, exact name/alias 0.95,
-- prefix (2+ chars) 0.8, typo 0.4 + 0.35 x similarity (4+ chars, similarity >= search_fuzzy_min).
-- Hook for api.search (owned by search v5): join core.card_companies on ticker where score >= 0.95
-- to rank a company's own cards above plain text matches.
create or replace function core.company_query_scores(p_q text)
returns table (ticker text, score numeric, match text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_raw  text := regexp_replace(left(btrim(coalesce(p_q, '')), 80), '^\$', '');
  v_norm text := core.company_norm(v_raw);
  v_up   text := upper(v_raw);
  v_tri  text[];
  v_fz   numeric := coalesce((select value from core.company_params where key = 'search_fuzzy_min'), 0.35);
begin
  if v_norm = '' then return; end if;
  v_tri := case when length(v_norm) >= 4 then core.trigrams(v_norm) else '{}'::text[] end;
  return query
  with s as (
    select c.ticker,
      case
        when c.ticker = v_up or replace(c.ticker, '-', '.') = v_up then 1.0
        when v_norm = any(c.search_terms) then 0.95
        when length(v_norm) >= 2 and exists (select 1 from unnest(c.search_terms) t where left(t, length(v_norm)) = v_norm) then 0.8
        else 0 end::numeric as direct,
      case when cardinality(v_tri) > 0 and c.trigrams && v_tri
           then (select coalesce(max(core.trigram_sim(core.trigrams(t), v_tri)), 0) from unnest(c.search_terms) t) else 0 end::numeric as sim
    from core.companies c
    where c.enabled)
  select s.ticker,
         case when s.direct > 0 then s.direct else round(0.4 + 0.35 * s.sim, 3) end,
         case when s.direct = 1.0 then 'ticker' when s.direct = 0.95 then 'name' when s.direct = 0.8 then 'prefix' else 'typo' end
  from s
  where s.direct > 0 or s.sim >= v_fz;
end $$;

-- A card counts when the feed would show it (published, live, link-out flag, has a source).
create or replace function core.company_card_visible(p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.blurbs b join core.app_config cfg on cfg.id
    where b.id = p_id and b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or cfg.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id))
$$;

-- Public row of a company (no regexes, no aliases).
create or replace function core.company_json(c core.companies, p_count bigint, p_days int)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('ticker', c.ticker, 'name', c.name, 'short_name', c.short_name, 'exchange', c.exchange,
                            'sector', c.sector, 'industry', c.industry, 'card_count', coalesce(p_count, 0), 'days', p_days)
$$;

-- Companies a query names, best first: [{ticker, name, short_name, exchange, sector, industry, card_count, days, score, match}].
create or replace function api.search_companies(p_q text, p_limit int default 5)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lim  int := least(greatest(coalesce(p_limit, 5), 1), coalesce((select value from core.company_params where key = 'search_max'), 10)::int);
  v_days int := coalesce((select value from core.company_params where key = 'recent_days'), 30)::int;
begin
  -- Counting is the only per-company work, so it runs for at most 3 x limit candidates.
  return coalesce((
    select jsonb_agg(core.company_json(c, x.n, v_days) || jsonb_build_object('score', x.score, 'match', x.match)
                     order by x.score desc, x.n desc, x.ticker collate "C")
    from (
      select q.ticker, q.score, q.match,
             (select count(*) from core.card_companies cc
               where cc.ticker = q.ticker and cc.sort_at >= now() - make_interval(days => v_days)
                 and core.company_card_visible(cc.blurb_id)) as n
      from (select * from core.company_query_scores(p_q) q0 order by q0.score desc, q0.ticker collate "C" limit v_lim * 3) q
      order by q.score desc, n desc, q.ticker collate "C"
      limit v_lim) x
    join core.companies c on c.ticker = x.ticker), '[]'::jsonb);
end $$;

-- A company's cards, newest first, keyset paged: {company, items, next_cursor}. Unknown ticker -> company null.
-- Cursor 'sort_at|id' (opaque to the app); a malformed cursor raises invalid_cursor (HTTP 400).
create or replace function api.company_cards(p_ticker text, p_cursor text default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_t    text := upper(btrim(coalesce(p_ticker, '')));
  v_lim  int  := least(greatest(coalesce(p_limit, 20), 1), coalesce((select value from core.company_params where key = 'cards_page_max'), 30)::int);
  v_days int  := coalesce((select value from core.company_params where key = 'recent_days'), 30)::int;
  v_sort timestamptz; v_id uuid;
  v_rows record; v_ids uuid[] := '{}'; v_more boolean := false; v_last_sort timestamptz; v_last_id uuid; v_i int := 0;
  v_company jsonb;
begin
  select core.company_json(c, (select count(*) from core.card_companies cc
                                where cc.ticker = c.ticker and cc.sort_at >= now() - make_interval(days => v_days)
                                  and core.company_card_visible(cc.blurb_id)), v_days)
    into v_company
  from core.companies c where c.ticker = v_t and c.enabled;
  if v_company is null then
    return jsonb_build_object('company', null, 'items', '[]'::jsonb, 'next_cursor', null);
  end if;
  if p_cursor is not null then
    begin
      v_sort := split_part(p_cursor, '|', 1)::timestamptz;
      v_id   := split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_cursor' using errcode = '22023';
    end;
    if v_sort is null or v_id is null then raise exception 'invalid_cursor' using errcode = '22023'; end if;
  end if;
  for v_rows in
    select cc.blurb_id, cc.sort_at
    from core.card_companies cc
    join core.blurbs b on b.id = cc.blurb_id
    join core.app_config cfg on cfg.id
    where cc.ticker = v_t
      and (p_cursor is null or (cc.sort_at, cc.blurb_id) < (v_sort, v_id))
      and b.status = 'published' and b.published_at <= now()
      and (b.kind <> 'link_out' or cfg.linkout_cards)
      and exists (select 1 from core.blurb_sources s where s.blurb_id = b.id)
    order by cc.sort_at desc, cc.blurb_id desc
    limit v_lim + 1
  loop
    v_i := v_i + 1;
    if v_i > v_lim then v_more := true; exit; end if;
    v_ids := v_ids || v_rows.blurb_id;
    v_last_sort := v_rows.sort_at; v_last_id := v_rows.blurb_id;
  end loop;
  return jsonb_build_object(
    'company', v_company,
    'items', core.cards_json(v_ids, auth.uid()),
    'next_cursor', case when v_more then v_last_sort::text || '|' || v_last_id::text end);
end $$;

-- Every enabled company with its recent card count: [{ticker, name, short_name, exchange, sector, industry,
-- card_count, days, last_card_at}], sector then most cards first. Bounded: one pass over the recent window.
create or replace function api.companies_directory(p_days int default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select least(greatest(coalesce(p_days, (select value from core.company_params where key = 'recent_days')::int, 30), 1), 365) as days),
  n as (
    select cc.ticker, count(*) as n, max(cc.sort_at) as last_at
    from core.card_companies cc cross join d
    where cc.sort_at >= now() - make_interval(days => d.days) and core.company_card_visible(cc.blurb_id)
    group by cc.ticker)
  select coalesce(jsonb_agg(core.company_json(c, n.n, d.days) || jsonb_build_object('last_card_at', n.last_at)
                            order by c.sector, coalesce(n.n, 0) desc, c.short_name collate "C"), '[]'::jsonb)
  from core.companies c cross join d left join n on n.ticker = c.ticker
  where c.enabled
$$;

-- Company tags of up to batch_ids_max cards (for the "About: Apple" chip): [{id, companies:[{ticker, short_name,
-- name, confidence}]}]. Cards without tags, hidden cards and unknown ids are left out.
create or replace function api.card_companies(p_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
  with ids as (
    select distinct u.id from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality u(id, ord)
    where u.ord <= coalesce((select value from core.company_params where key = 'batch_ids_max'), 50))
  select coalesce(jsonb_agg(jsonb_build_object('id', x.blurb_id, 'companies', x.companies) order by x.blurb_id), '[]'::jsonb)
  from (
    select cc.blurb_id,
           jsonb_agg(jsonb_build_object('ticker', c.ticker, 'short_name', c.short_name, 'name', c.name, 'confidence', cc.confidence)
                     order by cc.confidence desc, c.ticker collate "C") as companies
    from ids join core.card_companies cc on cc.blurb_id = ids.id
    join core.companies c on c.ticker = cc.ticker and c.enabled
    join core.blurbs b on b.id = cc.blurb_id and b.status = 'published'
    group by cc.blurb_id) x
$$;

-- Service role: re-tag the last p_days of cards after the directory changes. Returns {retagged}.
create or replace function api.retag_companies(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object('retagged', core.retag_cards(now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 3650))));
end $$;

revoke all on function core.company_norm(text), core.company_re_escape(text), core.company_alt(text[]), core.trigrams(text),
  core.trigram_sim(text[], text[]), core.match_companies(text, text[], boolean), core.tag_card(uuid), core.retag_cards(timestamptz, int),
  core.company_query_scores(text), core.company_card_visible(uuid), core.company_json(core.companies, bigint, int)
  from public, anon, authenticated;
revoke all on function api.search_companies(text, int), api.company_cards(text, text, int), api.companies_directory(int),
  api.card_companies(uuid[]), api.retag_companies(int) from public;
grant execute on function api.search_companies(text, int), api.company_cards(text, text, int), api.companies_directory(int),
  api.card_companies(uuid[]) to anon, authenticated, service_role;
grant execute on function api.retag_companies(int) to service_role;

-- ---------- F. backfill ------------------------------------------------------------------------
revoke all on function core.company_biz_re() from public, anon, authenticated;

-- Backfill: tag the last year of existing cards (idempotent; safe to re-run).
do $$ begin perform core.retag_cards(now() - interval '365 days'); end $$;
