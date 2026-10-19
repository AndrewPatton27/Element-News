// One data interface, two implementations: sample fixtures (mock, the default) and
// the Supabase `api` schema over plain fetch. Screens only talk to this interface.

import type { AppConfig, BlurbCard, Brief, BriefSubscribeResult, BriefSubscriptionInput, BriefTokenResult, Category, CategorySlug, FeedMode, FeedPage, MacroFact, NumberTrend } from '../../contract/types.ts';
import { resolveApiConfig, readEnv, type ApiConfig } from './config.ts';
import { allCards, createMockApi } from './api.mock.ts';
import { createMockAccount, createSupabaseAccount, type AccountApi } from '../account/account.ts';
import { createSupabaseApi } from './api.supabase.ts';

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
  /** The 5 highest-ranked cards of the last 7 days, one per story. [] when unavailable. */
  topStories(): Promise<BlurbCard[]>;
  /** 10-yr Treasury, CPI, unemployment, WTI crude with a 12-point history. [] when unavailable. */
  numberTrends(): Promise<NumberTrend[]>;
  search(q: string, cursor?: string | null, limit?: number): Promise<FeedPage>;
  relatedCards(cardId: string, limit?: number): Promise<BlurbCard[]>;
  followingFeed(f: { topics: string[]; sources: string[]; tickers: string[]; cursor?: string | null; limit?: number }): Promise<FeedPage>;
  dailyBrief(): Promise<Brief>;
  weeklyBrief(): Promise<Brief & { movers: NumberTrend[] }>;
  /** Double opt-in email brief. Never throws; a missing RPC gives {ok:false, status:'unavailable'}. */
  subscribeBrief(i: { email: string } & BriefSubscriptionInput): Promise<BriefSubscribeResult>;
  confirmBrief(token: string): Promise<BriefTokenResult>;
  updateBriefSubscription(token: string, i: BriefSubscriptionInput): Promise<BriefTokenResult>;
  unsubscribeBrief(token: string): Promise<BriefTokenResult>;
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
