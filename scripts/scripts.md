# scripts/

Build helpers that run outside the app code.

| File | What it does |
| ---- | ------------ |
| `fix-pages-assets.mjs` | Run after `expo export -p web` (see `export:web` in `package.json`). Rewrites the exported asset paths in `dist-pages/` so the static site loads from Cloudflare Pages. Takes the output folder as its only argument: `node scripts/fix-pages-assets.mjs dist-pages`. |
| `secret-scan.mjs` | Looks for key shapes (JWTs, `sb_secret_`, GitHub tokens, Google and Groq keys, private keys, Healthchecks ping URLs) and for private paths that must never be tracked (`.env`, `CLAUDE.md`, `context/`, `docs/`). `node scripts/secret-scan.mjs --staged` checks the git index before a commit; without the flag it checks every tracked file (CI: `npm run scan:secrets`). Prints file and line, never the value; exit 1 on a finding. |
| `release-check.mjs` | `npm run release:check` (add `-- --e2e` for Playwright). Runs, in order: tsc for app, ingest, functions and worker; `test:app`, `test:ingest`, `test:functions`, `test:worker`, `test:scripts`; the PGlite SQL checks; `cd ml && python -m pytest tests -q`; the secret scan. Prints a PASS / FAIL / SKIP table and exits 1 on any failure. SKIP (with a warning) when Python is absent, `ml/tests` does not exist, or no PGlite runner exists: the repo does not commit one, so point `RELEASE_SQL_RUNNER` at your script (exit 0 = all `supabase/tests/*_check.sql` passed) or add `supabase/tests/run-pglite.mjs`. Never prints secret values. |
| `prod-smoke.mjs` | `npm run smoke:prod`. Needs `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the environment (public values; never written to files). `SITE_URL` defaults to `https://element-news.pages.dev`. Checks: site returns 200 with the title (`EXPECT_TITLE`, default "Element"); a JS bundle loads; `api.feed` returns cards; the newest card is at most `MAX_AGE_HOURS` old (default 6, 48 on Saturday and Sunday UTC); `api.feed_status()` is not delayed (skipped if absent); every card has an http(s) source link, `app_config.disclaimer` is set, and AI-generated cards carry the AI label. Exit 0 pass, 1 a check failed, 2 missing configuration. |

Tests: `scripts/__tests__/*.test.mjs` (`npm run test:scripts`, fake fetch and fake runner), `lib/__tests__/fixPagesAssets.test.ts`, `lib/__tests__/secretScan.test.ts`.
