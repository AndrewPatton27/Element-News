// Shared card contract between the back end (Supabase `api` schema) and the app.
//
// Rules for this file:
// - Erasable TypeScript only: types and interfaces, no enums, namespaces or
//   parameter properties, so it runs under Node type stripping and Metro alike.
// - Keys are snake_case, exactly as returned by the `api` RPCs and views.
// - Import with `import type { ... } from '.../contract/types.ts'`.
// - Frozen. Changes go through review (see README.md).
// - Changed 2026-10-17 by PM review 2 (additive only): categories world, science, safety;
//   license class cc_by_sa; event types world_event, recall, science.
// - Changed 2026-10-17 (D-37, additive): BlurbCard.detail, the in-depth summary shown when a card is opened.

/** Card kinds. 'link_out' is reserved and never produced in v1; the app skips it. */
export type BlurbKind = 'summary' | 'data' | 'link_out';

/** Feed ordering. 'top' = ranked (importance + recency), 'latest' = newest first. */
export type FeedMode = 'top' | 'latest';

export type CategorySlug =
  | 'markets'
  | 'earnings'
  | 'economy'
  | 'policy'
  | 'tech'
  | 'deals'
  | 'energy'
  | 'insider'
  | 'personal-finance'
  | 'world'
  | 'science'
  | 'safety';

/** Row of `api.categories`. */
export interface Category {
  slug: CategorySlug;
  name: string;
  sort_order: number;
}

export type LicenseClass =
  | 'public_domain'
  | 'company_filing'
  | 'guardian_noncomm'
  | 'link_out'
  | 'iex_hist'
  | 'cc_by_sa';                          // Wikipedia text (attribution + license link required)

export type Exchange = 'NYSE' | 'Nasdaq' | 'NYSE American' | 'Cboe';

export type SourceKind = 'filing' | 'government' | 'news';

/** Known event types. Unknown strings may appear; render them with a fallback. */
export type EventType =
  | 'earnings'
  | 'exec_change'
  | 'deal'
  | 'insider'
  | 'macro_release'
  | 'fed'
  | 'world_event'
  | 'recall'
  | 'science';

/** One number for the "numbers to know" panel, also used inside data cards. */
export interface MacroFact {
  series_id: string;                    // "DGS10"
  label: string;                        // "10-yr Treasury"
  value: string;                        // preformatted: "4.12%", "$61.40"
  change: string | null;                // signed with unit: "+0.05 pts", "-0.8%"
  direction: 'up' | 'down' | 'flat' | null;
  period: string | null;                // "Sep 2026" for monthly data, null for daily
  as_of: string;                        // ISO date or datetime
  source_name: string;                  // full citation: "U.S. Energy Information Administration via FRED"
  source_short: string;                 // compact label: "EIA via FRED" (never bare "FRED")
  source_url: string;
  sort_order: number;
}

/** One number with a small history chart (web right column). */
export interface NumberTrend {
  key: string;                          // "DGS10"
  name: string;                         // "10-year Treasury yield"
  value: string;                        // display string: "5.10%"
  change: string;                       // display string: "▼ 0.09 this week"
  direction: 'up' | 'down' | 'flat';
  source: string;                       // original agency: "U.S. Treasury"
  points: number[];                     // up to 12 weekly values, oldest first
}

/** A stock symbol on a card. Prices are never shown in v1: `quote` is always null. */
export interface Ticker {
  symbol: string;
  name: string;
  exchange: Exchange | null;
  quote: null;
}

/** A source link on a card. Every card has 1..8 of these; every one has a URL. */
export interface Source {
  name: string;                         // "SEC", "Federal Reserve Board"
  kind: SourceKind;
  doc_label: string | null;             // "Form 8-K", "Press release"
  url: string;                          // the original page, never a redirect
  published_at: string;                 // ISO
  license_class: LicenseClass;
  attribution: string | null;
  is_primary: boolean;
}

/**
 * In-depth summary shown when a card is opened. Plain language (about 8th-grade level):
 * 2-4 short paragraphs (<= 180 words in total) and 3-5 key points (each <= 15 words).
 * Same rules as the card: facts from the source only, no advice, no predictions.
 */
export interface CardDetail {
  paragraphs: string[];
  key_points: string[];
}

export interface StoryLink { kind: 'update' | 'angle' | 'related'; related_id: string; related_headline: string; }

export interface BlurbCard {
  id: string;                           // uuid
  kind: BlurbKind;                      // unknown kind -> the app skips the card
  headline: string;                     // <= 90 chars for summary/data
  body: string | null;                  // summary: <= 60 words; data: one template sentence
  category: CategorySlug;
  event_type: string | null;            // usually an EventType; unknown values allowed
  tickers: Ticker[];                    // 0..5
  macro: MacroFact[];                   // 0..3; filled for kind 'data'
  sources: Source[];                    // 1..8, primary first
  source_count: number;                 // distinct outlets, >= 1
  as_of: string;                        // primary source time (ISO)
  published_at: string;                 // our publish time (ISO)
  sort_at: string;                      // time used for 'latest' ordering (ISO)
  updated_at: string | null;            // set -> show an "Updated" tag
  revision: number;
  freshness: { delayed_hours: number | null };
  ai: {
    generated: boolean;                 // false for template cards (no AI involved)
    label: string | null;               // equals AppConfig.ai_notice when generated, else null
  };
  attribution: string | null;
  image: null;                          // never any image in v1
  is_saved: boolean;                    // always false for guests
  share_path: string;                   // "/b/<id>"
  importance?: number;                  // ranking input (about 1..20); optional, never shown
  detail?: CardDetail | null;           // in-depth summary; null or missing = none (older servers omit it)
  story_link?: StoryLink;
  follow_reason?: string;               // present on cards returned by api.following_feed
}

/** Response of `api.feed`. `next_cursor` null = end of feed. Treat the cursor as opaque. */
export interface FeedPage {
  items: BlurbCard[];
  next_cursor: string | null;
  /** Signed-in Trending / For you pages only, while ML shadow logging is on (migration
   *  20261019010000). Send it back with the 'view' event (api.track p_page). Absent otherwise. */
  page_id?: string;
}

/**
 * One topic in a brief. slug/rank/total were added by the depth update (all optional, so older
 * servers and mocks still fit): `rank` 1 = most important topic, `total` = eligible stories the
 * topic has in the window (`cards` holds only the top few), `slug` = category slug.
 */
export interface BriefSection {
  category: string;
  label: string;
  cards: BlurbCard[];
  slug?: string;
  rank?: number;
  total?: number;
}

/** Daily or weekly editorial brief assembled from published cards and macro facts. */
export interface Brief {
  generated_at: string;
  window_hours: number;
  headline_cards: BlurbCard[];
  sections: BriefSection[];
  numbers: MacroFact[];
  /** AI-written 3-5 sentence summary of the day/week, made once by the ingest job; null/missing = none. */
  summary?: BriefSummary | null;
  /** Market news cards (markets, earnings, deals) + market numbers. Empty cards = hide the section. */
  markets?: BriefMarkets;
}

/** Row of core.brief_summaries as returned inside the brief. Show with the AI label. */
export interface BriefSummary {
  text: string;
  generated_at: string;                 // ISO
  model: string;
}

/** "Markets" section of a brief. Never stock prices (rule 9). */
export interface BriefMarkets {
  cards: BlurbCard[];                   // up to 6, trending order, one per story
  numbers: MacroFact[];                 // DGS10, DGS2, DFF, DCOILWTICO when available
  total: number;                        // eligible market stories in the window
}

export type BriefKind = 'daily' | 'weekly' | 'both';

/** Input of api.subscribe_brief / api.update_brief_subscription. hour = local send hour 0..23. */
export interface BriefSubscriptionInput {
  kind: BriefKind;
  hour: number;
  tz: string;                           // IANA zone, e.g. "America/New_York"
}

/** 'pending' is returned for every valid address (never reveals if it is already subscribed). */
export type BriefSubscribeStatus = 'pending' | 'invalid' | 'limited' | 'unavailable';
export interface BriefSubscribeResult {
  ok: boolean;
  status: BriefSubscribeStatus;
}
export interface BriefTokenResult {
  ok: boolean;
  status?: 'unavailable';
}

export type NoticePlacement =
  | 'numbers_panel'
  | 'data_card'
  | 'share'
  | 'about'
  | 'ticker_chip';

export interface RequiredNotice {
  key: string;                          // "fred", "takedown"
  text: string;
  url: string | null;
  placements: NoticePlacement[];
}

/** Single row of `api.app_config`. */
export interface AppConfig {
  disclaimer: string;                   // shown on every card
  ai_notice: string;                    // shown on cards where ai.generated is true
  required_notices: RequiredNotice[];
  min_supported_app_version: string;
  quotes_enabled: boolean;              // false in v1
  linkout_cards: boolean;               // false in v1
}

/** Arguments of `api.feed` (PostgREST RPC body). */
export interface FeedParams {
  p_mode?: FeedMode;                    // default 'top'
  p_cursor?: string | null;             // next_cursor from the previous page
  p_limit?: number;                     // default 20, clamped to 10..30
  p_category?: CategorySlug | null;
}
