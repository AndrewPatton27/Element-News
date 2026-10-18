# ingest

A TypeScript script run from a laptop. It fetches public filings and releases (SEC 8-K, Federal Reserve press releases, BEA news releases, Federal Register final rules, Wikipedia "In the news", CPSC recalls, USGS significant earthquakes, NASA news releases, FRED and Treasury numbers), turns them into short cards, checks every card, and publishes it to Supabase.

**Status:** complete for the hackathon scope and tested offline (`npm test`, `npm run dry-run`). The Federal Register source has not been run live yet (its fixtures are real API responses). Full description: `ingest.md`.

## Requirements

Run `node -v` first. If it is below 22.18, install Node 24 LTS. There are no runtime dependencies, so `npm install` is not needed. TypeScript runs directly on Node (type stripping), so the code uses only erasable syntax and `.ts` import extensions.

## Commands

```sh
cd ingest
npm test                  # offline tests, no network, no keys
npm run dry-run           # whole pipeline on fixtures, publishes nothing
npm run ingest            # one live run (needs .env)
node src/main.ts --once --only sec --limit 3
node src/main.ts --dry-run --only bea   # sources: sec, fed, bea, fedreg, macro, wiki, cpsc, usgs, nasa
node src/main.ts --rewrite --limit 20   # redo older published cards in plain words, in place (needs migration 20261017050000)
node src/main.ts --dry-run --rewrite    # the same on sample cards, no network
node src/main.ts --backfill-macro --weeks 16   # one-off: FRED history so the Trends charts have ~12 points (needs FRED_API_KEY; no new cards; safe to re-run)
```

## Environment variables

Put these in a git-ignored `.env` file. Never commit real values.

| Name | What |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase now calls this the **secret** key (the other one is the "publishable" key). The secret key goes in this variable; the name is kept for consistency. Script only, never in app code. |
| `GEMINI_API_KEY` | Google AI Studio key (free tier, no billing). Primary summarizer. |
| `GROQ_API_KEY` | Optional. Groq key (free tier, no billing). Fallback summarizer when Gemini is at its daily cap, rate limited, failing, timing out or has no key. Without it, the fallback is the template card. |
| `FRED_API_KEY` | FRED API key |
| `SEC_USER_AGENT` | `"<app name> <contact email>"`, required by the SEC. The contact is also used in the Wikimedia User-Agent for Wikipedia requests |

The script refuses to start if `SUPABASE_URL` is missing or still a placeholder, and it never prints a key (only `[set]` / `[missing]`).

## Files

| File | What it does |
|---|---|
| `src/config.ts` | Every tunable value: model IDs, provider order (Gemini, Groq, template), per-provider daily caps and pacing, card limits, copy limits, advice blocklist, ticker cap, allowed hosts, feed URLs, poll interval. Also reads and checks the environment. |
| `src/allowlist.ts` | `fetchAllowed()`: every outbound request goes through it. Full pages only from `www.sec.gov`, `www.federalreserve.gov`, `www.bls.gov`; data APIs only from FRED, Treasury, BEA's RSS host (`apps.bea.gov`), the Federal Register documents API (`www.federalregister.gov`, JSON only, never pages), SEC's per-company filing lists (`data.sec.gov`, JSON only), Gemini, Groq (`api.groq.com`) and the project's Supabase host. Each redirect hop is re-checked. https only, no credentials in URLs, about 5 requests per second, optional local file cache. |
| `src/rewrite.ts` | `--rewrite`: re-summarizes older published cards from the same sources and updates them in place (or hides them when the relevance score is below 3, an earnings card still has no figures, or a quake is now below the publishing threshold). |
| `src/sec-text.ts`, `src/text.ts` | `sec-text.ts`: SEC page text for the AI, with the EX-99.1 press release for Item 2.02 filings. `text.ts`: sentence-case helper for headlines and the product-code check. |
| `src/detail.ts` | Factual in-depth details for template cards (no AI). |
| `src/summarizer/` | `chain.ts` runs the providers in order (license check first, then Gemini, then Groq, then the template card); the AI also scores everyday relevance 1-5 (cards below 3 are not published) and writes the in-depth detail, which is dropped (card kept) if it fails the checks; `gemini.ts` and `groq.ts` are the AI adapters (same prompt, keys sent in a header only); `template.ts` builds cards from metadata without AI; `providers.ts` builds the list and skips a provider whose key is missing. |
| `src/validate.ts` | Checks a draft card: JSON shape, headline <= 90 chars, body <= 60 words, category, no advice language, every number must appear in the source, every ticker must appear in the source, copy limit (<= 10 consecutive words from a filing, <= 25 from public-domain government text; numbers and 8-K item titles do not count), `no_figures` (an earnings card needs a digit in its body) and no outright model number / SKU / UPC / lot number in headline or body. `assertSummarizable()` refuses any text that is not public domain or a company filing before it can reach the AI. `validatePublish()` refuses cards with no source link, `dev_only` sources or `link_out` kind. |
| `src/sources/` | `sec.ts` (8-Ks from about 150 household-name companies only: current feed plus each company's `data.sec.gov` filing list; big items only (earnings, CEO/CFO changes, deals, layoffs, cyber incidents, restatements, bankruptcy); routine director-only 5.02s and low-value 7.01/8.01/9.01-only filings skipped before any AI call; category and event type from item numbers), `fed.ts`, `bea.ts` (BEA RSS, feed text only), `fedreg.ts` (Federal Register final rules from consumer-facing agencies; the AI sees only the `abstract`; no abstract = skipped; AI cards only), `macro.ts` (12 FRED series, data cards; MORTGAGE30US refused), `wiki.ts` (Wikipedia "In the news" over the last 3 days, CC BY-SA, attribution on every card), `cpsc.ts` (product recalls, 5 new per run), `usgs.ts` (significant earthquakes, template cards), `nasa.ts` (news releases only, 14 days, 2 feed pages). |
| `src/dedupe.ts` | Skips an item whose URL was already seen and caps cards at 3 per ticker within 24 hours. The database enforces the same rules again. |
| `src/topicFilter.ts` | Deterministic report-card prefilter before fetching page text or calling an AI. Screens Form 144 and routine paperwork, celebrity/sports stories without a business signal, and limits airworthiness directives to the configured narrow-source cap (the existing Federal Register source cap may be stricter). |
| `src/ranking.ts` | A TypeScript copy of the database ranking formula, used by tests only. |
| `src/main.ts` | The command line and the live and dry-run wiring (also refreshes the Trending boosts at the end of a run). |
| `src/pipeline.ts` | One run: sources, guards, summarize, publish. |
| `src/publish.ts` | PostgREST client for the service-role RPCs, the dry-run publisher and the payload builder. |
| `src/types.ts`, `src/html.ts` | Internal pipeline types and small HTML/XML helpers. |
| `src/fixtures/` | Labeled sample inputs for tests and `--dry-run` (see its `README.md`). |
| `test/*.test.ts` | Offline tests for all of the above plus a check of the shared contract fixtures. |

## Quality-rule settings (audit fixes, 2026-10-18)

All in `src/config.ts`; the full explanation is in `ingest.md`.

| Config value | Default | Meaning |
|---|---|---|
| `promptVersion` / `templateVersion` | `sum-v6` / `tpl-v5` | stored on each card; `--rewrite` redoes cards on any other version |
| `secExhibit.items` / `.types` / `.primaryMaxChars` | `['2.02']` / `['EX-99.1','EX-99.01','EX-99']` / `3000` | Item 2.02 filings also fetch the EX-99.1 press release (page host `www.sec.gov`) for the AI |
| `earningsFigures.requiredItems` | `['2.02']` | an earnings card from these items needs a digit in its body (`no_figures`); template cards too |
| `fedRegister.maxAirworthinessPerRun` | `1` | FAA airworthiness directives allowed per run (others: `skip faa_directive_cap`) |
| `ranking.airworthinessImportance` | `1.5` | importance cap for such a card in the `src/ranking.ts` mirror |
| `usgs.keepAlerts` / `usgs.minMagnitudeWithoutAlert` | `['yellow','orange','red']` / `6.5` | quakes with a green or missing alert are skipped when at sea (no country, ridge, rise, ocean) or under M6.5 |
| `cpsc.rewriteLookbackDays` | `120` | how far back `--rewrite` looks for an old recall |
| `cpsc.maxPerRun` | `5` | NEW recalls processed per run; recalls an earlier run already handled do not count, so each run moves on to the next unprocessed ones |
| `wiki.lookbackDays` | `1` | UTC days of Wikipedia "In the news" feeds read per run, today included (live runs: past-day feeds had 0 news; set 2 or 3 to read earlier days, a story on several days becomes one card) |
| `nasa.maxAgeDays` / `nasa.feedPages` | `14` / `1` | NASA news releases from the last 14 days (was 7); only feed page 1 is read, since `?paged=2` answers HTTP 403 in live runs (set `feedPages` to 2 to read it; the feed holds only 10 posts per page and mixes in APOD and image articles) |

## How publishing will work

The script writes only through service-role RPCs in the `api` schema (`upsert_item`, `set_item_status`, `publish_blurb`, `upsert_macro`). Those functions are revoked from the anonymous and signed-in roles. `publish_blurb` ranks the card itself, so the private schemas never need to be exposed.

## Report-card scorer status

The deterministic topic prefilter is active and runs before page-text fetching and model calls. The complete report-card workflow is not yet wired: Groq scoring, Gemini feedback revision/re-score, recent-card relation lookup and story-link RPCs, and `--audit-cards` are follow-up work. Do not treat a published card as having passed the full report-card rubric until those stages are implemented. No SQL or live API calls are made by the offline tests.
