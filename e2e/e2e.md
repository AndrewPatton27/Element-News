# e2e/

Playwright smoke test of the web app on sample (mock) data.

```bash
npm run test:e2e
```

- Runs every test on two viewports: `mobile` (390x844, touch) and `desktop` (1280x800).
- Starts `npx expo start --web --port 8099` itself (or reuses a server already on `E2E_PORT`). The first request compiles the bundle, so the first test is slow; the whole run takes a few minutes.
- Browser: run `npx playwright install chromium` once, or set `PW_CHANNEL=chrome` (or `msedge`) to use an installed browser.
- No network is needed: outbound links are recorded by a stubbed `window.open`, and the OS share sheet is disabled so Share copies the link.

`smoke.spec.ts` checks: the feed loads with the SAMPLE banner and the disclaimer, no images and no sideways overflow; ArrowDown / ArrowUp change the card; like and dislike on each card are at least 44 px, toggle with `aria-pressed` and undo; the Sources sheet opens and a source link goes to an `https` page; Share copies a `/b/<id>` link and that path opens in the app; the "Updates delayed" banner shows only with `/?mock_delayed=1`; on `/search` the empty box shows "Suggested for you" (1 to 5 stories) above "Try a company", a suggestion opens its More detail sheet, and typing a query replaces the suggestions without the error screen.

`feedNav.spec.ts` checks feed navigation with a sampler in the page that records, every frame, which card headline is on screen and the order of the rendered cards. It covers fast ArrowRight presses (strictly forward, one card per move, no card shown twice), a steady pace (each press moves exactly one card), a held key with auto-repeat (one move), down / like / dislike / up (+1 +1 +1 -1), and Undo after a like (back exactly one). It also checks that the like toast is small, bottom-left, `aria-live`, covers no headline or button and keeps Undo reachable (a screenshot is saved per viewport), and that a touch swipe right on the phone moves exactly one card. In every test the cards already rendered must keep their order and no card may appear between them. Run one file with `npx playwright test e2e/feedNav.spec.ts`; use `E2E_PORT` for a port of your own if another dev server is running.

The real `/b/<id>` share page is served by the host in production, not by Expo's dev server, so the test only checks that the path loads without an error.
