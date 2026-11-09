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
npm run test:app        # app logic, contract and formatting tests (349 tests)
npm run test:ingest     # ingestion pipeline, validator and allowlist (321 tests)
npm run test:functions  # Edge Functions: budget, usage caps, run log, deadline (39 tests)
npm run test:e2e        # browser smoke test on sample data, phone and desktop viewports
                        # first time: `npx playwright install chromium` (or PW_CHANNEL=chrome)
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
## ML ranker (prototype, shadow mode only)

**ML ranker evaluated on simulated readers only; every reader is served by the formula; shadow logging gathers real data.**

`ml/` holds a machine-learning version of the For you feed, written in Python with free local libraries (scikit-learn, LightGBM). It learns what each reader finds useful from the same signals the app already records (likes, dislikes, detail and source taps, how long a card stays on screen):

1. Each card becomes a 32-number vector from its text and labels.
2. Each reader gets a vector that moves toward cards they like and away from cards they dislike.
3. About 150 candidates are picked (closest to the reader, plus the most important and fresh stories).
4. Four small models predict a like, a dislike, a detail open and how much of the card will be read; these are combined into one score. Reading time counts relative to the card's length and is capped, so long cards and clickbait gain nothing.
5. A diversity pass keeps the page varied, and every card gets a one-sentence reason ("You follow tech", "Major story right now").

**How it connects to the website.** It does not change what anyone sees today.
- Two switches in the database, `foryou_ml_mode` and `trending_ml_mode`, turn on *shadow logging* for signed-in readers: which cards each For you and Trending page showed, and in which slot. They ship off (0); shadow mode is 1. Guests are never logged, and deleting your data removes these records.
- An hourly job on the laptop (next to the existing ingest run) replays the logged pages through the model and writes the model's would-have-ranked scores back to Postgres, so the model can be compared with the live formula on real behaviour. The database side is built; the replay job is the next step.
- Trending uses the same model averaged across all readers ("what would most people find useful"), with popularity and position signals switched off so it cannot reinforce itself.
- Going live later means adding one capped term to the existing SQL score, so importance and freshness stay in charge. That needs its own review and only happens after at least 14 days of shadow logs, at least 200 real readers, models retrained on real events, and a shadow evaluation that beats the formula without more dislikes.

**Run the tests and the evaluation** (Python 3.13 with numpy, scipy, pandas, scikit-learn, lightgbm, pytest), from `ml/`:

```bash
python -m pytest tests -q                       # 46 tests, about 10 s
python -m elementml.cli demo                    # rank the sample cards for a made-up reader
python -m elementml.cli train                   # train the models (a few minutes)
python -m elementml.cli train-variant --sub nr --spec normal   # the hardened model used in the results
python -m elementml.cli eval --world wild --seed-list 1,2,3,4,5 --methods h_full,a1_current_server --out wild.json
python -m elementml.cli compare wild.json       # mean per method and paired difference vs today's formula
```

The folder guide with every file, input and output is [`ml/ml.md`](ml/ml.md).

**Honest limits.**
- All numbers come from simulated readers reacting to synthetic cards, and the model was trained on the same simulator that grades it. They show the pipeline works; they are not evidence of gains for real readers.
- In simulation the model beats today's formula clearly in a clean world (NDCG@10 0.39 to 0.55) but only slightly in noisier worlds (0.32 to 0.36 and 0.31 to 0.34). Real readers are likely noisier still, so the real gain could be small or zero.
- Real headlines are messier than the synthetic vocabulary, so the text vectors will be weaker.
- When a reader's taste changes completely, the hardened model adapts more slowly than the original one.

---

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


