# scripts/

Build helpers that run outside the app code.

| File | What it does |
| ---- | ------------ |
| `fix-pages-assets.mjs` | Run after `expo export -p web` (see `export:web` in `package.json`). Rewrites the exported asset paths in `dist-pages/` so the static site loads from Cloudflare Pages. Takes the output folder as its only argument: `node scripts/fix-pages-assets.mjs dist-pages`. |
| `secret-scan.mjs` | Looks for key shapes (JWTs, `sb_secret_`, GitHub tokens, Google and Groq keys, private keys, Healthchecks ping URLs) and for private paths that must never be tracked (`.env`, `CLAUDE.md`, `context/`, `docs/`). `node scripts/secret-scan.mjs --staged` checks the git index before a commit; without the flag it checks every tracked file (CI: `npm run scan:secrets`). Prints file and line, never the value; exit 1 on a finding. |

Tests: `lib/__tests__/fixPagesAssets.test.ts`, `lib/__tests__/secretScan.test.ts`.
