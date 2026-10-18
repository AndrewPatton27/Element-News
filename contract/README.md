# contract

The shared data contract between the back end (Supabase, `api` schema) and the app.

## Files

| File | What it is |
|---|---|
| `types.ts` | TypeScript types for every response the app reads: `BlurbCard`, `FeedPage`, `MacroFact`, `NumberTrend` (a 12-week series for the web Trends card), `AppConfig`, `RequiredNotice`, `Category`, `Source`, `Ticker`, `FeedMode`, `FeedParams`. Erasable TypeScript only (no enums or namespaces), so it can be imported with `import type` from Node scripts and the Expo app. |
| `account.ts` | Types and RPC bodies for signed-in users (`UserPrefs`, `ForYouPage`, `TrackParams`, ...). Described in `account.md`. |
| `account.md` | The accounts contract: sign-in calls, account RPCs, For you behaviour and scoring, account security and dashboard settings. |
| `fixtures/feed.page1.json` | `FeedPage`: first page of the `top` (Trending) feed (22 cards, all 9 original categories, summary and data cards) with a `next_cursor`. |
| `fixtures/feed.page2.json` | `FeedPage`: the following page, `next_cursor: null` (end of feed). Includes one sample card each for World (a Wikipedia-style `cc_by_sa` card with its attribution), Recalls & Safety and Science & Space. |
| `fixtures/feed.empty.json` | `FeedPage` with no cards. |
| `fixtures/feed_for_you.page1.json` | `ForYouPage`: 10 `[SAMPLE]` cards with `my_reaction`, for sample mode. |
| `fixtures/prefs.json` | `UserPrefs` sample (followed and hidden topics, reactions). |
| `fixtures/numbers_to_know.json` | `MacroFact[]` sample numbers (a subset of the live series). |
| `fixtures/app_config.json` | `AppConfig`: disclaimer, AI notice, required notices, feature flags. |
| `fixtures/categories.json` | `Category[]`: the 12 category slugs with display names, in display order. The live `api.categories` returns only categories that have at least one published card. |
| `fixtures/raw/` | Small samples of what the public sources return (SEC Atom, Fed RSS, FRED JSON, Treasury CSV), labeled REAL / RECONSTRUCTED / SYNTHETIC in `fixtures/raw/README.md`. |

## Where the data comes from

| Call | PostgREST request (header `Accept-Profile: api` / `Content-Profile: api`) | Type |
|---|---|---|
| `feed` | `POST /rest/v1/rpc/feed` with body `FeedParams` | `FeedPage` |
| `numbers_to_know` | `GET /rest/v1/numbers_to_know?order=sort_order` | `MacroFact[]` |
| `app_config` | `GET /rest/v1/app_config` (one row) | `AppConfig[]` |
| `categories` | `GET /rest/v1/categories?order=sort_order` | `Category[]` |

Signed-in calls (`feed_for_you`, `get_prefs`, `set_prefs`, `track`, ...) are listed in `account.md`. The mode `top` is shown in the app as **Trending**.

## Rules

- **Keys are snake_case**, exactly as the database returns them.
- **Forward compatibility.** Unknown `kind` -> skip the card. Unknown `category`, `event_type`, `license_class` or source `kind` -> render normally with a fallback. `link_out` is a reserved kind that is never produced in this version; the app skips it.
- **Every card** shows `AppConfig.disclaimer` ("Informational only · Not investment advice"). Cards with `ai.generated = true` also show `AppConfig.ai_notice` ("AI-generated summary · may contain errors"). Template cards have `ai.generated = false` and `ai.label = null`.
- `image` is always `null` and `tickers[].quote` is always `null`: no publisher images and no stock prices.
- `importance` is a ranking input. It is optional and is never shown.
- `detail` is the in-depth summary shown when a card is opened: `{paragraphs: string[], key_points: string[]}` (2-4 paragraphs, at most 180 words in total; 3-5 key points of at most 15 words each), written in plain language from the same source. It is `null` (or missing from older servers) when there is none; the app then shows only the card.
- `next_cursor` is opaque. Send it back unchanged; `null` means the end of the feed.
- Macro values always cite the original agency (`source_name`, `source_short`), never bare "FRED".
- Cards with a `cc_by_sa` source (Wikipedia) show their `attribution` (`Adapted from Wikipedia ("<title>") · CC BY-SA 4.0`) and link "CC BY-SA 4.0" to the `cc_by_sa` required notice URL.
- Display names can change without a contract change (2026-10-17: policy = Government, personal-finance = Money, markets = Business); slugs never change.

## Fixtures are samples

Every fixture card is fictional. Company names, tickers, numbers and links are made up, and every headline starts with `[SAMPLE]` so a build running on fixtures can never be mistaken for real news. The `numbers_to_know` values are also sample values.

## Changing the contract

The contract is frozen. Any change to `types.ts` or the fixture shapes needs review and must be made on both sides (database functions and app) in the same change.
