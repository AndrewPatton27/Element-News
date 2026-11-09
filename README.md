# Element

**The news that touches your life, in plain words, with a source on every card.** Element is a business and public-interest news app for the web and phones. It turns public records and data into readable cards, with links back to the source.

> Informational only · Not investment advice

- **Live:** https://element-news.pages.dev
- **Code:** https://github.com/AndrewPatton27/element
- **License:** MIT

## What you can do

- **Swipe feed:** Trending, Latest and For you. React with a right/left swipe on phones or Like/Dislike buttons everywhere. For you adapts to reactions. **[CHECK: confirm five-card reveal and queued prefetch on the current build.]**
- **Follow:** Follow a topic from any card; Following shows newer relevant stories, explains why they appear, and links updates and different angles in a story.
- **Search:** Search any matching word, related words and common typos; results are ranked by trending. Try “fed rate,” “recall,” “treasury yields,” or “earthquake.”
- **Daily and weekly Brief:** Read a roughly 250-word AI summary in paragraphs, a separate Markets section, deeper sections for leading topics, and Numbers with green, red or gray direction arrows. Use See all to expand a topic.
- **Numbers:** Open the ticker to see economic indicators and their sources.
- **Email brief sign-up:** “Stay up to date” lets readers choose Daily, Weekly or Both and a delivery time. Confirmation and one-click unsubscribe are built. Sending requires an email-service key; it has only been dry-run tested, and emails are not currently being sent.
- **First-run tour:** Animated lessons and practice buttons demonstrate reactions and navigation. Practice saves nothing.
- **No account required:** Preferences and For you ranking work on the device while signed out; choices merge on sign-in.
- **Trust on every card:** Source links, the informational disclaimer and the AI-generated-summary label. Every card shows an AI label and the informational disclaimer. A validator checks generated claims against source text, copy limits and advice language.

## How it is built

One Expo and React Native codebase serves web and mobile. Supabase provides the database and API; Cloudflare Pages hosts the web app. Gemini Flash-Lite writes summaries, with Groq as a fallback. The app and services use free tiers. Ingestion runs every hour in the cloud (Supabase pg_cron calls two Edge Functions, one source per call); the original laptop script is kept as a backup. It is a scheduled feed of public records, not a real-time newswire. A Cloudflare Worker watches the pipeline and opens an issue in a private repository when something stops. **[CHECK: verify the exact production model/provider configuration before submission.]**

## Data Sources and Licenses
## Data Sources and Licenses

| Source | Data Used | Terms / License |
|---|---|---|
| [SEC EDGAR](https://www.sec.gov/) | 8-K filings (earnings, leadership changes, deals, material events) | U.S. public records; compliant with [SEC access rules](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) (declared User-Agent, rate limit) |
| [Federal Reserve](https://www.federalreserve.gov/) | Press releases and policy rate decisions | U.S. government publication; [disclaimer](https://www.federalreserve.gov/disclaimer.htm) |
| [BEA](https://www.bea.gov/) | GDP, personal income, and national account releases | U.S. government; [reuse terms](https://www.bea.gov/help/faq/147) |
| [Federal Register](https://www.federalregister.gov/) | Final agency consumer/economic rules | U.S. government; [API and reuse](https://www.federalregister.gov/reader-aids/developer-resources/rest-api) |
| [FRED](https://fred.stlouisfed.org/) | 12 economic series (Yields, Fed Funds, CPI, Oil, Gas, Unemployment, Claims) | [FRED terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html); original reporting agencies credited |
| [Wikipedia "In the news"](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content) | Major global news events | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); adapted with full attribution |
| [CPSC](https://www.cpsc.gov/Recalls) | Consumer product safety recalls | U.S. government public domain |
| [USGS](https://earthquake.usgs.gov/earthquakes/feed/) | Significant earthquake event reports (template cards) | U.S. government public domain |
| [NASA](https://www.nasa.gov/news-release/) | Space exploration and science releases | [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) |

*This product uses the FREDÂ® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.*

---


## License

Element's code is released under the [MIT License](LICENSE). News content keeps its own terms; see Data Sources and Licenses above.

## Running Locally

### Prerequisites
- Node.js 22.18 or newer (`node -v`)
- npm

### 1. App on Sample Data (No Keys Required)
Clone the repository and launch the web development server:
```bash
git clone https://github.com/AndrewPatton27/element.git
cd element
npm install
npx expo start --web
```
The app loads in mock mode using fixtures from `contract/fixtures/` and displays the `[SAMPLE]` banner.

### 2. App Connected to Supabase
1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Configure your client variables:
   ```env
   EXPO_PUBLIC_API_MODE=supabase
   EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-anon-publishable-key
   ```
3. Run `npx expo start --web`.

### 3. Ingestion Pipeline
The ingestion scripts run independently with zero external dependencies:
```bash
cd ingest
npm test           # Run offline ingestion unit tests
npm run dry-run    # Process test fixtures through summarize & validate without publishing
```

---

## Automated Tests

Element includes end-to-end unit, contract, and parsing test suites across the entire stack:

```bash
# App logic, contract and formatting tests (343 tests)
npm run test:app

# Ingestion pipeline, validator and allowlist tests (301 tests)
npm run test:ingest

# Edge Functions (budget, usage caps, run log, deadline) (39 tests)
npm run test:functions

# Watchdog Worker (10 tests)
npm run test:worker

# Secret scan of tracked files (add --staged before a commit)
npm run scan:secrets

# TypeScript typecheck (app; ingest, supabase/functions and workers/watchdog have their own tsconfig)
npx tsc --noEmit
```

The SQL checks in `supabase/tests/` run in the Supabase SQL editor or an offline PGlite harness (see `supabase/supabase.md`).
GitHub Actions (`.github/workflows/ci.yml`) runs the secret scan, type checks and all four test suites on every push and pull request. Nothing is scheduled there.

---

## If it breaks

The watchdog (`workers/watchdog`) checks the pipeline every hour. When it sees a problem it opens an issue in the private repo `element-ops` (one issue per kind, labels `wd:stale`, `wd:quiet`, `wd:jobs`, `wd:cron`, `wd:hung`, `wd:model`, `wd:ai`, `wd:db`, `wd:supabase`; GitHub emails the owner). A Healthchecks.io check emails if the watchdog itself stops or GitHub refuses its token.

1. Read the open issues in `element-ops`. The label says what is wrong.
2. In the Supabase SQL editor: `select * from ingest.run_log order by started_at desc limit 20;` (error column, `detail->'log_tail'`).
3. Cron jobs missing (`wd:jobs`, fewer than 10 `element-%` jobs): re-apply `supabase/migrations/20261019050000_cron_schedule.sql`.
4. Project paused (`wd:supabase`): Dashboard, Restore (possible within 90 days). The Worker's 24 API calls a day normally keep a free project awake.
5. Model retired (`wd:model`): put the new model ID in `ingest/src/config.ts` (`gemini.model` / `groq.model`) and redeploy both Edge Functions. Cards keep flowing on the fallback model meanwhile.
6. Key rotated: update the Vault secret `element_service_key` (SQL editor) and the Worker secrets (`npx wrangler secret put <NAME>` in `workers/watchdog`); Edge Function secrets with `supabase secrets set`.
7. Daily AI limit reached (`wd:ai`): lower or raise the caps with `update core.ai_caps set cap = ... where provider = '...';`. Without AI, only Fed, BEA and some 8-K template cards are published.
8. Stuck runs (`wd:hung`): they are marked `killed` by the next run. Check the `log_tail` of the killed row for the source that hung.

## Project Structure

```
â”œâ”€â”€ app/          # Expo Router screens (Feed, Brief, Search, Following, Account, About)
â”œâ”€â”€ components/   # Pager, Cards, DetailSheet, NumbersPanel, Shell, Chips
â”œâ”€â”€ contract/     # API contracts, data types, and static mock fixtures
â”œâ”€â”€ ingest/       # Standalone Node/TS ingestion, validation, and AI pipeline
â”œâ”€â”€ lib/          # State hooks, ranking logic, search/following handlers, API client
â”œâ”€â”€ supabase/     # PostgreSQL migrations (schemas, RLS, functions, and ranking)
â”œâ”€â”€ workers/      # Cloudflare Worker "watchdog": hourly health check, alerts via GitHub issues
â””â”€â”€ assets/       # Icons and application graphics
```

---

## License

The code is released under the [MIT License](LICENSE). News content keeps its own terms: see the data sources and credits above.


