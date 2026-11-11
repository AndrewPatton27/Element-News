# Deploying the website

The web app is hosted on Cloudflare Pages at **https://element-news.pages.dev** (project `element-news`). Deploys are either a direct upload from a laptop (below) or the `deploy-pages` GitHub workflow (next section). Pushing to GitHub alone does not update the site; only the workflow, after an approval, does.

## Automatic deploy (GitHub Actions, one approval)

`.github/workflows/deploy-pages.yml` runs when code lands on `main` (and from the Actions tab, Run workflow). It checks, builds in live mode, runs the build security gate, deploys with wrangler and smoke-tests the live site. Migrations and Edge Function deploys stay manual: do those first, then approve the deploy.

One-time setup in GitHub (Settings, Environments, New environment `production`):
1. Required reviewers: add yourself. The job then waits for your approval and no secret is exposed before it.
2. Environment secrets: `CLOUDFLARE_API_TOKEN` (create at Cloudflare, My Profile, API Tokens, template Edit Cloudflare Workers is too broad: use a custom token with Account, Cloudflare Pages, Edit only) and `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard, Workers & Pages, right column).
3. Environment variables (public values only): `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the same two values as in `.env`).
Never add a service role key or an AI key to this environment.

## One-time setup (already done for this project)

1. Node.js 22.18 or newer (`node -v`).
2. `npm install` in the repo root.
3. A `.env` file in the repo root, copied from `.env.example`, with:
   - `EXPO_PUBLIC_API_MODE=supabase`
   - `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the public, publishable key only).
4. Log in to Cloudflare once: `npx wrangler@4 login` (opens the browser).
5. The Pages project was created once with `npx wrangler@4 pages project create element-news --production-branch main --force`. Don't run this again, and don't use `--force` for deploys.

## Every deploy

Run these from the repo root.

1. Run the checks:
   ```bash
   npm run test:app
   ```
   ```bash
   npx tsc --noEmit
   ```
2. Commit and push the code to GitHub (on the feature branch; the PR goes into `main`).
3. Confirm live mode (it should print `EXPO_PUBLIC_API_MODE=supabase`; mock mode shows a SAMPLE DATA banner):
   ```bash
   grep EXPO_PUBLIC_API_MODE .env
   ```
4. Build the website into `dist-pages/` (this also moves the font files out of a `node_modules` folder, which Cloudflare Pages refuses to upload; without it the fonts silently fall back to a system font):
   ```bash
   npm run export:web
   ```
5. Run the security gate on the build (read-only; prints names only, never values). It checks that no private file is tracked, that no key shape or server secret value (`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `FRED_API_KEY`, `CRON_SECRET`, ...) is in `dist-pages/`, and that `dist-pages/_headers` carries the security headers with a hash for every inline script:
   ```bash
   npm run release:check -- --prod
   ```
   After the upload, check the live headers and the database grants too: `node scripts/security-gate.mjs --url https://element-news.pages.dev --db`.
6. Upload to Cloudflare Pages:
   ```bash
   npx wrangler@4 pages deploy dist-pages --project-name element-news --branch main --commit-dirty=true
   ```
   It ends with "Deployment complete!" and a preview link; https://element-news.pages.dev updates within seconds.
7. Check the live site: open it at phone width and desktop width, swipe a few cards, open "More detail", check the Numbers and About pages, and check the browser console for errors.

## Rolling back

Cloudflare keeps every upload. In the Cloudflare dashboard go to Workers & Pages → element-news → Deployments, pick an earlier deployment, and choose "Rollback".

## Database changes are separate

The site only reads data through Supabase's public `api` schema. Database changes (files in `supabase/migrations/`) are applied separately in the Supabase SQL editor, in file-name order, before deploying an app version that needs them. See `supabase/supabase.md`.

## Notes

- Build into `dist-pages/`, not `dist/`: a local preview (`wrangler pages dev dist`) can lock `dist/` on Windows.
- After deploying, check one font URL returns `font/ttf` (not `text/html`).

- Password-reset links use the Supabase Auth URL settings: Site URL `https://element-news.pages.dev`, and redirect URLs `https://element-news.pages.dev/**` and `http://localhost:8090/**`.
- Routes such as `/about` and `/reset-password` work as deep links because the app is a single-page app (`web.output: "single"` in `app.json`).
