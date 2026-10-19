# ingest/

The ingest script runs on a laptop (Node 22.18 or newer, no dependencies). Each run collects public filings, releases and economic numbers, turns them into short cards, checks every card, and writes it to Supabase.

## What one run does

1. **Macro numbers** (`src/sources/macro.ts`): fetches FRED observations for 12 series: DGS2, DGS10, DFF, CPIAUCSL, UNRATE, DCOILWTICO (daily or monthly), GASREGW and ICSA (weekly), RSAFS, HOUST and PAYEMS (monthly) and A191RL1Q225SBEA (real GDP growth, quarterly). It formats them ("4.02%", "+0.06 pts", "$4.33", "199,000", "$745.0B", CPI as a year-over-year rate) and stores them with `api.upsert_macro`. A **data card** is published only for a new observation that moved enough: yields and the fed funds rate by 0.05 points or more, oil by 2%, gas by 1%, jobless claims by 5%. Monthly and quarterly series get one card per new period. Weekly cards say "week of" / "week ending" and "prior week"; quarterly cards say "Q2 2026" and "prior quarter". Data cards are templates (no AI) and cite the original agency. MORTGAGE30US (Freddie Mac copyright) is on a forbidden list and is refused. The numbers panel in the app shows a top set of 8 (column `in_numbers` in `core.macro_series`).
2. **Federal Reserve** (`src/sources/fed.ts`): reads the press-release RSS feeds (monetary policy + all releases), drops anything older than 7 days, and fetches each release page from `www.federalreserve.gov`.
3. **BEA** (`src/sources/bea.ts`): reads the U.S. Bureau of Economic Analysis news-release RSS from `apps.bea.gov` (an API host, not a page host) and keeps releases from the last 30 days. Only the feed's own title and description are summarized; BEA pages are never downloaded. Cards are public domain, category `economy`, event type `macro_release`, and carry "Source: U.S. Bureau of Economic Analysis".
4. **Federal Register** (`src/sources/fedreg.ts`): one JSON query to the Federal Register documents API (no key): final rules from agencies whose rules reach people's wallets (CFPB, Transportation, FTC, IRS, Treasury, the Fed, SEC, FCC, Energy, Education). The "significant rules from any agency" query is off (`config.fedRegister.significantQuery = false`). Federal Register cards are only published when the AI scores them 3 or more for everyday relevance; there are no template Federal Register cards. Results are merged on `document_number` and kept for 14 days. The AI sees only each document's `abstract`; a document without one (corrections, for example) is skipped and logged. No page is downloaded (`www.federalregister.gov` is on the API host list only). The card headline is written by the AI (or, for a template card, is the title cut to 90 characters); the source link is the document's `html_url`; future-dated (scheduled) issues get today's time; category `policy`, event type empty (ranking default). Credit line: "Source: Federal Register (National Archives), <agency>". Copy limit 25 words. Poll at most hourly (no published rate limit). **FAA airworthiness directives** (title contains "Airworthiness Directive(s)", `isAirworthinessDirective`) are near-identical aircraft fix orders: at most `config.fedRegister.maxAirworthinessPerRun` (1) **new** one becomes a card per run (newest first; a directive an earlier run already handled does not use up the cap); the others are skipped and logged `skip faa_directive_cap`. `src/ranking.ts` (the TypeScript mirror of the database ranking formula) also caps such a card's importance at `config.ranking.airworthinessImportance` (1.5, instead of 2 x 1.25 = 2.5); the real database formula would need the same change in a migration (not part of this folder).
5. **SEC 8-K** (`src/sources/sec.ts`): only for about 150 household-name companies (`config.watchCompanies`, by ticker; CIKs resolved from SEC's ticker list, a ticker missing from the list is logged and skipped; without the list the SEC source is skipped for that run). Filings come from the current 8-K Atom feed plus each watched company's filing list (`https://data.sec.gov/submissions/CIK##########.json`, API host list, last `config.secLookbackDays` = 10 days), merged on accession number. It keeps original 8-Ks (not amendments) with at least one watch item (`config.watchItems`: 1.01, 1.03, 1.05, 2.01, 2.02, 2.05, 4.02, 5.02). A filing whose only watch item is 5.02 is skipped as `routine_5.02` unless one sentence of its Item 5.02 text names the CEO, CFO, chair or president together with a change word (resigns, retires, appointed, steps down, successor, ...); director-only changes, committee seats and pay plans are routine. Item 2.05 (layoffs, restructuring) is category markets with the default rank weight. Filings whose items are only 7.01, 8.01 and 9.01 (Reg FD, other events, exhibits) are skipped before any page fetch or AI call and counted as `skipped` (`config.sec8kLowValueItems`). It then fetches the filing index and the primary document. **Earnings press release (EX-99.1):** an Item 2.02 8-K is usually a cover page; the figures sit in the EX-99.1 exhibit. For a filing with an item in `config.secExhibit.items` (2.02) the script also fetches the exhibit named EX-99.1 (then EX-99.01, then EX-99; `config.secExhibit.types`) from the filing index (`src/sec-text.ts`, `findExhibitUrl` in `src/sources/sec.ts`). It is a `www.sec.gov` /Archives/ page, so it goes through the same allowlist, rate limiter and cache as every other page. Its text (capped at `config.sourceTextMaxChars` like the primary document) goes to the AI first, followed by at most `config.secExhibit.primaryMaxChars` (3,000) characters of the primary document. If there is no EX-99.1 or it cannot be fetched, a line is logged and the primary document alone is used. Other exhibits are not followed.
   - **Category and event type come from the item numbers, in code:** 2.02, 4.01, 4.02 → earnings / earnings; 1.01, 1.02, 2.01 → deals / deal; 5.02 → markets / exec_change; 1.05 (cyber incident) → tech / none; 1.03 (bankruptcy) and 3.01 (delisting notice) → markets / none. When several apply, the order is 1.03, 2.02, 4.02, 4.01, 1.05, 2.01, 5.02, 1.01, 1.02, 3.01. Only when no item decides (for example 2.05 or 2.06 alone) is the AI's choice used, limited to the 9 categories and the event types earnings, deal, exec_change, insider.
5b. **Broad topics** (feed or API text only; hosts on the API list, never pages; category and event type fixed in code; the AI's category is ignored):
   - **Wikipedia "In the news"** (`src/sources/wiki.ts`, `--only wiki`) -> World. The featured feed of the last `config.wiki.lookbackDays` (1) UTC days, today first (`wikiFeedUrl(now, daysBack)`; default 1 = today only, because live runs showed past-day feeds carry 0 news; setting 2 or 3 reads earlier days too), from `en.wikipedia.org` through the same allowlisted API fetch and parser. A missing `news` key (a past day may have none) = no items; a day whose request fails is logged (`wiki: feed for <date> failed`) and the other days still run. A story that appears on several days is kept once (same `external_id` = story text + link, or same article URL; the newest day wins); a story with no `<!--Mon DD-->` comment is dated to its feed day. The run logs one line with the stories and new-to-this-run count per day. The AI sees the story sentence plus the first linked article's plain-text extract (max 1,500 chars); thumbnails are never read. Source link = that article; license `cc_by_sa`; card and source attribution `Adapted from Wikipedia ("<title>") · CC BY-SA 4.0`; 10-word copy limit. The request carries a Wikimedia-format User-Agent (`Element/0.1 (<contact>) node-fetch`), the contact taken from `SEC_USER_AGENT`.
   - **CPSC recalls** (`src/sources/cpsc.ts`, `--only cpsc`) -> Recalls & Safety, event `recall`. saferproducts.gov JSON, last 14 days, newest first. **The cap of 5 (`config.cpsc.maxPerRun`) counts only NEW recalls**: every recall in the window is a candidate, `processItems` records each (`api.upsert_item`) and skips the ones an earlier run already handled without counting them, and stops after 5 new ones (`limits.total`; the rest are not even recorded). So each run moves on to the next unprocessed recalls instead of re-picking the 5 newest. A new recall that the relevance gate drops (item closed as `skipped`) still counts as processed; one left `new` (no AI available) is retried and counts again. The AI sees Title, Description, Hazards and Remedies; source link = the recall URL in the JSON; credit "Source: U.S. Consumer Product Safety Commission". License partly verified (US government work).
   - **USGS significant earthquakes** (`src/sources/usgs.ts`, `--only usgs`) -> Science & Space, event `science`. Template card, no AI: headline = a plain "Magnitude 5.7 earthquake hits Pakistan", body = magnitude, broad place and alert level (and an ocean-region note). Source link = the event page; credit "Credit: U.S. Geological Survey". **Publishing threshold:** yellow, orange and red PAGER alerts always publish. A quake whose alert is green or missing is skipped (`skip low_interest (<reason>)`, counted as skipped) when it is at sea / on an ocean ridge or rise / has no country in its place name (no comma, or a ridge, rise, ocean, sea, trench word: `config.usgs.atSeaPattern`), or when its magnitude is under `config.usgs.minMagnitudeWithoutAlert` (6.5).
   - **NASA news releases** (`src/sources/nasa.ts`, `--only nasa`) -> Science & Space. RSS; only links under `https://www.nasa.gov/news-release/` (APOD, image articles, blog posts and podcasts dropped). **Why only 1 of 10 feed items counted (2026-10-17):** the filter is correct. The feed returns just its 10 newest posts and mixes in APOD and image articles, so a quiet few days leave one news release. The run reads `config.nasa.feedPages` (1) pages (default 1 = page 1 only, because live runs showed `?paged=2` answers HTTP 403; the multi-page code stays: page 2 = the feed URL plus `?paged=2`, same allowlisted host; with feedPages 2 a failing older page is logged and skipped; pages can overlap and are deduplicated by link) and keeps releases from the last `config.nasa.maxAgeDays` (14, was 7) days. The log line `nasa: N feed items over 1 page(s), ...` shows how many pages were read. The AI sees the release text from the feed with figures and captions removed. Credit "Source: NASA".
   Wikipedia, CPSC and NASA cards need the AI (relevance gate applies); their template cards are not published.
6. For each news item, in order:
   1. Duplicate and burst guard (`src/dedupe.ts`): same URL means skip; at most 3 cards per ticker within 24 hours.
   2. `api.upsert_item` records the item; items handled in an earlier run are skipped. **Per-run caps count only new items** (`NewLimits` in `src/pipeline.ts`): an item an earlier run already handled never uses up a cap, so every run moves on to the next unprocessed item. Used by CPSC (5 new recalls) and the FAA airworthiness cap; the run-wide `--limit` budget was already new-only (it is spent after this check).
   3. Summarizer chain (`src/summarizer/chain.ts`), order set by `config.providerOrder` = Gemini, Groq, template. The license check comes first: only public-domain and SEC filing text may be sent, to any provider.
      - **Gemini** (`src/summarizer/gemini.ts`, JSON output) is tried first. A card it writes must pass the validator; a rejected card is retried once with the validator's errors.
      - **Groq** (`src/summarizer/groq.ts`, OpenAI-compatible chat API, `openai/gpt-oss-120b`, JSON schema output) is used when Gemini's daily cap is reached, on a 429 or other HTTP error, on a timeout, when `GEMINI_API_KEY` is missing, or after both Gemini attempts were rejected. Same prompt, same validator, same one retry. Groq gets at most 6,000 characters of source text because its free tier is limited by tokens per minute.
      - **Template card** (`src/summarizer/template.ts`, no AI, built only from the feed's metadata, plain wording, `ai_generated = false`) if both fail or are capped. Template cards have no relevance score, so they are only published for Fed and BEA releases and for watch-list 8-Ks whose main item is 2.02, 5.02, 1.05, 4.02 or 2.05 (`config.templateSecItems`). Other items stay `new` and are retried on a later run with a working AI provider.
      - **Everyday relevance:** the AI also returns `everyday_relevance` (1 to 5: would a typical college student or young adult who does not invest notice or be affected?). Below `config.minEverydayRelevance` (3) the card is not published; the log says `skip low_relevance (n)` and the score is stored in `ingest.items.status_note`. The skip costs only that one AI call (no retry). The score is not part of the card.
      - **In-depth detail (prompt `sum-v3`):** the same AI call also writes `detail` (shown when a card is opened): 2-4 short paragraphs (at most 180 words together) and 3-5 key points (at most 15 words each). It is checked like the card (numbers in the source, no advice words, copy limit per license). If only the detail fails, the card is published with `detail` null. Template and data cards get a factual detail built from their own fields (`src/detail.ts`; data cards: value, change, previous value for rates, what the number measures, the agency).
      - **Writing style (prompt `sum-v2`, kept in `sum-v3` to `sum-v5`):** plain words at about an 8th-grade reading level, short sentences, no jargon (unavoidable terms explained in a few words); sentence 1 says what happened; the last sentence says why it matters to a regular person only if that follows from the source.
      - **Prompt `sum-v5` (2026-10-18):** (1) headlines in sentence case (capitalise only the first word and proper nouns); (2) never model numbers, SKUs, UPCs or lot numbers in the headline or body, key points only (the validator also rejects the outright words "SKU", "UPC", "model number", "lot number" there); (3) an earnings card must state the real figures from the source and never describe the filing itself (exhibits, press release, conference call, links). Template version `tpl-v5`: sentence-case Fed/BEA template headlines (`src/text.ts` `sentenceCase`, which only lowercases a list of everyday words, so names, tickers and acronyms keep their capitals) and a generic CPSC template (no title, so no product codes). The version bump makes `--rewrite` revisit every card written with an older version.
      - **Prompt `sum-v6` (2026-10-18, flow and no repetition, D-58):** the headline and the summary read as one piece. Body sentence 1 continues from the headline and adds the next most useful fact (it never restates the headline); every sentence adds something new; no repeated phrases; no filler ("This means that...", "In summary..."); the detail key points do not copy the summary sentences. The prompt (shared by Gemini and Groq, `buildPrompt` in `src/summarizer/gemini.ts`) carries one bad and one good example. The validator enforces it for AI drafts (`checkRepetition` in `src/validate.ts`, thresholds in `config.repetition`): the draft is rejected when (a) the first summary sentence starts with the headline, or at least 70% of the headline's content words (stop words, numbers and words under 3 letters ignored, light stemming) appear in it, or (b) two summary sentences are near-duplicates (70% of the shorter one's content words are in the other). A rejection goes through the usual retry once with the reason, then the template fallback. Template and data cards are exempt (the chain sets `checkFlow` only for AI drafts): their fixed wording, such as "X reports a change in its top leaders" / "X told the SEC about a change among its top leaders", would fail (a).

      - Each AI provider has its own daily cap and its own spacing between calls (Gemini 500/day, 5 s; Groq 80/day, 30 s). Spacing is `60 s / (RPM x rpmSafetyFactor)` with a 0.8 factor, so Gemini runs at 12 calls a minute, not its full 15. After a 429 the provider is skipped for 60 s for the rest of the run (`rateLimitCooldownMs`). If a draft fails only because the body is too long and the headline fits, the body is cut after the last whole sentence that fits and checked again; a headline that is too long is never cut. The card records the model that actually wrote it. A provider without a key is skipped (`src/summarizer/providers.ts`); the start-up line lists which ones are active.
   4. The validator (`src/validate.ts`) checks:
      - shape and length (headline 90 characters, body 60 words)
      - no advice language
      - every number and ticker must appear in the source text
      - the copy limit: at most 10 consecutive words from a filing, 25 from public-domain government text
      - **no_figures:** a card whose event type is earnings (in code, from the 8-K items) must have at least one digit in its body, or it is rejected with reason `no_figures` (retry with the error, then the next provider, then the template). For SEC filings it applies to filings with Item 2.02 (`config.earningsFigures.requiredItems`); a card from 4.01 (auditor change) or 4.02 (restatement notice) alone is exempt. The template fallback is held to the same rule: a figure-less earnings template card is skipped (`skip no_figures`; the item is closed as `skipped: no_figures` when an AI draft was tried, and stays `new` when no AI was available so a later run retries). A figure-less template earnings card is therefore never published.
      - no model numbers, SKUs, UPCs or lot numbers by name in the headline or body (`product codes in headline or body`)
   5. `api.publish_blurb` stores the card and its source link, then ranks it. The database repeats the duplicate, ticker-cap, source and license checks.
7. A summary line per card and a final count are printed.

Every outbound request goes through `src/allowlist.ts`:
- Full pages come only from `www.sec.gov`, `www.federalreserve.gov` and `www.bls.gov`.
- Data APIs are limited to FRED, Treasury, BEA's RSS host (`apps.bea.gov`), the Federal Register API (`www.federalregister.gov`), SEC's per-company filing lists (`data.sec.gov`, JSON only), Wikipedia's REST feed (`en.wikipedia.org`), CPSC (`www.saferproducts.gov`), USGS (`earthquake.usgs.gov`), NASA's RSS (`www.nasa.gov`), Gemini, Groq (`api.groq.com`) and the project's Supabase host. None of these is a page host.
- Redirects are re-checked at every hop. Only https is allowed, at about 5 requests per second, with a declared SEC User-Agent.
- Page responses are cached in `cache/` (git-ignored). API responses are not cached, since FRED puts its key in the URL.

## Commands

```sh
cd ingest
node -v                       # must be 22.18 or newer
npm test                      # offline tests (fixtures only, no network, no keys)
npm run dry-run               # whole pipeline on fixtures; prints the cards it would publish
node src/main.ts --dry-run --json          # same, plus the card payloads as JSON
npm run ingest                # one live run (needs .env)
node src/main.ts --once --only sec --limit 3
node src/main.ts --dry-run --only bea   # BEA releases from the fixture
npm run ingest:loop           # every 10 minutes until Ctrl+C
```

`--rewrite` redoes published cards written with an older prompt or template version, in place (same card id, category, sources and feed position; revision + 1 and `updated_at` set). It lists them with `api.blurbs_to_revise` and updates them with `api.revise_blurb` (both service-role only, migration `20261017050000_detail_revise.sql`). AI cards are re-summarized from the same licensed text (re-fetched through the same allowlisted paths) through the same chain, validator and relevance gate: relevance below 3 hides the card, and a card with no valid new draft stays unchanged. Template and data cards are rebuilt with the current plain templates (no AI). A card that would no longer be published is **hidden** instead of kept: an earnings card with no figures (`no_figures`; for an AI card, when the new draft has none and the old body had none either) and a published earthquake that now falls under the low-interest threshold (`low_interest`). Recall (CPSC, looked up over `config.cpsc.rewriteLookbackDays` = 120 days) and NASA cards can be rewritten too; Wikipedia stories leave the feed after a day, so they are kept. SEC earnings cards re-read the EX-99.1 exhibit. `--limit N` caps the cards per run. `--rewrite --dry-run` works on `src/fixtures/rewrite-cards.json`.

Options: `--dry-run`, `--once` (default), `--loop`, `--rewrite`, `--only sec,fed,bea,fedreg,macro,wiki,cpsc,usgs,nasa`, `--limit N` (max news items summarized per run, default 20), `--json` (dry run only).

## Inputs

Environment variables, read from `.env` in this folder or the repo root (git-ignored):

| Name | Needed for |
|---|---|
| `SUPABASE_URL` | all live runs; the script refuses to start if it is missing or a placeholder |
| `SUPABASE_SERVICE_ROLE_KEY` | all live runs. Supabase now calls this the **secret** key; the old name is kept |
| `SEC_USER_AGENT` | all live runs: `"<app name> <contact email>"`. Its email (or the whole value) is also the contact in the Wikimedia User-Agent for Wikipedia requests |
| `GEMINI_API_KEY` | AI cards, primary provider (without it Groq is used, or a template card if Groq has no key either) |
| `GROQ_API_KEY` | optional AI fallback (skipped without it) |
| `FRED_API_KEY` | macro numbers (skipped without it) |

Keys are never printed (`[set]` / `[missing]` only), never put in URLs except where FRED requires it, and never written to the cache.

## Outputs

- Rows in Supabase through the service-role RPCs `api.upsert_item`, `api.set_item_status`, `api.publish_blurb`, `api.upsert_macro`, `api.refresh_trending` and then `api.ml_purge` (end of each run; the purge removes old ML shadow-log rows and applies the storage stop rule, and a failure only logs a warning), and for `--rewrite` `api.blurbs_to_revise` / `api.revise_blurb`.
- `state/ai-usage.json`: AI calls per provider for the current UTC day. Gemini's daily cap is `min(600, free requests per day)` = 500; Groq's is `min(80, requests per day, tokens per day / estimated tokens per call)` = 80 (`src/config.ts`).
- `cache/`: cached page responses.

## Files

| Path | Purpose |
|---|---|
| `src/config.ts` | every tunable value (models, caps, pacing, limits, hosts, watch list) + environment check |
| `src/main.ts` | command line (`--dry-run`, `--once`, `--loop`, `--rewrite`, `--only`, `--limit`, `--json`), live and dry-run wiring, end-of-run Trending refresh |
| `src/pipeline.ts` | one run (sources, guards, summarize, publish) with injected I/O |
| `src/allowlist.ts` | the only way to make an outbound request (host lists, https only, redirect re-check, rate limit, cache) |
| `src/rewrite.ts` | `--rewrite`: redoes older published cards in place |
| `src/detail.ts` | factual in-depth detail for template and data cards (no AI) |
| `src/sec-text.ts` | SEC 8-K page text for the AI: primary document plus the EX-99.1 press release for Item 2.02 filings |
| `src/text.ts` | `sentenceCase` (headlines) and `mentionsProductCodes` (validator) |
| `src/types.ts` | internal pipeline types (the public card shape is in `contract/types.ts`) |
| `src/sources/sec.ts` | SEC 8-K feed and watch-company filing lists, item classification |
| `src/sources/fed.ts` | Federal Reserve press-release RSS and release pages |
| `src/sources/bea.ts` | BEA news-release RSS (feed text only) |
| `src/sources/fedreg.ts` | Federal Register final rules (abstract only) |
| `src/sources/macro.ts` | FRED series, number formatting, data cards (also a Treasury CSV parser, not used by the live run) |
| `src/sources/wiki.ts` | Wikipedia "In the news" (CC BY-SA, attribution on every card) |
| `src/sources/cpsc.ts` | CPSC product recalls |
| `src/sources/usgs.ts` | USGS significant earthquakes (template cards) |
| `src/sources/nasa.ts` | NASA news releases (RSS, news-release links only) |
| `src/summarizer/chain.ts` | license check, then Gemini, Groq, template; daily caps, pacing, retry, relevance gate |
| `src/summarizer/gemini.ts`, `groq.ts` | the two AI adapters (same prompt, keys in headers only) |
| `src/summarizer/template.ts` | card built from metadata, no AI |
| `src/summarizer/providers.ts` | builds the provider list, skips one whose key is missing |
| `src/validate.ts` | draft checks and publish checks (shape, advice words, numbers, copy limit, license, source link) |
| `src/dedupe.ts` | URL duplicate and per-ticker cap |
| `src/publish.ts` | PostgREST client for the service-role RPCs, dry-run publisher, payload builder |
| `src/ranking.ts` | copy of the database importance and decay formula (tests only) |
| `src/html.ts` | small HTML/XML helpers |
| `src/fixtures/` | labeled sample inputs (REAL / RECONSTRUCTED / SYNTHETIC), see its `README.md` |
| `test/*.test.ts` | `node:test` files, run offline by `npm test`: `allowlist`, `audit-fixes`, `broad-sources`, `cli`, `config`, `contract`, `dedupe`, `fedreg`, `groq`, `macro-bea`, `new-items-only`, `pacing-length`, `publish`, `ranking`, `rewrite-detail`, `sec-classify`, `sources`, `summarizer`, `trending-refresh`, `validate`, `watchlist-relevance` |
| `package.json`, `tsconfig.json`, `.gitignore` | scripts (`test`, `dry-run`, `ingest`, `ingest:loop`), Node 22.18+ engine, type-check config; `cache/`, `state/` and `.env` are git-ignored |
| `README.md` | short overview and command list for this folder |

## Quality-rule settings (audit fixes, 2026-10-18)

| Config value (`src/config.ts`) | Default | Meaning |
|---|---|---|
| `promptVersion` / `templateVersion` | `sum-v6` / `tpl-v5` | stored on each card; `--rewrite` redoes cards on any other version |
| `repetition.*` | 3 / 0.7 / 3 / 0.7 / 3 | flow check on AI drafts: `minWordLength`, `headlineOverlapMax`, `minHeadlineWords`, `sentenceOverlapMax`, `minSentenceWords` |
| `secExhibit.items` | `['2.02']` | 8-K items whose EX-99.1 press release is fetched for the AI |
| `secExhibit.types` | `['EX-99.1','EX-99.01','EX-99']` | exhibit types, in order of preference |
| `secExhibit.primaryMaxChars` | `3000` | primary-document text kept after the exhibit |
| `earningsFigures.requiredItems` | `['2.02']` | SEC items whose earnings card must have a digit in the body (`no_figures`) |
| `fedRegister.maxAirworthinessPerRun` | `1` | FAA airworthiness directives allowed as candidates per run |
| `ranking.airworthinessImportance` | `1.5` | importance cap for such a card in the `src/ranking.ts` mirror |
| `usgs.keepAlerts` | `['yellow','orange','red']` | PAGER alerts that always publish |
| `usgs.minMagnitudeWithoutAlert` | `6.5` | green/missing-alert quakes below this are skipped |
| `usgs.atSeaPattern` | ridge, rise, ocean, sea, trench, seamount, fracture zone | place words that mean open water (no comma = no country is also at sea) |
| `cpsc.rewriteLookbackDays` | `120` | how far back `--rewrite` looks to find an old recall again |
| `cpsc.maxPerRun` | `5` | NEW recalls processed per run (recalls an earlier run handled do not count) |
| `cpsc.lookbackDays` | `14` | recalls considered, newest first |
| `wiki.lookbackDays` | `3` | UTC days of "In the news" feeds read per run, today included (stories deduplicated across days) |
| `nasa.maxAgeDays` | `14` | news releases newer than this are candidates (was 7) |
| `nasa.feedPages` | `2` | feed pages read per run (page 2 = `?paged=2`); a failing older page is skipped |

## Known limits

- Feeds are parsed with regular expressions sized for these sources. A layout change at the SEC or Fed can break parsing; tests and the dry run show it.
- Most 8-K primary documents are thin cover pages, so many SEC cards will be template cards. That is intended: they stay truthful.
- The SEC ticker-list layout and the Gemini and Groq request/response fields follow the official docs but were not checked against a live response. If Groq rejects the JSON schema mode with HTTP 400, the adapter retries that call once in plain JSON mode.
- Groq pacing (30 s between calls) means a run where Gemini is down entirely takes about 10 minutes for 20 items.
