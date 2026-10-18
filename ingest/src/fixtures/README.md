# Fixtures for offline tests and `--dry-run`

Labels: **REAL** = verbatim fetched content. **RECONSTRUCTED** = every value comes from a live fetch, but the file was re-assembled field by field. **SYNTHETIC** = hand-made in the documented format. Each file says its label in its first line (or `_comment` field).

| File | Label |
|---|---|
| `sec-8k-item-2.02.atom.xml`, `sec-8k-item-5.02.atom.xml` | RECONSTRUCTED (SEC current 8-K Atom feed, 2026-10-17) |
| `sec-8k-feed.atom.xml` | RECONSTRUCTED (the two entries above in one feed) |
| `fed-press-monetary.rss.xml` | RECONSTRUCTED (Federal Reserve monetary policy RSS, 2026-10-17) |
| `treasury-par-yield-2026.csv` | REAL (header + 3 rows) |
| `fred-DGS10-observations.json` | SYNTHETIC (FRED JSON shape) |
| `sec-company-tickers-exchange.json` | SYNTHETIC (SEC ticker list shape) |
| `sec-filing-index.html`, `sec-primary-8k.html` | SYNTHETIC (generic filing pages, no company facts) |
| `sec-exhibit-99-1.html` | SYNTHETIC (generic EX-99.1 earnings press release with invented figures; the exhibit every Item 2.02 filing resolves to in the dry run and tests) |
| `fed-press-release.html` | SYNTHETIC (generic press-release page) |
| `fedreg-agencies.json` | REAL (Federal Register API query B, per_page=5, fetched 2026-10-17 22:06 UTC; byte-for-byte, so no label inside the file) |
| `fedreg-significant.json` | REAL (Federal Register API query A, per_page=4, fetched 2026-10-17 22:06 UTC; byte-for-byte, so no label inside the file) |
| `fedreg-null-abstract.json` | SYNTHETIC (API shape; one correction with `abstract: null`, modeled on document C1-2026-20019; neither live response had a null abstract) |
| `bea-releases.rss.xml` | SYNTHETIC (BEA news-release RSS shape; made-up URLs and numbers) |
| `wiki-featured-2026-10-17.json` | RECONSTRUCTED (Wikipedia REST featured feed for 2026-10-17, fetched 22:31 UTC; the `news` array verbatim, other keys dropped; text CC BY-SA 4.0) |
| `cpsc-recalls-2026-10-03.json` | REAL (saferproducts.gov recalls API, RecallDateStart=2026-10-03, fetched 2026-10-17 22:31 UTC, byte-for-byte, so no label inside the file) |
| `usgs-significant-week.geojson` | REAL (USGS significant_week.geojson, fetched 2026-10-17 22:31 UTC, byte-for-byte, so no label inside the file) |
| `nasa-news-release.rss.xml` | RECONSTRUCTED (NASA news-release RSS, fetched 2026-10-17 22:31 UTC; channel header and 3 of 10 items verbatim) |
| `nasa-news-release-page2.rss.xml` | SYNTHETIC (page 2 of the NASA feed, `?paged=2`: a 9-day-old and a 20-day-old news release, a repeat of the page 1 release, an image article and a blog post; fictional text) |
| `wiki-featured-2026-10-16.json` | SYNTHETIC (Wikipedia featured feed for the day before: one story that repeats the 10-17 feed, one fictional story only this day has; tests the cross-day dedupe) |
| `sec-company-tickers-watch.json` | RECONSTRUCTED (rows verbatim from SEC company_tickers_exchange.json, fetched 2026-10-17, filtered to the watch-list CIKs plus GoPro, LifeStance, Laser Photonics and Bridgeline Digital) |
| `sec-submissions-CIK0000320193.json` | RECONSTRUCTED (Apple's data.sec.gov submissions JSON, fetched 2026-10-17; identity fields and `filings.recent` verbatim, arrays filtered to the first 3 rows plus every 8-K / 8-K/A row) |
