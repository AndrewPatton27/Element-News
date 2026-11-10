# functions/

Cloudflare Pages Functions. `wrangler pages deploy dist-pages` (see `DEPLOY.md`) picks up this folder from the
project root and builds it with the static site; only the routes below run code, every other path is a static file.

| Route    | File        | What it does |
| -------- | ----------- | ------------ |
| `/b/:id` | `b/[id].ts` | Shared-card page. Answers the app's `index.html` with the card's link-preview tags so a pasted Share link shows the headline and first sentence. The app's own route `app/b/[id].tsx` then renders the card. |

## `/b/:id` step by step

All logic is in `lib/share/shareFunction.ts` (the file here only wires the Pages context in).

1. GET or HEAD only, and the id must be a UUID; otherwise the normal static answer (`context.next()`).
2. Loads `index.html` through `env.ASSETS`.
3. Asks Supabase for the card: `POST <SUPABASE_URL>/rest/v1/rpc/card_by_id` with `{ p_id }`, the publishable key
   only (never a secret or service-role key, rule 10), 1.5 s timeout. Migration `supabase/migrations/20261120000500_card_by_id.sql`
   must be applied first; until then every request falls back.
4. Puts the tags into `<head>`: `<title>`, `og:title` / `twitter:title` = the card headline as written (capped at
   200 characters), `og:description` / `twitter:description` / `description` = first sentence of the blurb,
   `og:url` + canonical, `twitter:card=summary`. Never an image tag (rule 9). Every value is HTML-escaped. Inline
   scripts are left byte for byte, so the CSP script hashes computed at build time still match.
5. Response headers: the same security headers as `dist-pages/_headers` (Cloudflare does not apply `_headers` to
   Function responses, so they are set here: `lib/share/shareHeaders.ts`, checked against `scripts/security-headers.mjs`),
   plus `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate`.
6. Any error (bad id, unknown or unpublished card, timeout, missing config) falls back to the static page; the app
   then shows the card or "This story is not available".

## Configuration

Pages environment variables (both are public values, no secret):

- `SUPABASE_URL`: `https://<project>.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY`: the publishable (or legacy anon) key

If they are not set, the Function reads the same two values from the early-load script that the build puts into
`index.html` (`scripts/fix-pages-assets.mjs`). A key that looks secret is ignored.

## Tests

`npm run test:app` runs `lib/__tests__/sharePage.test.ts`: hostile headlines (`"><script>`, quotes, backticks,
unicode, emoji), unchanged inline scripts, identical security headers, every fallback, the timeout, key checks.
The Function itself does not run under `expo start`; to try it locally: `npm run export:web` then
`npx wrangler pages dev dist-pages` and open `/b/<card id>`.
