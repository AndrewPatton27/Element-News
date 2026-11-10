// One data interface, two implementations: sample fixtures (mock, the default) and
// the Supabase `api` schema over plain fetch. Screens only talk to this interface.

import type { FeedStatus } from '../shared/types.ts';
import type { AppConfig, BlurbCard, Brief, BriefSubscribeResult, BriefSubscriptionInput, BriefTokenResult, Category, MyBriefChangeResult, MyBriefSubscription, CategorySlug, FeedMode, FeedPage, MacroFact, NumberTrend } from '../../contract/types.ts';
import { resolveApiConfig, readEnv, type ApiConfig } from './config.ts';
import { allCards, createMockApi } from './api.mock.ts';
import { createMockAccount, createSupabaseAccount, type AccountApi } from '../account/account.ts';
import { createSupabaseApi } from './api.supabase.ts';
import type { ReportReason, ReportResult } from './report.ts';
import type { CompanyApi } from '../companies/companyApi.ts';

export interface FeedRequest {
  mode: FeedMode;
  cursor?: string | null;
  category?: CategorySlug | null;
  limit?: number;
}

export interface Api {
  /** True when cards are fictional samples; the app must then show the SAMPLE DATA banner. */
  readonly sample: boolean;
  feed(req: FeedRequest): Promise<FeedPage>;
  categories(): Promise<Category[]>;
  numbersToKnow(): Promise<MacroFact[]>;
  appConfig(): Promise<AppConfig>;
  /** Freshness flag for the "Updates delayed" banner. Never throws: a missing RPC means not delayed. */
  feedStatus(): Promise<FeedStatus>;
  /** The 5 highest-ranked cards of the last 7 days, one per story. [] when unavailable. */
  topStories(): Promise<BlurbCard[]>;
  /** 10-yr Treasury, CPI, unemployment, WTI crude with a 12-point history. [] when unavailable. */
  numberTrends(): Promise<NumberTrend[]>;
  search(q: string, cursor?: string | null, limit?: number): Promise<FeedPage>;
  relatedCards(cardId: string, limit?: number): Promise<BlurbCard[]>;
  /** One published card by id (the /b/<id> share page). null when unknown, not published, or the server
   *  has no api.card_by_id yet; throws on a network or server error (the page shows Try again). */
  card(cardId: string): Promise<BlurbCard | null>;
  followingFeed(f: { topics: string[]; sources: string[]; tickers: string[]; cursor?: string | null; limit?: number }): Promise<FeedPage>;
  dailyBrief(): Promise<Brief>;
  weeklyBrief(): Promise<Brief & { movers: NumberTrend[] }>;
  /** Double opt-in email brief. Never throws; a missing RPC gives {ok:false, status:'unavailable'}. */
  subscribeBrief(i: { email: string } & BriefSubscriptionInput): Promise<BriefSubscribeResult>;
  confirmBrief(token: string): Promise<BriefTokenResult>;
  updateBriefSubscription(token: string, i: BriefSubscriptionInput): Promise<BriefTokenResult>;
  unsubscribeBrief(token: string): Promise<BriefTokenResult>;
  /** Signed-in reader's own email subscriptions. null = the server does not offer it (hide the section). */
  mySubscriptions(): Promise<MyBriefSubscription[] | null>;
  unsubscribeMine(kind: 'daily' | 'weekly'): Promise<MyBriefChangeResult>;
  /** status 'unavailable' when the RPC does not exist yet. */
  updateMyTime(kind: 'daily' | 'weekly', hour: number, tz: string): Promise<MyBriefChangeResult>;
  /** "Report a problem" on a card. Never throws. Backend contract: lib/api/report.ts (api.report_blurb). */
  reportBlurb(cardId: string, reason: ReportReason): Promise<ReportResult>;
  /** Company directory, company search, a company's cards and card -> company tags (lib/companies/companyApi.ts). */
  companies: CompanyApi;
}

export type ApiResult = { ok: true; api: Api; account: AccountApi } | { ok: false; error: string };

let cached: ApiResult | null = null;

export function buildApi(config: ApiConfig): ApiResult {
  if (!config.ok) return { ok: false, error: config.error };
  if (config.mode === 'mock') return { ok: true, api: createMockApi(), account: createMockAccount(allCards) };
  const account = createSupabaseAccount({ url: config.url, key: config.key });
  return { ok: true, api: createSupabaseApi({ url: config.url, key: config.key, getToken: () => account.accessToken() }), account };
}

// A config error is returned, not hidden: the root layout shows it full screen.
export function getApi(): ApiResult {
  if (!cached) cached = buildApi(resolveApiConfig(readEnv()));
  return cached;
}
