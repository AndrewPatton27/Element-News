# scripts/

Build helpers that run outside the app code.

| File | What it does |
| ---- | ------------ |
| `fix-pages-assets.mjs` | Run after `expo export -p web` (see `export:web` in `package.json`). Rewrites the exported asset paths in `dist-pages/` so the static site loads from Cloudflare Pages. Takes the output folder as its only argument: `node scripts/fix-pages-assets.mjs dist-pages`. |

Tests for this script are in `lib/__tests__/fixPagesAssets.test.ts`.
