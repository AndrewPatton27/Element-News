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

One Expo and React Native codebase serves web and mobile. Supabase provides the database and API; Cloudflare Pages hosts the web app. Gemini Flash-Lite writes summaries, with Groq as a fallback. The app and services use free tiers. Ingestion runs from a laptop; it is not an automatic live newswire. **[CHECK: verify the exact production model/provider configuration before submission.]**

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
# Run app logic, contract, and formatting tests (168 tests pass)
npm run test:app

# Run ingestion pipeline, validator, and allowlist tests
npm run test:ingest

# Run TypeScript typecheck across all files
npx tsc --noEmit
```

---

## Project Structure

```
â”œâ”€â”€ app/          # Expo Router screens (Feed, Brief, Search, Following, Account, About)
â”œâ”€â”€ components/   # Pager, Cards, DetailSheet, NumbersPanel, Shell, Chips
â”œâ”€â”€ contract/     # API contracts, data types, and static mock fixtures
â”œâ”€â”€ ingest/       # Standalone Node/TS ingestion, validation, and AI pipeline
â”œâ”€â”€ lib/          # State hooks, ranking logic, search/following handlers, API client
â”œâ”€â”€ supabase/     # PostgreSQL migrations (schemas, RLS, functions, and ranking)
â””â”€â”€ assets/       # Icons and application graphics
```

---

## License

The code is released under the [MIT License](LICENSE). News content keeps its own terms: see the data sources and credits above.


