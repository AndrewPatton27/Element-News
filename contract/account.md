# Accounts contract

Signed-in users get saved topics and a personal **For you** feed. Guests are unchanged: they keep `api.feed` (see `README.md`). Types are in `account.ts`; the SQL is `supabase/migrations/20261017030000_accounts.sql`.

## Files

| File | What it is |
|---|---|
| `account.ts` | `UserPrefs` (incl. `hidden_sources`), `SourceOption`, `MyCategory`, `TrackKind`, `TrackAction`, `Reaction`, `ForYouCard`, `ForYouPage`, RPC bodies (`SetPrefsParams` with `p_hidden_sources`, `TrackParams`, `FeedForYouParams`, `SourcesParams`, `MyCategoriesParams`, ...) and error messages (incl. `unknown_source`). |
| `fixtures/prefs.json` | `UserPrefs`: follows energy and tech, hides insider trades, has liked a deals card and disliked a markets card. |
| `fixtures/feed_for_you.page1.json` | `ForYouPage`: 10 `[SAMPLE]` cards (copied from `feed.page1.json`) with `my_reaction`, and a `next_cursor`. |

## Sign-in

Supabase Auth, email + password. The app gets an `access_token` (a JWT, about 1 hour) and a `refresh_token`. Recommended: use `@supabase/supabase-js` for auth only (`signUp`, `signInWithPassword`, `signOut`, `onAuthStateChange`); it stores the session (localStorage on web, AsyncStorage on native) and refreshes the token before it expires. The raw REST calls, if needed:

| Action | Request (header `apikey: <publishable key>`, `Content-Type: application/json`) |
|---|---|
| Sign up | `POST /auth/v1/signup` body `{"email","password"}`. With "Confirm email" off the response holds a session (`access_token`, `refresh_token`, `expires_in`, `user`); with it on, only `user` and the user must click the email link. |
| Sign in | `POST /auth/v1/token?grant_type=password` body `{"email","password"}` |
| Refresh | `POST /auth/v1/token?grant_type=refresh_token` body `{"refresh_token"}` |
| Current user | `GET /auth/v1/user` + `Authorization: Bearer <access_token>` |
| Sign out | `POST /auth/v1/logout` + `Authorization: Bearer <access_token>` (204) |

## RPCs (signed in only)

All are `POST <SUPABASE_URL>/rest/v1/rpc/<name>` with headers:

```
apikey: <publishable key>
Authorization: Bearer <access_token>
Content-Type: application/json
Content-Profile: api
```

| RPC | Body | Returns |
|---|---|---|
| `get_prefs` | `{}` | `UserPrefs` (incl. `hidden_sources`) |
| `set_prefs` | `{"p_followed": ["tech","energy"], "p_hidden": ["insider"], "p_hidden_sources": ["cpsc"]}` (each list: null = keep, [] = clear) | `UserPrefs` (sets `onboarded: true`) |
| `my_categories` | `{}` | `MyCategory[]`: `{slug, name, sort_order, followed, hidden}`, by `sort_order`. Topics that have cards, plus any the user follows or hides. |
| `track` | `{"p_blurb": "<card id>", "p_kind": "view" \| "open_source" \| "open_detail" \| "like" \| "dislike" \| "dwell" \| "clear", "p_ms": 4200}` (`p_ms` only for `dwell`; the old 2-key body still works) | `{"status": "recorded" \| "ignored" \| "cleared"}` |
| `feed_for_you` | `{"p_cursor": null, "p_limit": 20}` | `ForYouPage` |
| `delete_my_data` | `{}` | `{"deleted_prefs": 0\|1, "deleted_events": n}` |
| `delete_account` | `{}` | `{"deleted": true}`; deletes the login and all its data. Then sign out locally (see below). |

`api.sources` is open to everyone (anon too), so the source list loads before sign-in:

| RPC (anyone) | Body | Returns |
|---|---|---|
| `sources` | `{}` | `SourceOption[]`: `{key, name}`, by display order. The toggles for "hide a source"; the `key` goes into `set_prefs`'s `p_hidden_sources`. |

With supabase-js: `supabase.schema('api').rpc('feed_for_you', { p_cursor: null, p_limit: 20 })` sends the same request with the session token.

## Behaviour

- **Onboarding:** `onboarded` is false until the first `set_prefs`. Show the topic picker then.
- **For you score** (hours added to the card's normal rank): followed category +2; learned affinity per category (see "How For you learns"), capped at +-4; cards the user already read (on screen 8 s or more, or in-depth view opened) -3, so new things come first. Hidden categories and cards the user disliked are left out. Only cards from the last 30 days.
- **Paging:** same as `api.feed`: send `next_cursor` back unchanged; `null` = end. A like, dislike or topic change made while scrolling changes the scores for the next pages, so one card may repeat or be skipped in that scroll. Drop ids you already show; after changing topics, reload from the first page.
- **Reactions:** one per card. `like` replaces a `dislike` and the other way round; a repeat returns `ignored`; `clear` removes it. A disliked card disappears from For you on the next page.
- **Views and taps:** send `view` when a card is on screen for about a second, `open_detail` when the in-depth view is opened, `open_source` when a source link is tapped. Repeats within an hour return `ignored`. `ignored` is not an error.
- **Dwell:** when a card leaves the screen (or the app goes to the background), send `dwell` with `p_ms` = how long it was visible; pause the timer while the app is in the background. Under 300 ms is ignored; over 10 minutes is stored as 10 minutes; within 30 minutes only the longest look per card is kept (a shorter one returns `ignored`).
- **Errors:** anon calls get HTTP 401 (permission denied). Messages (`AccountRpcErrorMessage`): `not_authenticated` (401), `unknown_category: <slug>`, `category_followed_and_hidden: <slug>`, `unknown_source: <key>` (a `p_hidden_sources` key not in `core.source_keys`), `invalid_kind`, `invalid_ms`, `unknown_card`, `invalid_cursor` (all 422).
- **Hidden sources:** `set_prefs`'s `p_hidden_sources` holds source keys from `api.sources()` (e.g. `cpsc`, `fred`). Cards whose primary source is hidden are left out of both `api.feed` (when signed in) and `api.feed_for_you`. Data cards (FRED numbers) all map to the `fred` key. A card whose source has no key cannot be hidden by source.
- **Delete:** `delete_my_data` removes prefs and reactions and keeps the login. `delete_account` deletes the login itself, and the prefs and reactions go with it. The current access token keeps working until it expires (up to 1 hour) but can no longer be refreshed, so the app signs out locally straight away. A second call returns `account_not_found` (404).
- **Stored data:** user id, chosen topics, and card events: which card, the kind of event, the time, and for `dwell` a duration in milliseconds. Only durations and taps, never what was read or typed. No names, IPs, location or device data.

## How For you learns

Each card you interact with nudges its topic up or down, based on what you did with it in the last 30 days:

| Signal | Event | Hours for the topic |
|---|---|---|
| Like | `like` | +1.0 |
| Dislike | `dislike` | -1.0 (and the card disappears) |
| Opened the in-depth view | `open_detail` | +0.5 |
| Tapped a source link | `open_source` | +0.5 |
| On screen 8 s or more | `dwell` | +0.25 |
| Only ever glanced at it (1.5 s or less) and did nothing else | `dwell` | -0.15 |
| Scrolled past (view) | `view` | 0 |

One card counts for at most +1.5 or -1.0, so a single story can't take over, and one topic for at most +-4 hours. In plain English: the more you like, open and read stories about a topic, the higher its new stories show up; topics you keep skipping sink a little; anything you have already read moves down so you see something new. An hour of boost ranks a story as if it were an hour newer (8 hours = twice as important). The weights are database settings (`core.rank_params`), so they can be tuned without an app update.

## Account security

Supabase Auth (GoTrue) handles everything below. Element's own tables never hold a password, email or token. Items marked UNVERIFIED come from Supabase docs as remembered and have not been checked on the live project.

- **Passwords** are hashed with bcrypt by Supabase Auth (`auth.users.encrypted_password`). Element never stores, logs or sees a hash; the app sends the password only to `/auth/v1/*` over HTTPS and does not keep it.
- **Minimum length:** 8 characters, set in the dashboard to match the app's check. The server's setting is the one that counts.
- **Leaked-password protection** (rejecting passwords found in known breaches) is a paid-plan feature on Supabase, so it is off on the free tier. UNVERIFIED.
- **Rate limits:** Supabase Auth limits sign-ups, sign-ins, token refreshes and emails per IP / per hour (Authentication → Rate Limits; the defaults are kept). The built-in email sender allows only a few emails per hour and, without custom SMTP, only sends to the project team's addresses. UNVERIFIED. So password-reset emails only work reliably once custom SMTP is set up.
- **Sessions:** the access token is a JWT that lasts 1 hour (default). The refresh token is used once and swapped for a new one on every refresh. supabase-js refreshes automatically; with raw REST, refresh shortly before `expires_in` runs out. Sign out (`POST /auth/v1/logout`) ends the session on the server.
- **Password reset:**
  1. `POST /auth/v1/recover?redirect_to=<app URL>/reset-password` with body `{"email"}`. The response is the same whether or not the address exists.
  2. The user opens the emailed link. Supabase checks it and redirects to `/reset-password#access_token=...&refresh_token=...&type=recovery`; the tokens are in the URL fragment, which never reaches a server.
  3. The app reads the fragment, asks for a new password and sends `PUT /auth/v1/user` with `Authorization: Bearer <that access_token>` and body `{"password":"<new>"}`.

  With supabase-js: `resetPasswordForEmail(email, { redirectTo })`, wait for the `PASSWORD_RECOVERY` event, then `updateUser({ password })`. The `redirect_to` URL must be in the Redirect URLs list, or Supabase falls back to the Site URL.
- **Change password while signed in:** `PUT /auth/v1/user` with body `{"password"}`.
- **Change email:** `PUT /auth/v1/user` with body `{"email"}`. With "Confirm email" off (the demo setting), the change takes effect immediately with no confirmation email. That is convenient but lets anyone holding a session take over the address. Turn confirmation back on (with custom SMTP) after the demo. UNVERIFIED on the live project.
- **Delete account:** `rpc/delete_account` (above).

### Dashboard settings (Authentication)

| Where | Value |
|---|---|
| Sign In / Providers → Email | Enabled; Confirm email OFF for the demo (back ON with custom SMTP later); minimum password length 8 |
| URL Configuration → Site URL | The deployed web URL once it exists (the Cloudflare Pages URL); `http://localhost:8090` until then |
| URL Configuration → Redirect URLs | `http://localhost:8090/**` and, after deploy, `https://<project>.pages.dev/**` |
| Attack Protection → leaked-password protection | Not available on the free plan (UNVERIFIED) |
| Rate Limits | Defaults |
