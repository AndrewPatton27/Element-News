// Internal types for the ingest pipeline (the public card shape is in contract/types.ts).
// Types only, no runtime code: RawItem (collected item), SummaryDraft / Summarizer (AI or template
// output), PublishPayload / RevisePayload / MacroObservation (database RPC payloads).

import type { CardDetail, CategorySlug, Exchange, MacroFact, SourceKind } from '../../contract/types.ts';

export type LicenseClass = 'public_domain' | 'company_filing' | 'cc_by_sa';

/** One collected item, ready for summarizing. */
export interface RawItem {
  source: 'sec_8k' | 'fed_rss' | 'bea_rss' | 'fedreg' | 'wiki_itn' | 'cpsc' | 'usgs' | 'nasa';
  external_id: string;
  url: string;                       // the page we cite (and may fetch: allowlisted hosts only)
  title: string;
  published_at: string;              // ISO, primary source time
  license_class: LicenseClass;
  category: CategorySlug;
  event_type: string | null;
  tickers: TickerRef[];
  source_name: string;               // "SEC", "Federal Reserve Board"
  source_kind: SourceKind;
  doc_label: string;                 // "Form 8-K", "Press release"
  company?: string;                  // SEC only, display name
  agency?: string;                   // Federal Register only: issuing (sub-)agency
  items?: { number: string; title: string }[];   // SEC 8-K items
  summary_text: string;              // short licensed text from the feed itself
  attribution?: string;              // credit line shown on the card (BEA: "Source: U.S. Bureau of Economic Analysis")
}

export interface TickerRef {
  symbol: string;
  name: string;
  exchange: Exchange | null;
}

/** What a summarizer returns (before validation). */
export interface SummaryDraft {
  headline: string;
  body: string | null;
  category: string;
  event_type: string | null;
  tickers: string[];
  /** AI only: 1-5, would a typical young adult notice or be affected? Not part of the card. */
  everyday_relevance?: number | null;
  /** In-depth summary (shown when the card is opened); null = none. */
  detail?: CardDetail | null;
}

export interface SummarizeInput {
  item: RawItem;
  text: string;                      // licensed source text (feed text + page text)
  retryErrors?: string[];            // validator errors from the previous attempt
}

export interface Summarizer {
  name: string;
  /** true if this provider sends text to an AI model (counts toward the daily cap) */
  usesAi: boolean;
  /** model ID this provider calls (recorded on the card); null/undefined for non-AI */
  model?: string | null;
  /** max calls per UTC day for this provider (AI providers) */
  dailyCap?: number;
  /** min gap between two calls to this provider, in ms (its requests-per-minute limit) */
  minIntervalMs?: number;
  /** Optional compact JSON scoring call for editorial report-card providers. */
  generate?(prompt: string): Promise<string>;
  summarize(input: SummarizeInput): Promise<SummaryDraft>;
}

/** Payload for api.publish_blurb. */
export interface PublishPayload {
  dedupe_key: string;
  item_id?: string;
  kind: 'summary' | 'data';
  headline: string;
  body: string | null;
  category: string;
  event_type: string | null;
  ai_generated: boolean;
  tickers: TickerRef[];
  macro: MacroFact[];
  as_of: string;
  sort_at: string;
  model: string | null;
  prompt_version: string | null;
  attribution: string | null;
  detail?: CardDetail | null;
  sources: {
    name: string;
    kind: SourceKind;
    doc_label: string | null;
    url: string;
    published_at: string;
    license_class: LicenseClass;
    attribution: string | null;
    is_primary: boolean;
  }[];
}

/** One row of api.blurbs_to_revise (a published card that --rewrite may redo). */
export interface RevisableCard {
  id: string;
  kind: 'summary' | 'data' | 'link_out';
  headline: string;
  body: string | null;
  category: string;
  event_type: string | null;
  ai_generated: boolean;
  prompt_version: string | null;
  tickers: TickerRef[];
  macro: MacroFact[];
  attribution: string | null;
  as_of: string;
  sort_at: string;
  dedupe_key: string;
  sources: PublishPayload['sources'];
  item: { source: string; external_id: string | null; url: string; title: string | null; license_class: string } | null;
}

/** Payload for api.revise_blurb. */
export type RevisePayload =
  | { id: string; action: 'revise'; headline: string; body: string | null; ai_generated: boolean; model: string | null; prompt_version: string; detail: CardDetail | null }
  | { id: string; action: 'hide'; note: string };

/** Payload for api.upsert_macro. */
export interface MacroObservation {
  series_id: string;
  obs_date: string;                  // YYYY-MM-DD
  value: number;
  display_value: string;
  change_text: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  period_label: string | null;
  /** size of the change in the threshold unit (points for rates, % for dollars and counts); not stored */
  move?: number | null;
}
