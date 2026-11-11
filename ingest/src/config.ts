// Every tunable value for the ingest script lives here (one place to change).
// Values marked UNVERIFIED must be confirmed before relying on them.
// Inputs: none at import time; readEnv() reads process.env (or a given map) when called.
// Outputs: the `config` object, small derived helpers (caps, pacing, Federal Register URLs) and
// readEnv/describeEnv for the environment (key values are never printed).

export const config = {
  // ---- AI summarizer --------------------------------------------------------
  gemini: {
    model: 'gemini-3.5-flash-lite',            // verified model ID (stable), 2026-10-17
    fallbackModel: 'gemini-3.1-flash-lite',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    // Free-tier limits for this model, read in AI Studio on 2026-10-17: 15 RPM, 250K TPM, 500 RPD.
    freeRpd: 500 as number | null,
    freeRpm: 15,
  },
  // Groq (free tier, OpenAI-compatible API). Used when Gemini is capped, rate limited,
  // failing, timing out, missing its key, or its drafts fail validation twice.
  groq: {
    // gpt-oss-120b: best quality of the Groq text models on the account, same free limits as 20b
    // and qwen3.8-27b, and Groq supports structured JSON output (json_schema) for it.
    model: 'openai/gpt-oss-120b',
    alternativeModel: 'openai/gpt-oss-20b',      // not used; faster, same limits
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    // 'json_schema' (constrained output) or 'json_object' (JSON mode). If Groq answers 400 to
    // json_schema, the adapter retries that call once in json_object mode.
    responseFormat: 'json_schema' as 'json_schema' | 'json_object',
    // Add JSON-schema maxLength to the headline in json_schema mode. UNVERIFIED whether Groq's strict
    // mode accepts it; the prompt and schema descriptions state the limits either way.
    schemaMaxLength: false as boolean,
    reasoningEffort: 'low' as string | null,     // gpt-oss is a reasoning model; low keeps it fast. null = not sent
    maxCompletionTokens: 2048,                   // includes reasoning tokens; v3 output (card + detail) is about 600 tokens
    // Free-tier limits, read by Drew in the Groq console on 2026-10-17 (same for all three models).
    freeRpm: 30 as number | null,
    freeRpd: 1000 as number | null,
    freeTpm: 8000 as number | null,
    freeTpd: 200_000 as number | null,
    // Tokens are the binding limit, so Groq gets less source text than Gemini. 2,700 tokens per call with sum-v6
    // (an estimate, never measured on Groq). sum-v7 (2026-11-10): the same two live Gemini calls with the same source text
    // measured +515 prompt tokens (earnings 4,239 -> 4,754, recall 1,914 -> 2,429), so 2,700 + 515 = 3,215.
    sourceTextMaxChars: 6000,
    estimatedTokensPerCall: 3215,
    // Pacing: max(60 s / (RPM * rpmSafetyFactor) = 2.5 s, 60 s * tokensPerCall / (TPM * factor) = 30.1 s,
    // this floor). The floor leaves room
    // for reasoning tokens we cannot measure offline.
    minIntervalMsFloor: 30_000,
    // Daily cap: min(this, RPD, floor(TPD / tokensPerCall) = 62; was 74 with sum-v6). core.ai_caps holds the live copy (reserve 5 for the brief).
    dailyCapCode: 80,
  },
  // Pacing safety margin for every AI provider: interval = ceil(60 s / (RPM * factor)).
  // 0.8 -> Gemini 15 RPM paced at 12/min (5 s). Calling at exactly 15/min (4 s) hit a 429 on
  // 2026-10-17 because validator retries and clock jitter also count as requests.
  rpmSafetyFactor: 0.8,
  // After a 429, a provider is skipped for this long within the same run (next provider or template).
  rateLimitCooldownMs: 60_000,
  aiDailyCapCode: 600,                         // Gemini hard cap in code; effective cap = min(this, freeRpd)
  // v4 (2026-10-17): plain headline+body rules (no over-specific details; precise details only in detail.key_points).
  // v5 (2026-10-18): earnings cards must state figures (EX-99.1 press release is fed to the AI), no model
  // numbers/SKUs/UPCs/lot numbers in the headline or summary, sentence-case headlines.
  // v6 (2026-10-18): flow and no repetition (D-58): the first body sentence continues from the headline
  // instead of restating it, no sentence repeats another, no filler; the validator rejects repetition.
  // v7 (2026-11-10, D-111/D-123): readers who follow business, finance and investing (about 16-50, plain 8th-grade words),
  // macro-first relevance rubric, defined jargon, one direction word, numerals for dates, no field labels, no speculation or
  // relative time. Validators: style:, speculation:, relative_time:, event_type enum, extended repetition; fixProperNouns.
  promptVersion: 'sum-v7',
  // Version stored on template and data cards (no AI). tpl-v2 = plain wording (2026-10-17).
  // `--rewrite` redoes every published card whose prompt_version is neither this nor promptVersion.
  // v4: plain USGS headline+body and plain Federal Register headline. v5: sentence-case template headlines,
  // generic CPSC template (no product codes), figure-less earnings and low-interest quake template cards dropped.
  templateVersion: 'tpl-v6',     // v6 (M9): bp not pts, no Change/Period bullets, why-it-matters lines, yield-curve card, no From/Published/Title stub
  providerOrder: ['gemini', 'groq', 'template'] as const, // a list on purpose: adding a provider is one entry

  // Deterministic editorial gate, before any model call. Per-run narrow-source diversity cap.
  reportCard: {
    // The write -> Groq score -> revise-once -> publish protocol in the pipeline. OFF for the scheduled
    // hourly run until Drew approves; the audit command (--audit-cards) does not depend on it.
    protocolEnabled: false,
    scoreBatchSize: 3,                       // cards per scorer call (audit); the 8,000 tokens/minute free limit binds
    scoreMaxRecentCards: 30,
    scoreMaxTokens: 1500,
    scoreMinIntervalMs: 24_000,
    scoreMax429Retries: 8,
    narrowSourceMaxPerRun: 2,
    narrowSources: ['faa_airworthiness_directive', 'usgs_quake', 'nasa_release'] as readonly string[],
    // Per-type caps (override narrowSourceMaxPerRun): USGS and NASA at most 1 new card per run (R-218 macro focus).
    narrowSourceCaps: { usgs_quake: 1, nasa_release: 1 } as Readonly<Record<string, number>>,
    denyTitlePatterns: [
      /\bform\s*144\b/i,
      /\b(form|schedule)\s+(?:8-k|10-q|10-k)\b.*\b(amendment|exhibit|supplement)\b/i,
      /\b(exhibit|amendment|supplement)\b.*\b(sec|filing)\b/i,
      /\b(arrested|shooting|robbery|homicide|crash|murder)\b/i,
    ] as readonly RegExp[],
    allowBusinessContextPatterns: [
      /\b(revenue|sales|earnings|jobs|workers|cost|price|recall|business|company|market|industry|billion|million|regulator|federal|economy)\b/i,
    ] as readonly RegExp[],
    scorePromptVersion: 'report-card-v1',
    // A report-card failure (ABANDON, or the one rewrite failing its checks) used to skip the item for good. Now the item
    // stays 'new' and is retried in a later run; after this many failures it is skipped (src/retry.ts). DUPLICATE is final at once.
    maxRetries: 3,
    // Edge Functions only (deps.reportCard.scorerMaxGroqUsed): the Groq scorer switches off once Groq's calls
    // today reach this number, so the writer fallback and brief-summary keep Groq calls (cap 74; watchdog design 5.3).
    cloudScorerMaxGroqUsed: 50,
    // Edge Functions only (deps.reportCard.scorerMaxPerRun): at most this many cards are scored per run; the rest
    // publish unscored (validator still runs, AI label kept). A scorer error also publishes unscored (fail open).
    // The scorer is Groq only: the Gemini adapter has no generate() and Gemini is the writer.
    scorerMaxPerRun: 3,
    recentCardDays: 7,
    auditBatchSize: 3,
    auditHideMaxFraction: 0.4,
  },

  // ---- card limits ------------------------------------------------------------
  headlineMaxChars: 90,
  headlineTargetChars: 60,                     // the prompt asks for about this many (short and plain)
  // In-depth summary shown when a card is opened (D-37). Same validator rules as the card; if only
  // the detail fails, the card is published with detail null.
  detail: {
    minParagraphs: 2,
    maxParagraphs: 4,
    maxWords: 180,                             // all paragraphs together
    minKeyPoints: 3,
    maxKeyPoints: 5,
    keyPointMaxWords: 15,
  },
  bodyMaxWords: 60,
  // Repetition check for AI drafts (validateDraft; template and data cards never go through it, their
  // fixed wording is exempt). Compares "content words": lower-cased, lightly stemmed, with stop words,
  // numbers and words shorter than minWordLength left out.
  repetition: {
    minWordLength: 3,
    // (a) the first summary sentence restates the headline when this share of the headline's content
    // words also appears in it (or it starts with the headline text). Tuned on the fixtures: a normal
    // first sentence reuses the entity and the topic noun (about 0.3 to 0.5), a restatement reuses nearly all.
    headlineOverlapMax: 0.7,
    // Same test for the detail (paragraph 1 and key point 1 against the headline). Live sum-v7 runs dropped the detail in about 1 of 4
    // cards for this reason; raise it (for example to 0.85) to keep more details, lower it to be stricter.
    detailHeadlineOverlapMax: 0.7,
    minHeadlineWords: 3,                       // a headline with fewer content words is only checked for "starts with"
    // (b) two summary sentences are near-duplicates when this share of the shorter one's content words
    // appears in the other.
    sentenceOverlapMax: 0.7,
    minSentenceWords: 3,                       // shorter sentences ("Revenue grew 12%.") are not compared
  },
  maxTickersPerCard: 5,
  maxSourcesPerCard: 8,
  // Max consecutive words copied from the source (numbers and 8-K item titles don't count).
  copyLimitWords: {
    company_filing: 10,
    public_domain: 25,
    cc_by_sa: 10,                               // Wikipedia: treated like filings (PM review 2)
  } as Record<string, number>,

  // Phrases that read as advice. Matched case-insensitively on word boundaries.
  // Two groups: investment advice (always blocked, every category) and a few words that only
  // read as advice outside a product-safety instruction (see safetyAdviceAllowlist).
  adviceBlocklist: [
    'should', 'recommend', 'recommends', 'recommended', 'recommendation',
    'price target', 'guaranteed', 'guarantee', 'undervalued', 'overvalued',
    'buy', 'sell', 'invest in',
    'strong buy', 'buy rating', 'sell rating', 'hold rating', 'time to buy', 'time to sell',
    'buy the dip', 'must-buy', 'must buy', 'outperform', 'underperform', 'can\'t lose',
    'sure thing', 'to the moon',
  ],
  // Blocklist phrases that are plain product-safety instructions, not investment advice. Allowed
  // ONLY on category 'safety' (CPSC recalls): e.g. "consumers should stop using the product".
  // Everywhere else they stay blocked. Investment words (buy, sell, price target, ...) are never
  // here, so investment advice stays blocked on safety cards too.
  safetyAdviceAllowlist: ['should'],
  // Blocklist phrases that read as advice ONLY in market talk. "to the moon" is a stock-pump slogan, but also
  // plain English in "missions to the Moon" (NASA cards were rejected for it, sum-v7 test). The phrase is blocked
  // only when the same text also has one of these market words.
  adviceMarketContext: {
    'to the moon': /\b(stocks?|shares?|prices?|crypto|bitcoin|ethereum|tokens?|coins?|rally|rallies|market|markets|trad(?:e|es|ing|er|ers)|invest(?:or|ors|ing|ment|ments)?|portfolio)\b/i,
  } as Readonly<Record<string, RegExp>>,

  // sum-v7 validators (AI drafts only). Each word or phrase is an error when it is in the draft but NOT in the source text.
  speculationWords: ['could', 'might', 'likely', 'is expected to', 'are expected to', 'is set to', 'are set to', 'poised to', 'may'] as readonly string[],
  relativeTimeWords: ['today', 'yesterday', 'tomorrow', 'this week', 'next week', 'last week', 'this month', 'next month', 'last month', 'days away'] as readonly string[],
  // Event types the AI may choose (schema enum and checkShape). Code sets world_event, recall, science and so on.
  aiEventTypes: ['earnings', 'exec_change', 'deal', 'insider', 'macro_release', 'fed'] as readonly string[],
  // Number tolerance (safety net, audit item 9): a draft figure that has a scale word ("1.5 billion") is also accepted when
  // the source has the same value one scale step away ("1,500 million"). Percent figures stay exact. Never rounds.
  numberScaleTolerance: true,
  // fixProperNouns (text.ts): deterministic casing fixer for AI text, run after validation. Short, reviewed lists.
  // acronyms: Title-case and lower-case forms become upper case ("Nasa" -> "NASA"). names: any non-upper-case spelling
  // becomes the canonical one. Anything already correct is never changed.
  properNounFixes: {
    acronyms: ['NASA', 'FCC', 'FAA', 'FOMC', 'FDA', 'FDIC', 'CFPB', 'CFTC', 'CPSC', 'USGS', 'OPEC', 'FTC', 'IRS', 'EPA', 'DOJ', 'GDP', 'CPI', 'BLS', 'BEA'] as readonly string[],
    // "Sec" is a real abbreviation too (seconds, "Sec. 5"), so it is fixed only as a bare word that is not followed by a period.
    titleCaseOnlyAcronyms: ['SEC'] as readonly string[],
    names: [
      'United States', 'Federal Reserve', 'Federal Open Market Committee', 'Social Security', 'Wall Street', 'Medicare', 'Medicaid',
      'Treasury Department', 'White House', 'Supreme Court', 'Congress',
    ] as readonly string[],
    usAbbreviation: true,                      // "u.s." -> "U.S."
    // Mars and Moon are also common words: fixed only when a space or mission word is near.
    spaceContext: /\b(nasa|moon|mars|lunar|astronauts?|missions?|rovers?|spacecraft|planets?|orbit|artemis|crew|rocket|rockets)\b/i,
  },
  // `--rewrite` stops hiding cards (keeps them) once hidden / selected passes this share (same idea as reportCard.auditHideMaxFraction).
  rewriteHideMaxFraction: 0.4,

  // Candidate selection (run-wide budget): every source's candidates are collected first (no AI call), scored
  // without AI, and the run's budget (default 20 new items) is spent on the best ones. enabled=false = the old
  // fixed source order (macro, fed, bea, fedreg, sec, wiki, cpsc, usgs, nasa), each source taking what it wants.
  selection: {
    enabled: true,
    // score = importance * log2(policy importance) + freshness * 0.5^(age / halfLife) - diversity * (picks already taken from the source)
    weights: { importance: 1, freshness: 2, diversity: 0.5 },
    freshnessHalfLifeHours: 24,
    softCapShare: 0.4,                         // one source takes at most this share of the budget while others still have candidates; leftover is handed back
  },

  // ---- dedupe / ranking guard --------------------------------------------------
  tickerCapPer24h: 3,                          // mirrors core.rank_params.ticker_cap_24h
  tickerCapWindowHours: 24,

  // ---- fetching ------------------------------------------------------------------
  // Full pages may only be downloaded from these hosts.
  pageHosts: ['www.sec.gov', 'www.federalreserve.gov', 'www.bls.gov'],
  // Data APIs (JSON/CSV endpoints, not pages). The Supabase host is added at runtime.
  // apps.bea.gov serves only the BEA release RSS here (feed text, never pages).
  // www.federalregister.gov serves only its JSON documents API here (never pages).
  // data.sec.gov serves only the per-company submissions JSON here (filing lists, never pages).
  apiHosts: ['api.stlouisfed.org', 'home.treasury.gov', 'generativelanguage.googleapis.com', 'api.groq.com', 'apps.bea.gov',
    'www.federalregister.gov', 'data.sec.gov',
    // Treasury FiscalData JSON API (average interest rates, debt to the penny): numbers only, never pages.
    'api.fiscaldata.treasury.gov',
    // BLS public data API (series JSON, numbers only) and BEA data API (apps.bea.gov, already listed above for the RSS).
    'api.bls.gov',
    // EIA open data API v2 and Census Data API (JSON numbers only, never pages). Keys come from env, never from code.
    'api.eia.gov', 'api.census.gov',
    // Broad topics (feed/API text only, never pages): Wikipedia REST featured feed, CPSC recalls API,
    // USGS earthquake GeoJSON, NASA news-release RSS.
    'en.wikipedia.org', 'www.saferproducts.gov', 'earthquake.usgs.gov', 'www.nasa.gov'],
  maxRequestsPerSecond: 5,                     // SEC allows 10/s; we stay at half
  maxRedirects: 3,
  fetchTimeoutMs: 20_000,
  cacheDir: 'cache',
  cacheTtlMinutes: 60 * 24,                    // filings never change; feeds use a short TTL below
  feedCacheTtlMinutes: 4,
  sourceTextMaxChars: 10_000,                  // about 2.5k tokens sent to the AI

  feeds: {
    sec8k: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom',
    fedRss: [
      'https://www.federalreserve.gov/feeds/press_monetary.xml',
      'https://www.federalreserve.gov/feeds/press_all.xml',
    ],
    beaRss: 'https://apps.bea.gov/rss/rss.xml',
    // Fed Board speeches and testimony (Board members only; Reserve Bank presidents are outside the licence).
    fedSpeechRss: 'https://www.federalreserve.gov/feeds/speeches.xml',
    // SEC press releases (US government work; feed text only, copy limit 10 words to stay safe).
    secPressRss: 'https://www.sec.gov/news/pressreleases.rss',
    fredObservations: 'https://api.stlouisfed.org/fred/series/observations',
    treasuryCsv: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv',
  },
  // DFEDTARU/DFEDTARL come first so the fed funds card (DFF) can state the target range from the same run.
  macroSeries: ['DFEDTARU', 'DFEDTARL', 'DGS2', 'DGS10', 'DFF', 'CPIAUCSL', 'UNRATE', 'DCOILWTICO',
    'GASREGW', 'ICSA', 'RSAFS', 'HOUST', 'PAYEMS', 'A191RL1Q225SBEA',
    // Finance and rates (2026-11-08): all Federal Reserve Board H.15 series. SPREAD_10Y2Y is not fetched: it is
    // computed from DGS10 and DGS2 (FRED's own T10Y2Y and SOFR pages carry a copyright flag, so they stay out).
    // Check each series' notes on its FRED page for a "Copyright" line before enabling in production.
    'DGS3MO', 'DGS5', 'DGS30', 'EFFR',
    // M9c (2026-11-11): 16 more public-domain series (sources/moreSeries.ts). FRED notes checked: no Copyright line.
    'CCSA', 'CIVPART', 'U6RATE', 'CPILFESL', 'PPIFIS', 'PCEPI', 'PCEPILFE', 'PSAVERT',
    'INDPRO', 'TCU', 'TOTALSL', 'WALCL', 'M2SL', 'PERMIT', 'HSN1F', 'DGORDER'],
  // Derived series: id -> [minuend, subtrahend] (both must be fetched in the same run).
  derivedSeries: { SPREAD_10Y2Y: ['DGS10', 'DGS2'] } as Record<string, [string, string]>,
  // FRED series that must never be fetched or shown (not public domain). MORTGAGE30US: Freddie Mac copyright.
  forbiddenSeries: ['MORTGAGE30US'],
  // A data card is published only for a new observation that moved at least this much
  // (daily and weekly series). Monthly and quarterly series (CPI, unemployment, retail sales,
  // housing starts, payrolls, GDP) always get one card per new period.
  dataCardMinMove: {
    // Treasury maturities no longer get a card each: one daily yield-curve card (config.yieldCurve) covers 2/5/10/30-year.
    DGS2: 99,            // numbers panel only (see yieldCurve)
    DGS10: 99,
    DFF: 0.05,           // percentage points
    DCOILWTICO: 2.0,     // percent
    GASREGW: 1.0,        // percent, weekly
    ICSA: 5.0,           // percent, weekly
    DGS3MO: 99,          // numbers only
    DGS5: 99,
    DGS30: 99,
    EFFR: 99,            // numbers panel only: DFF already carries the fed funds card
    DFEDTARU: 0.05,      // the rate-range upper limit changes only at FOMC decisions (one card per change)
    DFEDTARL: 99,        // lower limit moves together with the upper one: numbers only
    SPREAD_10Y2Y: 99,    // numbers only
    TREAS_DEBT: 1e9,     // grows every day: numbers only
    CCSA: 3.0,           // percent, weekly (M9c)
    WALCL: 0.2,          // percent, weekly (M9c)
  } as Record<string, number>,
  // One daily Treasury yield-curve card (2, 5, 10, 30-year + 10y-2y gap, moves in bp). Published when the largest
  // move of the four is at least minMovePoints (percentage points; 0 = every day with a new reading, about 250/year,
  // and only the newest stays live because core.supersede_series hides the older ones).
  yieldCurve: { minMovePoints: 0 },
  fredLookbackDays: 500,                       // enough history for CPI year-over-year
  backfillWeeksDefault: 16,                    // --backfill-macro: weeks of history (Trends charts show 12 weekly points)
  backfillPauseMs: 700,                        // --backfill-macro: pause between FRED requests (limit is 120/minute)
  fedMaxAgeDays: 120,                            // ignore older press releases
  // BEA releases come 2-5 a week; on 2026-10-17 the newest was 11 days old, so 7 days would show none.
  beaMaxAgeDays: 120,
  beaAttribution: 'Source: U.S. Bureau of Economic Analysis',
  // Fed speeches and testimony: feed title + description only (no page download). Items dated in the
  // future (embargo timestamps) are held back until their pubDate.
  fedSpeechMaxAgeDays: 30,
  fedSpeechAttribution: 'Source: Board of Governors of the Federal Reserve System',
  // SEC press releases: feed text only. Copy limit follows the filing class (10 words).
  secPressMaxAgeDays: 14,
  secPressAttribution: 'Source: U.S. Securities and Exchange Commission',
  // Treasury FiscalData (JSON API, no key, no stated limit; one call per dataset per run, daily at most).
  // Values arrive as strings and "null". Cite the agency even though attribution is not required (Rule 8).
  fiscalData: {
    base: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service',
    avgRatesPath: '/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=100',
    debtPath: '/v2/accounting/od/debt_to_penny?sort=-record_date&fields=record_date,tot_pub_debt_out_amt&page[size]=2',
    attribution: 'Source: U.S. Department of the Treasury, Fiscal Service',
    // Which security descriptions become which series (all with security_type_desc "Marketable").
    avgRateSeries: {
      'Treasury Bills': 'TREAS_AVG_BILLS',
      'Treasury Notes': 'TREAS_AVG_NOTES',
      'Treasury Bonds': 'TREAS_AVG_BONDS',
    } as Record<string, string>,
    // Only these series may become data cards (monthly series would otherwise give one card each per month).
    cardSeries: ['TREAS_AVG_NOTES'] as string[],
  },
  // BLS public data API (GET, one series per request; v1 needs no key: 25 requests/day, v2 with BLS_API_KEY: 500/day).
  // Wages, Employment Cost Index and JOLTS: one data card per new period (monthly/quarterly), at most one run's
  // worth of requests = series count. Both polled twice a day (cron), so about 6 requests/day on v1.
  bls: {
    base: 'https://api.bls.gov/publicAPI',
    series: { CES0500000003: 'BLS_AHE', CIU1010000000000A: 'BLS_ECI', JTS000000000000000JOL: 'BLS_JOLTS' } as Record<string, string>,
    attribution: 'Source: U.S. Bureau of Labor Statistics',
  },
  // BEA NIPA data API (GET, key = BEA_API_KEY; limits 100 requests, 100 MB, 30 errors per minute). OFF by default:
  // the BEA API terms are not readable without signing in, so Drew confirms the reuse terms first (set BEA_DATA_ENABLED=1).
  // One request per table; T20804 (PCE prices, monthly), T20600 (personal income, monthly), T10105 (GDP, quarterly).
  beaData: {
    enabled: false,
    base: 'https://apps.bea.gov/api/data/',
    tables: [
      { table: 'T20804', frequency: 'M', yearsBack: 2, series: { DPCERG: 'BEA_PCE_YOY', DPCCRG: 'BEA_CORE_PCE_YOY' } },
      { table: 'T20600', frequency: 'M', yearsBack: 1, series: { A065RC: 'BEA_PERSONAL_INCOME' } },
      { table: 'T10105', frequency: 'Q', yearsBack: 1, series: { A191RC: 'BEA_GDP' } },
    ] as { table: string; frequency: 'M' | 'Q'; yearsBack: number; series: Record<string, string> }[],
    attribution: 'Source: U.S. Bureau of Economic Analysis',
  },
  // ---- Agency data cards (D-113): EIA, Census, Treasury auctions, FOMC calendar. Template cards, no AI. ----
  // Terms read 2026-11-10: docs/work/sources-eia-census-treasury-fed.md. Each source is bounded per run and
  // dedupes on its own key (source + series/period), so a rerun or an overlapping window never makes a second card.
  agency: {
    // EIA: public domain ("U.S. government publications are in the public domain"); asks for a dated credit.
    // API key in the URL (EIA_API_KEY). Documented limits are per-second/per-hour with no numbers: 1 request
    // per series group per run, cron weekdays only.
    eia: {
      enabled: true,
      base: 'https://api.eia.gov/v2',
      maxCardsPerRun: 4,
      attribution: 'Source: U.S. Energy Information Administration',
      // Weekly petroleum status: commercial crude, motor gasoline and distillate stocks, one card for the report.
      petroleum: { route: '/petroleum/stoc/wstk/data/', series: { crude: 'WCESTUS1', gasoline: 'WGTSTUS1', distillate: 'WDISTUS1' }, enabled: true },
      // Weekly natural gas storage, Lower 48 working gas in Bcf.
      gasStorage: { route: '/natural-gas/stor/wkly/data/', series: 'NW2_EPG0_SWO_R48_BCF', enabled: true },
      // Weekly refinery utilization + crude production, imports and product supplied (M9c): 2 requests, one card.
      supply: { routeSupply: '/petroleum/sum/sndw/data/', routeUtil: '/petroleum/pnp/wiup/data/', enabled: true,
        series: { utilization: 'WPULEUS3', production: 'WCRFPUS2', imports: 'WCRIMUS2', productSupplied: 'WRPUPUS2' } },
      // Weekly retail regular gasoline. OFF by default: FRED GASREGW (the same EIA number) already makes a gas card.
      gasoline: { route: '/petroleum/pri/gnd/data/', series: 'EMM_EPMR_PTE_NUS_DPG', enabled: false },
    },
    // Census: terms require a prominent "not endorsed or certified by the Census Bureau" notice and say nothing
    // clear on keys or limits, so the source is OFF until Drew confirms (question Q1 in the sources doc).
    // RSAFS and HOUST already reach the feed through FRED.
    census: {
      enabled: false,
      base: 'https://api.census.gov/data/timeseries/eits',
      maxCardsPerRun: 2,
      lookbackMonths: 3,
      notice: 'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.',
      attribution: 'Source: U.S. Census Bureau',
    },
    // Treasury auctions via FiscalData (no key; "offered free, without restriction"). Notes and bonds only
    // (bills auction almost daily and would flood the feed); TIPS skipped. At most 2 new cards per run.
    auctions: {
      enabled: true,
      path: '/v1/accounting/od/auctions_query',
      pageSize: 40,
      lookbackDays: 5,
      maxCardsPerRun: 2,
      securityTypes: ['Note', 'Bond'] as string[],
      attribution: 'Source: U.S. Department of the Treasury, Fiscal Service',
    },
    // BLS release calendar (M9c): ICS from www.bls.gov (public domain). One template card per major release, published
    // up to leadDays before it (Eastern days), at most maxCardsPerRun new cards per run.
    blscal: {
      enabled: true,
      url: 'https://www.bls.gov/schedule/news_release/bls.ics',
      leadDays: 3 as number,
      maxCardsPerRun: 3,
      attribution: 'Source: U.S. Bureau of Labor Statistics',
    },
    // Treasury Monthly Treasury Statement (M9c): budget deficit or surplus, one card a month (FiscalData, no key).
    mts: {
      enabled: true,
      path: '/v1/accounting/mts/mts_table_1',
      pageSize: 40,
      lookbackDays: 75,
      maxCardsPerRun: 1,
      attribution: 'Source: U.S. Department of the Treasury, Fiscal Service',
    },
    // FOMC calendar: dates copied from federalreserve.gov/monetarypolicy/fomccalendars.htm on 2026-11-10 (2027 tentative).
    // [first day, last day (decision day), has projections]. A card appears leadDays before the meeting starts.
    fomc: {
      enabled: true,
      leadDays: 7,
      minutesDelayDays: 21,                     // "released three weeks after the date of the policy decision"
      calendarUrl: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      meetings: [
        ['2026-12-08', '2026-12-09', true],
        ['2027-01-26', '2027-01-27', false], ['2027-03-16', '2027-03-17', true], ['2027-04-27', '2027-04-28', false],
        ['2027-06-08', '2027-06-09', true], ['2027-07-27', '2027-07-28', false], ['2027-09-14', '2027-09-15', true],
        ['2027-10-26', '2027-10-27', false], ['2027-12-07', '2027-12-08', true],
      ] as [string, string, boolean][],
    },
  },
  // Federal Register final rules (JSON API, no key). The AI sees only each document's `abstract`;
  // documents without one are skipped. Reuse permitted (1 CFR 2.6); public-domain copy limit.
  fedRegister: {
    endpoint: 'https://www.federalregister.gov/api/v1/documents.json',
    // One document by number ({doc}), used by --rewrite to re-read a rule's abstract.
    documentEndpoint: 'https://www.federalregister.gov/api/v1/documents/{doc}.json',
    perPage: 20,
    // Query B: final rules from agencies whose rules reach people's wallets (consumer finance, airline
    // passengers, taxes, phones and internet, energy bills, student loans). CFTC, Labor and export
    // controls were dropped (2026-10-17): mostly institutional rules. The AI's everyday_relevance score
    // filters what is left; template cards are never published for Federal Register rules.
    agencies: ['consumer-financial-protection-bureau', 'transportation-department', 'federal-trade-commission',
      'internal-revenue-service', 'treasury-department', 'federal-reserve-system', 'securities-and-exchange-commission',
      'federal-communications-commission', 'energy-department', 'education-department'],
    // Query A: significant final rules from any agency. Off since 2026-10-17: it surfaced park hunting
    // rules, staff appraisals and immigration penalties. false = only query B.
    significantQuery: false,
    fields: ['title', 'abstract', 'html_url', 'publication_date', 'agencies', 'document_number', 'type'],
    maxAgeDays: 90,
    // FAA airworthiness directives (title contains "Airworthiness Directives") are near-identical aircraft
    // fix orders that flooded the feed (4 in a row on 2026-10-17). At most this many become card candidates
    // per run; the rest are skipped and logged as faa_directive_cap.
    maxAirworthinessPerRun: 1,
    category: 'policy',                        // fixed in code; event_type stays null (ranking 'default')
    attributionPrefix: 'Source: Federal Register (National Archives)',
    // No published rate limit: poll at most hourly (2 requests per run). Not enforced; the CLI is run by hand.
    minPollMinutes: 60,
  },
  // Importance override used by src/ranking.ts (the TypeScript mirror of the database formula). An FAA
  // airworthiness directive is capped at this importance (default policy rule = 2 x 1.25 = 2.5 otherwise)
  // so it stops leading Trending. The database formula needs the same change in a migration.
  ranking: {
    airworthinessImportance: 1.5,
  },
  secTickersUrl: 'https://www.sec.gov/files/company_tickers_exchange.json',
  // Per-company filing list (JSON, data.sec.gov, API host list). {cik} = 10-digit CIK.
  secSubmissionsUrl: 'https://data.sec.gov/submissions/CIK{cik}.json',
  secLookbackDays: 90,                        // per-company 8-Ks filed within this many days
  // Earnings press release. An Item 2.02 8-K is usually a cover page; the figures sit in the EX-99.1
  // exhibit (a page on www.sec.gov, so the page host list already allows it). For a filing with one of
  // these items the exhibit is fetched through the same limiter and cache and its text goes to the AI
  // FIRST (capped like the primary document at sourceTextMaxChars), then at most primaryMaxChars of the
  // primary document. `types` = exhibit types in order of preference.
  secExhibit: {
    items: ['2.02'],
    types: ['EX-99.1', 'EX-99.01', 'EX-99'],
    primaryMaxChars: 3000,
  },
  // A card whose event_type is earnings must have at least one digit in its body (validator reason
  // no_figures). For SEC filings the rule applies to filings with one of requiredItems (2.02 results);
  // a card from 4.01 (auditor change) or 4.02 (restatement notice) alone is exempt: news without a results
  // table. Template cards are held to the same rule, so a figure-less Item 2.02 template card is skipped.
  earningsFigures: {
    requiredItems: ['2.02'],
  },
  // Household-name US public companies (by ticker), weighted toward brands college students and young
  // adults know and use. SEC cards are only made for these. CIKs are resolved from the SEC ticker list
  // at run time; a ticker missing from that list is logged and skipped. Left out on purpose:
  // Spotify (foreign filer, files 6-K not 8-K), Electronic Arts and Walgreens (taken private; not in
  // the SEC ticker list on 2026-10-17).
  watchCompanies: [
    'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'NFLX', 'SNAP', 'RDDT', 'RBLX', 'TTWO', 'PINS', 'MTCH', 'BMBL', 'DUOL', 'ADBE', 'CRM', 'ORCL', 'INTC', 'AMD', 'QCOM', 'AVGO', 'IBM', 'DELL', 'NOW', 'CSCO', 'TXN', 'AMAT', 'MU', 'LRCX', 'KLAC', 'ADI', 'PANW', 'CRWD', 'PLTR',
    'DIS', 'WBD', 'PSKY', 'ROKU', 'SIRI', 'LYV', 'AMC', 'CMCSA', 'CHTR', 'VZ', 'T', 'TMUS',
    'UBER', 'LYFT', 'DASH', 'ABNB', 'BKNG', 'EXPE', 'ETSY', 'EBAY', 'CVNA', 'W', 'CHWY', 'PTON', 'GME',
    'HOOD', 'SOFI', 'COIN', 'PYPL', 'XYZ', 'V', 'MA', 'AXP', 'AFRM', 'SLM', 'NNI', 'COF', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'SCHW', 'SYF', 'USB', 'PNC', 'TFC', 'BK', 'STT', 'BLK', 'ICE', 'CME', 'SPGI', 'MCO',
    'WMT', 'TGT', 'COST', 'HD', 'LOW', 'BBY', 'KR', 'DG', 'DLTR', 'TJX', 'ROST', 'GAP', 'ANF', 'AEO', 'URBN', 'LULU', 'NKE', 'CROX', 'DECK', 'UAA', 'ELF', 'ULTA', 'M', 'JWN', 'FIVE', 'ORLY', 'AZO', 'TSCO',
    'CMG', 'SBUX', 'MCD', 'YUM', 'DPZ', 'WING', 'CAVA', 'SHAK', 'DRI', 'KO', 'PEP', 'KDP', 'MNST', 'CELH', 'PG', 'HSY',
    'F', 'GM', 'RIVN', 'LCID', 'DAL', 'UAL', 'AAL', 'LUV', 'JBLU', 'ALK', 'MAR', 'HLT', 'CCL', 'RCL', 'NCLH', 'LMT', 'RTX', 'GD', 'NOC', 'HON', 'CAT', 'DE', 'GE', 'MMM',
    'CVS', 'UNH', 'PFE', 'MRNA', 'JNJ', 'LLY', 'ABBV', 'MRK', 'BMY', 'AMGN', 'GILD', 'HIMS',
    'BA', 'XOM', 'CVX', 'UPS', 'FDX', 'BRK-B',
    'Z', 'RKT', 'CHGG', 'COUR', 'PGR', 'ALL', 'EFX', 'TRU', 'FICO', 'HRB', 'INTU',
  ],
  // 8-K items that may become a card for a watch-list company: earnings, CEO/CFO changes, big deals,
  // layoffs/restructuring, cyber incidents, restatements, bankruptcy. Anything else is skipped.
  watchItems: ['1.01', '1.03', '1.05', '2.01', '2.02', '2.03', '2.04', '2.05', '2.06', '4.02', '5.02'],
  // A filing whose only card item is 5.02 is kept only if the Item 5.02 text names one of these roles
  // together with a change word (routine director-only changes and pay plans are skipped).
  topRolePattern: /\b(chief executive officer|chief financial officer|ceo|cfo|chair|chairman|chairwoman|chairperson|(?<!vice )president)\b/i,
  roleChangePattern: /\b(resign\w*|retire\w*|appoint\w*|depart\w*|step(?:s|ped)? down|succeed\w*|successor|named|terminat\w*|separat\w*|transition\w*)\b/i,
  // Template cards (no AI, so no relevance score) only for these items of watch-list companies.
  templateSecItems: ['2.02', '5.02', '1.05', '4.02', '2.05', '2.03'],
  // AI everyday_relevance score (1-5) below this: the card is not published (logged as low_relevance).
  minEverydayRelevance: 3,
  // Optional boost for watch-list cards. NOT applied: importance is computed only in the ranking SQL
  // (core.refresh_rank), and the task said to skip the boost if it touches that SQL.
  watchCompanyBoost: 1.5,
  // 8-K items we turn into cards.
  sec8kItems: ['1.01', '1.02', '1.03', '1.05', '2.01', '2.02', '2.03', '2.04', '2.05', '2.06', '3.01', '4.01', '4.02', '5.02', '7.01', '8.01'],
  // Low-value items: a filing whose items are only these (Reg FD, other events, exhibits) is
  // skipped before any page fetch or AI call, unless it also has a substantive tracked item.
  sec8kLowValueItems: ['7.01', '8.01', '9.01'],
  // When the 8-K items do not decide an SEC card's event_type, the AI's choice is kept only
  // if it is one of these (all known to core.rank_event_weights); otherwise null ('default').
  secAiEventTypes: ['earnings', 'deal', 'exec_change', 'insider'],
  pollIntervalMinutes: 10,                     // for `--loop`

  // ---- broad topics (PM review 2, D-32) ---------------------------------------------
  // Wikipedia "In the news" -> world. Today's UTC date only (the news list exists only for the
  // current date); a missing `news` key = 0 items. AI text = story sentence + links[0].extract.
  wiki: {
    featuredUrl: 'https://en.wikipedia.org/api/rest_v1/feed/featured/{yyyy}/{mm}/{dd}',
    // How many UTC days of "In the news" feeds one run reads, today included (3 = today and the 2
    // days before). Stories are deduplicated across days by external_id and URL; a day whose feed
    // fails or has no `news` list is logged and skipped. The same allowlisted API and parser are used.
    // Live 2026-10-17: the past-day feeds had 0 news stories (the featured feed lists news only for
    // the current day), so 1 = today only. Raise it if the API starts returning past news.
    lookbackDays: 1,
    aiTextMaxChars: 1500,
    category: 'world',
    eventType: 'world_event',
    // Wikimedia User-Agent policy: "<client>/<version> (<contact>) <library>". The contact is taken
    // from SEC_USER_AGENT at run time; it is never hard-coded.
    clientName: 'Element/0.1',
    library: 'node-fetch',
  },
  // CPSC recalls -> safety / recall. JSON API, no key. License PARTLY verified (17 U.S.C. 105;
  // the CPSC policy page could not be read). AI text = Title + Description + Hazards + Remedies.
  cpsc: {
    url: 'https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart={start}',
    // 14 days (was 180): the 180-day backfill made 59% of the 14-day catalog recalls (R-218, macro focus).
    lookbackDays: 14,
    rewriteLookbackDays: 120,                   // --rewrite looks this far back to find an old recall again
    // Recalls can flood the feed (PM review 2): at most this many NEW recalls are processed per run.
    // Recalls an earlier run already handled do not count, so each run moves on to the next
    // unprocessed recall inside the lookback window (newest first).
    maxPerRun: 5,                                // was 100 (R-218 macro focus)
    // "Material" recall (20261116000000_macro_focus.sql): only these are shown in Trending, Latest and For you;
    // every recall stays in the Recalls & Safety topic, the company page and search. Material when ANY holds:
    // units >= materialMinUnits; units x highest listed price >= materialMinValueUsd; reported deaths or serious
    // injuries (Injuries text, not the hazard wording: almost every title says "risk of serious injury or death");
    // a stop-sale; or the recalling firm (title before "Recalls", manufacturers, importers, distributors; NOT
    // retailers, since most small recalls are sold on Amazon) is a watch-list company (watchNames).
    materialMinUnits: 100_000,
    materialMinValueUsd: 10_000_000,
    // true (Drew, 2026-11-09): a watch-list company's recall is material even when small. false = the company link is
    // still stored (tickers) but only the other rules decide. SQL backfill twin: rank_params micro_watch_material.
    watchCompanyMaterial: true as boolean,
    // recalling-firm name pattern -> watch-list ticker (config.watchCompanies).
    // Each pattern is matched as whole words, case-insensitive (cpsc.ts wraps it in \b(?:...)\b).
    watchNames: [
      ['3M', 'MMM'], ['wal-?mart', 'WMT'], ['target corp(oration)?', 'TGT'], ['costco', 'COST'],
      ['home depot', 'HD'], ["lowe'?s", 'LOW'], ['best buy', 'BBY'], ['amazon([.]com)?', 'AMZN'],
      ['apple inc', 'AAPL'], ['microsoft', 'MSFT'], ['dell', 'DELL'], ['nike', 'NKE'],
      ['lululemon', 'LULU'], ['gap inc|old navy|banana republic', 'GAP'], ['abercrombie', 'ANF'],
      ['american eagle', 'AEO'], ['urban outfitters', 'URBN'], ['peloton', 'PTON'], ['tesla', 'TSLA'],
      ['ford motor', 'F'], ['general motors', 'GM'], ['procter (&|and) gamble', 'PG'], ['hershey', 'HSY'],
      ['pepsico', 'PEP'], ['coca-cola', 'KO'], ['(walt )?disney', 'DIS'], ['dollar general', 'DG'],
      ['dollar tree|family dollar', 'DLTR'], ['tjx|t[.]?j[.]? maxx|marshalls|homegoods', 'TJX'],
      ['ross stores', 'ROST'], ['ulta beauty', 'ULTA'], ['five below', 'FIVE'], ['crocs', 'CROX'],
      ['deckers|ugg|hoka', 'DECK'], ['under armour', 'UAA'], ['e[.]l[.]f[.]? cosmetics', 'ELF'],
      ['chewy', 'CHWY'], ['wayfair', 'W'], ['honeywell', 'HON'], ['caterpillar', 'CAT'],
      ['deere', 'DE'], ['kroger', 'KR'], ['tractor supply', 'TSCO'], ['starbucks', 'SBUX'],
      ["mcdonald'?s", 'MCD'], ['etsy', 'ETSY'], ['ebay', 'EBAY'], ["macy'?s", 'M'], ['nordstrom', 'JWN'],
    ] as ReadonlyArray<readonly [string, string]>,
    category: 'safety',
    eventType: 'recall',
    sourceName: 'U.S. Consumer Product Safety Commission',
    attribution: 'Source: U.S. Consumer Product Safety Commission',
  },
  // NASA news releases -> science. RSS, no key; only links under linkPrefix (drops APOD and image
  // articles); AI text = the release text in content:encoded without figures or captions.
  nasa: {
    feedUrl: 'https://www.nasa.gov/news-release/feed/',
    linkPrefix: 'https://www.nasa.gov/news-release/',
    // The feed returns only its 10 newest posts (WordPress default) and mixes in APOD, image articles and
    // blog posts, so on 2026-10-17 just 1 of 10 items was a news release. The link-prefix filter is
    // correct and stays; releases are infrequent, so the age window is 14 days (was 7) and the run also
    // reads `feedPages - 1` older pages of the same feed (WordPress `?paged=N`, same allowlisted host).
    // An older page that fails is logged and skipped.
    maxAgeDays: 90,
    feedPages: 1,                               // live 2026-10-17: ?paged=2 answered HTTP 403, so only page 1 is read
    category: 'science',
    eventType: 'science',
    attribution: 'Source: NASA',
  },
  // USGS significant earthquakes -> science. Template card, no AI.
  usgs: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson',
    maxAgeDays: 7,
    // Publishing threshold. PAGER alerts in keepAlerts are always published. A quake whose alert is green
    // or missing is skipped (logged as low_interest) when it is at sea / on an ocean ridge or rise / has no
    // country in its place name, OR when its magnitude is under minMagnitudeWithoutAlert.
    keepAlerts: ['yellow', 'orange', 'red'],
    minMagnitudeWithoutAlert: 6.5,
    // Place names that mean open water even when they have a comma (the usual case is no comma at all:
    // "central Mid-Atlantic Ridge" has no country).
    atSeaPattern: /\b(ridge|rise|ocean|sea|trench|seamounts?|fracture zone)\b/i,
    category: 'science',
    eventType: 'science',
    sourceName: 'U.S. Geological Survey',
    attribution: 'Credit: U.S. Geological Survey',
  },

  // ---- brief summary and brief email (spec: docs/work/spec-brief-email.md) -------------
  mail: {
    siteUrl: 'https://element-news.pages.dev',
    timezone: 'America/New_York',              // the "day" and "week" of a brief summary; a subscriber's own tz decides when their email is due
    defaultSendHour: 7,
    // Daily brief window (D-119): 24 h; Monday 72 h, labelled "since Friday". Mirrors core.brief_window_hours (migration 20261125000000).
    dailyWindowHours: 24,
    mondayWindowHours: 72,
    fallbackMaxHours: 720,                     // never-empty brief: reach back at most this far for the last good cards
    // Brief summary (one AI call per brief per day/week): 3-5 sentences, at most this many words.
    summaryMinSentences: 8,
    summaryMaxSentences: 26,
    summaryMaxWords: 290, summaryMinWords: 200, summaryTargetWords: 250, summaryParagraphs: [3, 4] as readonly number[],
    // Topic sections with these categories are left out of the text the AI summarizes (recalls and space or science items belong
    // in the summary only when they are TOP STORIES: sum-v7 brief rule; the model ignored the written rule in 3 of 3 live runs).
    summarySkipSectionCategories: ['safety', 'science'] as readonly string[],
    summaryCopyLimitWords: 10,                 // longest run copied from the brief's own cards (they are already short rewrites)
    summaryMaxTokens: 3000,                     // includes Groq reasoning tokens
    // Email provider. 'outbox' writes files; 'resend' needs RESEND_API_KEY + EMAIL_FROM + the --send flag.
    outboxDir: 'outbox',
    resendEndpoint: 'https://api.resend.com/emails',
    resendHost: 'api.resend.com',
    maxPerRun: 100,                            // emails per run (Resend free tier: 100/day, 3,000/month)
    maxConsecutiveErrors: 3,                   // stop sending after this many provider errors in a row
    // Email layout: how many stories where (the email shows breadth: many topics, few stories each).
    email: {
      topStories: 3,
      marketCards: 4,
      topicSections: 6,
      cardsPerTopTopic: 2,                     // topics ranked 1-3
      cardsPerOtherTopic: 1,
      numbers: 8,
    },
  },
} as const;

/** Federal Register query URLs: [query B (agencies), query A (significant, if enabled)]. */
export function fedRegisterUrls(f: {
  endpoint: string; perPage: number; agencies: readonly string[]; significantQuery: boolean; fields: readonly string[];
} = config.fedRegister): string[] {
  const common = [`per_page=${f.perPage}`, 'order=newest', 'conditions[type][]=RULE'];
  const fields = f.fields.map((x) => `fields[]=${x}`);
  const b = [...common, ...f.agencies.map((a) => `conditions[agencies][]=${a}`), ...fields];
  const urls = [`${f.endpoint}?${b.join('&')}`];
  if (f.significantQuery) urls.push(`${f.endpoint}?${[...common, 'conditions[significant]=1', ...fields].join('&')}`);
  return urls;
}

/** Effective daily AI call cap: min(code cap, verified free requests per day). */
export function aiDailyCap(freeRpd: number | null = config.gemini.freeRpd): number {
  return freeRpd == null ? config.aiDailyCapCode : Math.min(config.aiDailyCapCode, freeRpd);
}

/** Effective Groq daily cap: min(code cap, RPD, floor(TPD / estimated tokens per call)). */
export function groqDailyCap(g: {
  dailyCapCode: number; freeRpd: number | null; freeTpd: number | null; estimatedTokensPerCall: number;
} = config.groq): number {
  let cap = g.dailyCapCode;
  if (g.freeRpd != null) cap = Math.min(cap, g.freeRpd);
  if (g.freeTpd != null) cap = Math.min(cap, Math.floor(g.freeTpd / g.estimatedTokensPerCall));
  return cap;
}

/**
 * Groq daily cap from a MEASURED tokens-per-call figure (prompt + source text + output, reasoning tokens included, from
 * Groq's usage field or the console). For when no cap has been set, or after a prompt change (sum-v7) moves the cost per call:
 *   cap = min(freeRpd, floor(freeTpd x safety / measuredTokensPerCall))   (the code cap is NOT applied: this is the budget)
 * The 0.9 safety factor keeps room for retries and the Brief. Returns 0 for a missing or non-positive measurement
 * (callers keep the existing cap then). Not wired into groqDailyCap(): it is a calculator, the cap itself is set elsewhere.
 * Example: 200,000 TPD / 2,700 tokens = 74 (the current cap, no safety); 200,000 x 0.9 / 3,200 = 56.
 */
export function groqCapFromMeasuredTokens(measuredTokensPerCall: number | null | undefined, g: { freeRpd: number | null; freeTpd: number | null } = config.groq, safety = 0.9): number {
  if (!measuredTokensPerCall || !Number.isFinite(measuredTokensPerCall) || measuredTokensPerCall <= 0) return 0;
  let cap = g.freeTpd != null ? Math.floor((g.freeTpd * safety) / measuredTokensPerCall) : Number.POSITIVE_INFINITY;
  if (g.freeRpd != null) cap = Math.min(cap, g.freeRpd);
  return Number.isFinite(cap) ? Math.max(0, cap) : 0;
}

/** Groq pacing in ms: the largest of the RPM gap, the TPM gap for one estimated call, and the floor. */
export function groqMinIntervalMs(g: {
  freeRpm: number | null; freeTpm: number | null; estimatedTokensPerCall: number; minIntervalMsFloor: number;
} = config.groq, factor: number = config.rpmSafetyFactor): number {
  const rpmGap = g.freeRpm ? Math.ceil(60_000 / (g.freeRpm * factor)) : 0;
  const tpmGap = g.freeTpm ? Math.ceil((60_000 * g.estimatedTokensPerCall) / (g.freeTpm * factor)) : 0;
  return Math.max(rpmGap, tpmGap, g.minIntervalMsFloor);
}

/** Minimum gap between calls to one provider, from its requests-per-minute limit and the safety factor. */
export function minIntervalMs(freeRpm: number | null, whenUnknown: number, factor: number = config.rpmSafetyFactor): number {
  return freeRpm == null || freeRpm <= 0 ? whenUnknown : Math.ceil(60_000 / (freeRpm * factor));
}

// ---- environment ----------------------------------------------------------------

export interface Env {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  geminiApiKey: string | null;
  groqApiKey: string | null;
  fredApiKey: string | null;
  secUserAgent: string;
}

const PLACEHOLDER = /^$|your|example|xxx|<|>|changeme|placeholder/i;

/**
 * Reads and checks the environment. Throws (without printing any key value) if a
 * required value is missing or still a placeholder.
 */
export function readEnv(env: Record<string, string | undefined>, opts: { dryRun?: boolean } = {}): Env {
  const get = (k: string) => (env[k] ?? '').trim();
  const problems: string[] = [];

  const supabaseUrl = get('SUPABASE_URL');
  const key = get('SUPABASE_SERVICE_ROLE_KEY');
  const ua = get('SEC_USER_AGENT');

  if (!opts.dryRun) {
    if (PLACEHOLDER.test(supabaseUrl) || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
      problems.push('SUPABASE_URL is missing or a placeholder (expected https://<ref>.supabase.co)');
    }
    if (PLACEHOLDER.test(key) || key.length < 20) {
      problems.push('SUPABASE_SERVICE_ROLE_KEY is missing or a placeholder');
    }
    if (PLACEHOLDER.test(ua) || !/\S+@\S+\.\S+/.test(ua)) {
      problems.push('SEC_USER_AGENT must be "<app name> <contact email>"');
    }
  }
  if (problems.length) throw new Error('Environment not ready:\n- ' + problems.join('\n- '));

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    supabaseServiceRoleKey: key,
    geminiApiKey: get('GEMINI_API_KEY') || null,
    groqApiKey: get('GROQ_API_KEY') || null,
    fredApiKey: get('FRED_API_KEY') || null,
    secUserAgent: ua,
  };
}

/** Safe description of an Env for logs: never prints key values. */
export function describeEnv(e: Env): string {
  return [
    `SUPABASE_URL=${e.supabaseUrl}`,
    `SUPABASE_SERVICE_ROLE_KEY=${e.supabaseServiceRoleKey ? '[set]' : '[missing]'}`,
    `GEMINI_API_KEY=${e.geminiApiKey ? '[set]' : '[missing]'}`,
    `GROQ_API_KEY=${e.groqApiKey ? '[set]' : '[missing]'}`,
    `FRED_API_KEY=${e.fredApiKey ? '[set]' : '[missing]'}`,
    `SEC_USER_AGENT=${e.secUserAgent ? '[set]' : '[missing]'}`,
  ].join(' ');
}
