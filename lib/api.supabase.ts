// Supabase `api` schema over plain fetch (PostgREST). No supabase-js.
// Only the project URL and the publishable key are used; never a secret key.
// No React imports, so node --test can run it with a fake fetch.

import type { Api, FeedRequest } from './api.ts';
import type { BlurbCard, Brief, FeedPage, MacroFact, NumberTrend } from '../contract/types.ts';
import { NETWORK_MESSAGE, friendlyHttpError, parseErrorBody, warnRaw } from './errors.ts';
import { clampLimit } from './feedLogic.ts';
import { takeEarlyFeed, type EarlyFeed } from './earlyFeed.ts';
import { isBlurbCard, isMacroFact, isValidBriefInput, normalizeBriefEmail, parseAppConfig, parseBriefMarkets, parseBriefSummary, parseCategories, parseFeedPage, parseMacroFacts, parseNumberTrends, parseSubscribeResult, parseTokenResult } from './types.ts';

export interface SupabaseOptions {
  url: string; // https://<project>.supabase.co, no trailing slash
  key: string; // publishable key
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string | null>; // signed-in user's access token, if any
}

export class ApiError extends Error {
  status: number;
  /** The server's own text, for developers; `message` is the short friendly line readers see. */
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export interface PlannedRequest {
  url: string;
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };
}

// The api schema is selected per request with Accept-Profile (reads) and
// Content-Profile (RPC calls), so the project only needs `api` exposed.
export function planRequest(
  base: string,
  key: string,
  op: 'feed' | 'categories' | 'numbers' | 'config' | 'top_stories' | 'number_trends' | 'search' | 'related_cards' | 'following_feed' | 'daily_brief' | 'weekly_brief',
  req?: FeedRequest & { q?: string; cardId?: string; topics?: string[]; sources?: string[]; tickers?: string[] },
  token?: string | null,
): PlannedRequest {
  const headers: Record<string, string> = { apikey: key, Accept: 'application/json', 'Accept-Profile': 'api' };
  // Signed in: send the user's token so the server knows who is reading.
  if (token) headers.Authorization = `Bearer ${token}`;
  if (op === 'feed') {
    const body = {
      p_mode: req?.mode ?? 'top',
      p_cursor: req?.cursor ?? null,
      p_limit: clampLimit(req?.limit),
      p_category: req?.category ?? null,
    };
    return {
      url: `${base}/rest/v1/rpc/feed`,
      init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Profile': 'api' }, body: JSON.stringify(body) },
    };
  }
  if (op === 'top_stories' || op === 'number_trends') {
    return {
      url: `${base}/rest/v1/rpc/${op}`,
      init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Profile': 'api' }, body: '{}' },
    };
  }
  if (op === 'search' || op === 'related_cards' || op === 'following_feed' || op === 'daily_brief' || op === 'weekly_brief') {
    const extra = req;
    const bounded = (value: number | undefined, fallback: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(value) ? Math.trunc(value as number) : fallback));
    const rpcBody = op === 'search'
      ? { p_q: String(extra?.q ?? '').slice(0, 80), p_cursor: req?.cursor ?? null, p_limit: bounded(req?.limit, 20, 30) }
      : op === 'related_cards'
        ? { p_card_id: extra?.cardId, p_limit: bounded(req?.limit, 5, 10) }
        : op === 'following_feed'
          ? { p_topics: extra?.topics ?? [], p_sources: extra?.sources ?? [], p_tickers: extra?.tickers ?? [], p_cursor: req?.cursor ?? null, p_limit: bounded(req?.limit, 20, 30) }
          : {};
    return { url: `${base}/rest/v1/rpc/${op}`, init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Profile': 'api' }, body: JSON.stringify(rpcBody) } };
  }
  const path = {
    categories: 'categories?select=*&order=sort_order',
    numbers: 'numbers_to_know?select=*&order=sort_order',
    config: 'app_config?select=*&limit=1',
  }[op];
  return { url: `${base}/rest/v1/${path}`, init: { method: 'GET', headers } };
}

export function createSupabaseApi(opts: SupabaseOptions): Api {
  const doFetch = opts.fetchFn ?? ((input, init) => fetch(input, init));

  async function call(plan: PlannedRequest): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(plan.url, plan.init);
    } catch {
      throw new ApiError(NETWORK_MESSAGE, 0);
    }
    if (!res.ok) {
      // PostgREST puts a short reason in `message` and a `code`. Readers get a friendly line;
      // the raw text stays on `detail` and in a dev-only console warning. Request headers
      // (they hold the key) are never echoed.
      const { message, code } = parseErrorBody(await res.json().catch(() => null));
      const detail = `HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
      warnRaw('api error', detail);
      throw new ApiError(friendlyHttpError(res.status, message, code), res.status, detail);
    }
    return res.json();
  }

  const emptyBrief = (): Brief => ({ generated_at: new Date(0).toISOString(), window_hours: 24, headline_cards: [], sections: [], numbers: [] });
  function parseBrief(x: unknown): Brief {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return emptyBrief();
    const row = x as Record<string, unknown>;
    return {
      generated_at: typeof row.generated_at === 'string' ? row.generated_at : new Date(0).toISOString(),
      window_hours: typeof row.window_hours === 'number' ? row.window_hours : 24,
      headline_cards: Array.isArray(row.headline_cards) ? row.headline_cards.filter(isBlurbCard) : [],
      sections: Array.isArray(row.sections) ? row.sections.filter((s): s is { category: string; label: string; cards: BlurbCard[] } => !!s && typeof s === 'object' && typeof (s as any).category === 'string' && typeof (s as any).label === 'string').map((s) => ({ ...s, cards: Array.isArray(s.cards) ? s.cards.filter(isBlurbCard) : [] })) : [],
      numbers: Array.isArray(row.numbers) ? row.numbers.filter(isMacroFact) : [],
      summary: parseBriefSummary(row.summary),
      markets: parseBriefMarkets(row.markets),
    };
  }
  // Email-brief RPCs (migration 20261018040000_brief_email.sql). Sent as the anon key only,
  // never with the user's token (subscriptions are keyed by email, not by account).
  // Any failure, including a missing RPC before the migration is applied, returns null.
  async function rpcSafe(name: string, body: Record<string, unknown>): Promise<unknown> {
    const headers = { apikey: opts.key, Accept: 'application/json', 'Accept-Profile': 'api', 'Content-Type': 'application/json', 'Content-Profile': 'api' };
    try {
      return await call({ url: `${opts.url}/rest/v1/rpc/${name}`, init: { method: 'POST', headers, body: JSON.stringify(body) } });
    } catch {
      return null;
    }
  }
  const unavailable = { ok: false, status: 'unavailable' as const };
  const tokenCall = async (name: string, token: string, extra: Record<string, unknown> = {}) => {
    if (!UUID.test(String(token))) return { ok: false };
    const x = await rpcSafe(name, { p_token: token, ...extra });
    return x === null ? unavailable : parseTokenResult(x);
  };
  async function optional(op: Parameters<typeof planRequest>[2], args?: FeedRequest & { q?: string; cardId?: string; topics?: string[]; sources?: string[]; tickers?: string[] }): Promise<unknown> {
    try { return await call(planRequest(opts.url, opts.key, op, args)); } catch { return null; }
  }

  return {
    sample: false,
    async feed(req) {
      const token = opts.getToken ? await opts.getToken() : null;
      try {
        const plan = planRequest(opts.url, opts.key, 'feed', req, token);
        // First page: the inline script in index.html may already have it in flight (lib/earlyFeed.ts).
        const early = opts.fetchFn ? null : takeEarlyFeed(globalThis as { __elementEarly?: EarlyFeed }, plan.init.body, !!token);
        if (early) {
          const json = await early;
          if (json) {
            try { return parseFeedPage(json); } catch { /* fall through to a normal request */ }
          }
        }
        return parseFeedPage(await call(plan));
      } catch (e) {
        // api.feed is the same for everyone: if the user's token is rejected, read it as a guest.
        if (e instanceof ApiError && e.status === 401 && token) return parseFeedPage(await call(planRequest(opts.url, opts.key, 'feed', req, null)));
        throw e;
      }
    },
    categories: async () => parseCategories(await call(planRequest(opts.url, opts.key, 'categories'))),
    numbersToKnow: async () => parseMacroFacts(await call(planRequest(opts.url, opts.key, 'numbers'))),
    appConfig: async () => parseAppConfig(await call(planRequest(opts.url, opts.key, 'config'))),
    // The side column is optional: before the migration is applied (404) or on any error the
    // site shows nothing there instead of failing.
    async topStories() {
      try {
        const x = await call(planRequest(opts.url, opts.key, 'top_stories'));
        return Array.isArray(x) ? x.filter(isBlurbCard).slice(0, 5) : [];
      } catch {
        return [];
      }
    },
    async numberTrends() {
      try {
        return parseNumberTrends(await call(planRequest(opts.url, opts.key, 'number_trends')));
      } catch {
        return [];
      }
    },
    async search(q, cursor, limit) {
      const x = await optional('search', { mode: 'top', cursor, limit, q });
      try { return x === null ? { items: [], next_cursor: null } : parseFeedPage(x); } catch { return { items: [], next_cursor: null }; }
    },
    async relatedCards(cardId, limit = 5) {
      const x = await optional('related_cards', { mode: 'top', limit, cardId });
      return Array.isArray(x) ? x.filter(isBlurbCard).slice(0, limit) : [];
    },
    async followingFeed(f) {
      const x = await optional('following_feed', { mode: 'top', ...f });
      try { return x === null ? { items: [], next_cursor: null } : parseFeedPage(x); } catch { return { items: [], next_cursor: null }; }
    },
    async dailyBrief() {
      return parseBrief(await optional('daily_brief'));
    },
    async weeklyBrief() {
      const raw = await optional('weekly_brief');
      const brief = parseBrief(raw);
      const movers = raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).movers) ? parseNumberTrends((raw as Record<string, unknown>).movers) : [];
      return { ...brief, window_hours: 168, movers };
    },
    async subscribeBrief(i) {
      const email = normalizeBriefEmail(i?.email);
      if (!email || !isValidBriefInput(i)) return { ok: false, status: 'invalid' };
      const x = await rpcSafe('subscribe_brief', { p_email: email, p_kind: i.kind, p_hour: i.hour, p_tz: i.tz });
      return x === null ? unavailable : parseSubscribeResult(x);
    },
    confirmBrief: (token) => tokenCall('confirm_brief', token),
    updateBriefSubscription: (token, i) => (isValidBriefInput(i) ? tokenCall('update_brief_subscription', token, { p_kind: i.kind, p_hour: i.hour, p_tz: i.tz }) : Promise.resolve({ ok: false })),
    unsubscribeBrief: (token) => tokenCall('unsubscribe_brief', token),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
