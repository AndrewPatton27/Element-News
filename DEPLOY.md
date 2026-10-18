# Deploying the website

The web app is hosted on Cloudflare Pages at **https://element-news.pages.dev** (project `element-news`). Deploys are a direct upload from a laptop: pushing to GitHub does not update the site.

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
5. Make sure no server-side key ended up in the build. Only `EXPO_PUBLIC_*` values are bundled, but check anyway: search `dist-pages/` for the values of `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` and `FRED_API_KEY`. There must be no matches.
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
