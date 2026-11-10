# e2e/

Playwright smoke test of the web app on sample (mock) data.

```bash
npm run test:e2e
```

- Runs every test on two viewports: `mobile` (390x844, touch) and `desktop` (1280x800).
- Starts `npx expo start --web --port 8099` itself (or reuses a server already on `E2E_PORT`). The first request compiles the bundle, so the first test is slow; the whole run takes a few minutes.
- Browser: run `npx playwright install chromium` once, or set `PW_CHANNEL=chrome` (or `msedge`) to use an installed browser.
- No network is needed: outbound links are recorded by a stubbed `window.open`, and the OS share sheet is disabled so Share copies the link.

`cards.spec.ts` (runs once, in the `desktop` project, opening its own contexts) walks the first cards at phone 390x844, small phone 360x640, tablet 820x1180, desktop 1440x900 and short desktop 1280x640, and checks the card layout: the bottom bar (source, like, dislike, follow, share) is one line, every button is a 44 px target, no sideways overflow, no image, no AI notice or disclaimer inside the card, and the persistent notice strip (D-80) sits under the card, on screen, one line on wide and at most two on phones. It also opens Search results, Following and Brief at phone and desktop size and checks the strip there. Screenshots go to `test-results/cards/` (git-ignored; set `CARD_SHOTS_DIR` to change it).

`smoke.spec.ts` checks: the feed loads with the SAMPLE banner and the disclaimer (in the notice strip), no images and no sideways overflow; ArrowDown / ArrowUp change the card; like and dislike on each card are at least 44 px, toggle with `aria-pressed` and undo; the Sources sheet opens and a source link goes to an `https` page; Share copies a `/b/<id>` link and that path opens the shared-card page (headline, both notices, Sources, like and dislike, no image, "Open Element" back to the feed); an unknown or malformed `/b/` id shows "This story is not available"; the "Updates delayed" banner shows only with `/?mock_delayed=1`; on `/search` the empty box shows "Suggested for you" (1 to 5 stories) above "Try a company", a suggestion opens its More detail sheet, and typing a query replaces the suggestions without the error screen.

`feedNav.spec.ts` checks feed navigation with a sampler in the page that records, every frame, which card headline is on screen and the order of the rendered cards. It covers fast ArrowRight presses (strictly forward, one card per move, no card shown twice), a steady pace (each press moves exactly one card), a held key with auto-repeat (one move), down / like / dislike / up (+1 +1 +1 -1), and Undo after a like (back exactly one). It also checks the like toast and the hide-topic toast. Each must be small (at most 40 px tall), sit bottom-left and be `aria-live`. Its Undo target must be at least 44 x 44 px, and neither the pill nor the target may cover the headline, More detail or the like / dislike / follow / share buttons. A screenshot of each is saved per viewport, and that a touch swipe right on the phone moves exactly one card. In every test the cards already rendered must keep their order and no card may appear between them. Run one file with `npx playwright test e2e/feedNav.spec.ts`; use `E2E_PORT` for a port of your own if another dev server is running.

The `/b/<id>` route is the app's own page (`app/b/[id].tsx`). The production Pages Function (`functions/b/[id].ts`, link-preview tags) does not run under Expo's dev server; it is unit-tested in `lib/__tests__/sharePage.test.ts`. `companies.spec.ts` also checks that the company page shows the AI notice + disclaimer strip on screen without scrolling (P1-2).

ui-polish-m8: the specs find the card headline on screen with `[data-testid="card-headline"]` (card headlines became level-2 headings under one page-level heading). `uiPolish.spec.ts` checks the pass: on wide web About is a top-bar link and no floating About button covers content; on a 360 x 640 phone the first data card shows its change and agency citation inside the card without scrolling and the bar stays one line; the ticker is a single keyboard stop; arrow-key moves glide (scroll animation restored in M9); a dragged More detail sheet springs back on a short pull and closes on a long one.
