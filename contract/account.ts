// Account contract: signed-in users (Supabase Auth, email + password).
//
// Same rules as types.ts: erasable TypeScript only, snake_case keys exactly as the
// `api` RPCs return them, import with `import type`.
// Every RPC here needs a signed-in user (Authorization: Bearer <access_token>).
// Guests keep using api.feed from types.ts.

import type { BlurbCard, CategorySlug, FeedPage } from './types.ts';

/** What a user can record about a card (stored in core.user_events). */
export type TrackKind = 'view' | 'open_source' | 'open_detail' | 'like' | 'dislike' | 'dwell';

/** `p_kind` of api.track: a TrackKind, or 'clear' to remove the user's like/dislike. */
export type TrackAction = TrackKind | 'clear';

/** The user's reaction to a card, as shown on the like/dislike buttons. */
export type Reaction = 'like' | 'dislike';

/** Response of api.get_prefs and api.set_prefs. */
export interface UserPrefs {
  followed_categories: CategorySlug[];  // sorted, distinct
  hidden_categories: CategorySlug[];    // sorted, distinct; never overlaps followed
  hidden_sources: string[];             // sorted, distinct; source keys from api.sources() (SourceKey)
  onboarded: boolean;                   // false until the first api.set_prefs -> show the topic picker
  updated_at: string | null;            // ISO; null if prefs were never saved
  /** Learned from likes/dislikes in the last 30 days: hours of boost per category,
   *  -4..+4, only non-zero categories. For an "Your feed likes Tech" line; optional to show. */
  affinity: Partial<Record<CategorySlug, number>>;
}

/** Body of POST /rest/v1/rpc/get_prefs. */
export type GetPrefsParams = Record<string, never>;

/** Body of POST /rest/v1/rpc/set_prefs. null = keep the saved list, [] = clear it. */
export interface SetPrefsParams {
  p_followed: CategorySlug[] | null;
  p_hidden: CategorySlug[] | null;
  /** Source keys (from api.sources()) to hide; null = keep the saved list, [] = clear it.
   *  Each key must exist in core.source_keys or set_prefs returns `unknown_source: <key>`. */
  p_hidden_sources?: string[] | null;
}

/** A source the user can hide, from api.sources(). `key` is stored in UserPrefs.hidden_sources. */
export interface SourceOption {
  key: string;                          // e.g. 'sec', 'fred', 'cpsc'
  name: string;                         // display name, e.g. 'SEC filings'
}

/** Body of POST /rest/v1/rpc/sources (no arguments). */
export type SourcesParams = Record<string, never>;

/** One topic for the signed-in user, from api.my_categories(). */
export interface MyCategory {
  slug: CategorySlug;
  name: string;
  sort_order: number;
  followed: boolean;
  hidden: boolean;
}

/** Body of POST /rest/v1/rpc/my_categories (no arguments). */
export type MyCategoriesParams = Record<string, never>;

/** Body of POST /rest/v1/rpc/track. */
export interface TrackParams {
  p_blurb: string;                      // card id (uuid)
  p_kind: TrackAction;
  /** Only for 'dwell': milliseconds the card was on screen (required there; ignored otherwise).
   *  Under 300 is ignored; over 600000 is stored as 600000. Omit it for every other kind. */
  p_ms?: number | null;
}

/** Response of api.track. 'ignored' = deduped or rate-limited; not an error. */
export interface TrackResult {
  status: 'recorded' | 'ignored' | 'cleared';
}

/** Body of POST /rest/v1/rpc/feed_for_you. */
export interface FeedForYouParams {
  p_cursor?: string | null;             // next_cursor from the previous page
  p_limit?: number;                     // default 20, clamped to 10..30
}

/** A card in the For you feed: a normal BlurbCard plus the user's reaction. */
export interface ForYouCard extends BlurbCard {
  my_reaction: Reaction | null;
}

/** Response of api.feed_for_you. Same paging rules as FeedPage. */
export interface ForYouPage extends Omit<FeedPage, 'items'> {
  items: ForYouCard[];
}

/** Body of POST /rest/v1/rpc/delete_my_data. */
export type DeleteMyDataParams = Record<string, never>;

/** Response of api.delete_my_data. The login itself is deleted from the Supabase dashboard. */
export interface DeleteMyDataResult {
  deleted_prefs: number;                // 0 or 1
  deleted_events: number;
}

/** Response of api.delete_account (body `{}`): the login and all its data are gone.
 *  The app signs out locally right after; the old access token cannot be refreshed. */
export interface DeleteAccountResult {
  deleted: true;
}

/** `message` of a PostgREST error from these RPCs (HTTP status in brackets). */
export type AccountRpcErrorMessage =
  | 'not_authenticated'                 // [401] no user in the token
  | `unknown_category: ${string}`       // [422] set_prefs
  | `category_followed_and_hidden: ${string}` // [422] set_prefs
  | `unknown_source: ${string}`         // [422] set_prefs: a hidden source key not in core.source_keys
  | 'invalid_kind'                      // [422] track
  | 'invalid_ms'                        // [422] track: dwell without p_ms, or negative
  | 'unknown_card'                      // [422] track
  | 'invalid_cursor'                    // [422] feed_for_you
  | 'account_not_found';                // [404] delete_account called twice
