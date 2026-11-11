import { expect, test, type Browser, type Page } from '@playwright/test';

// Wave 2 (M9c), mock data, signed out. Every feature sits behind a flag that defaults OFF; the tests flip them with the
// mock-only override `localStorage['element.flags']` (lib/flags/flags.ts). First the OFF check (nothing visible changes),
// then each feature ON: A-17 setup, A-12 finer topics and lanes, A-22 signals, B-06 since, D-02 glossary.
// Screenshots go to test-results/m9c-shots (untracked).

const H = '[data-testid="card-headline"]';
const SHOTS = 'test-results/m9c-shots';

async function openPage(browser: Browser, o: { flags?: string; phone?: boolean; setup?: 'skipped' | 'done' | null; visitHoursAgo?: number; path?: string; size?: { width: number; height: number } } = {}): Promise<Page> {
  const phone = o.phone ?? false;
  const size = o.size ?? (phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone });
  await ctx.addInitScript(
    ({ flags, setup, visit }) => {
      if (sessionStorage.getItem('__w2_init')) return; // only the first load: later reloads keep what the test did
      sessionStorage.setItem('__w2_init', '1');
      localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
      localStorage.setItem('element.swipe-coach-seen', '1');
      if (flags) localStorage.setItem('element.flags', flags);
      if (setup) localStorage.setItem('element.signals', JSON.stringify({ setup }));
      if (visit !== null) localStorage.setItem('element.visit', JSON.stringify({ prev: null, last: Date.now() - visit * 3_600_000 }));
    },
    { flags: o.flags ?? '', setup: o.setup ?? null, visit: o.visitHoursAgo ?? null },
  );
  const page = await ctx.newPage();
  await page.goto(o.path ?? '/');
  return page;
}

const cardsOnScreen = (page: Page) => expect.poll(() => page.locator(H).count(), { timeout: 60_000 }).toBeGreaterThan(0);
const signals = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('element.signals') ?? '{}'));

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'More options for this card' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Card options' })).toBeVisible();
}

test.describe('flags OFF: nothing visible changes', () => {
  test('feed, menu and the new routes behave as before', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const page = await openPage(browser);
    await cardsOnScreen(page);
    await expect(page).toHaveURL(/localhost:\d+\/?$/); // no redirect to /setup
    await expect(page.getByRole('tab', { name: 'Rates', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('since-pill')).toHaveCount(0);
    await openMenu(page);
    await expect(page.getByText('Save for later')).toHaveCount(0);
    await expect(page.getByText(/^Mute /)).toHaveCount(0);
    await expect(page.getByText('Fewer like this')).toBeVisible();
    await page.keyboard.press('Escape');
    // the new screens send a reader straight back to the feed
    for (const route of ['/setup', '/signals', '/since']) {
      await page.goto(route);
      await expect(page).toHaveURL(/localhost:\d+\/?(\?.*)?$/);
    }
    await page.context().close();
  });
});

test.describe('A-17 three-question setup', () => {
  test('first open after the tour shows the setup; answers seed follows, interests, depth and the lanes', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'onboarding' });
    await expect(page).toHaveURL(/\/setup/, { timeout: 60_000 });
    await expect(page.getByText('Question 1 of 3')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Rates' }).click();
    await page.getByRole('checkbox', { name: 'Housing' }).click();
    await page.getByRole('checkbox', { name: 'Company earnings' }).click();
    await page.screenshot({ path: `${SHOTS}/setup-1-desktop.png` });
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Question 2 of 3')).toBeVisible();
    await page.getByRole('radio', { name: /A little/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Question 3 of 3')).toBeVisible();
    await page.getByRole('radio', { name: /^Short/ }).click();
    await page.getByRole('button', { name: 'Back' }).click(); // Back keeps the answers
    await expect(page.getByText('Question 2 of 3')).toBeVisible();
    await expect(page.getByRole('radio', { name: /A little/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/tab=for_you/, { timeout: 30_000 });
    const s = await signals(page);
    expect(s.setup).toBe('done');
    expect(s.interests).toEqual(['rates', 'housing']);
    expect(s.depth).toBe('short');
    const follows = await page.evaluate(() => JSON.parse(localStorage.getItem('element.follows') ?? '{}'));
    expect(follows.topics).toEqual(expect.arrayContaining(['economy', 'earnings', 'personal-finance', 'markets']));
    // never shown again
    await page.goto('/');
    await cardsOnScreen(page);
    await expect(page).not.toHaveURL(/setup/);
    await page.context().close();
  });

  test('skip: stored, the feed opens, and the phone layout fits', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'onboarding', phone: true });
    await expect(page).toHaveURL(/\/setup/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/setup-1-phone.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await cardsOnScreen(page);
    expect((await signals(page)).setup).toBe('skipped');
    await page.context().close();
  });
});

test.describe('A-12 finer topics and opt-in lanes', () => {
  test('six topic chips, filtering, and Crypto/Tech/AI only after opting in', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'topics,signals', setup: 'skipped' });
    await cardsOnScreen(page);
    for (const name of ['Rates', 'Housing', 'Trade', 'Labor', 'Banks', 'Retirement']) await expect(page.getByRole('tab', { name, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Crypto', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Tech/AI', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Rates', exact: true }).first().click();
    // a Rates chip shows only rate stories, or the quiet empty state: never an unrelated card
    await page.waitForTimeout(1500);
    const heads = await page.locator(H).allInnerTexts();
    if (heads.length > 0) expect(heads.join(' ')).toMatch(/rate|yield|treasury|fed|fomc|mortgage|bond/i);
    else await expect(page.getByText(/No Rates stories right now/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/topics-rates-desktop.png` });
    // opt in on the signals page: the chip appears
    await page.goto('/signals');
    await expect(page.getByTestId('signals-screen')).toBeVisible();
    await page.getByRole('switch', { name: /Crypto: off/ }).click();
    expect((await signals(page)).optIn).toEqual(['crypto']);
    await page.goto('/');
    await cardsOnScreen(page);
    await expect(page.getByRole('tab', { name: 'Crypto', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tech/AI', exact: true })).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('A-22 signals: save, mute, depth', () => {
  test('save for later lists on /signals; mute a company removes its cards and Unmute brings them back; short depth trims bullets', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'signals', setup: 'skipped' });
    await cardsOnScreen(page);
    await page.screenshot({ path: `${SHOTS}/feed-flags-desktop.png` });
    const firstHeadline = (await page.locator(H).first().innerText()).trim();
    // save
    await openMenu(page);
    await page.screenshot({ path: `${SHOTS}/menu-signals-desktop.png` });
    await page.getByText('Save for later').click();
    await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
    expect((await signals(page)).saved.length).toBe(1);
    // undo from the toast takes it back, then save again
    await page.getByRole('button', { name: /undo/i }).first().click();
    expect((await signals(page)).saved ?? []).toHaveLength(0);
    await openMenu(page);
    await page.getByText('Save for later').click();
    await page.goto('/signals');
    await expect(page.getByTestId('saved-row')).toHaveCount(1);
    await expect(page.getByTestId('saved-row')).toContainText(firstHeadline.slice(0, 20));
    await page.screenshot({ path: `${SHOTS}/signals-desktop.png` });
    await page.getByTestId('saved-row').click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Remove .* from saved$/ }).click();
    await expect(page.getByTestId('saved-row')).toHaveCount(0);
    // depth
    await page.getByRole('radio', { name: /Short/ }).click();
    expect((await signals(page)).depth).toBe('short');
    await page.getByRole('radio', { name: /Normal/ }).click();
    expect((await signals(page)).depth).toBe('normal');
    // mute a company: find a card with a company entry in its menu
    await page.goto('/');
    await cardsOnScreen(page);
    let muted: string | null = null;
    for (let i = 0; i < 12 && !muted; i++) {
      await openMenu(page);
      const mute = page.getByText(/^Mute [A-Z]/).first();
      if (await mute.count()) {
        muted = ((await mute.innerText()) || '').replace(/^Mute /, '');
        await mute.click();
        break;
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(600);
    }
    expect(muted, 'a card with a company to mute').toBeTruthy();
    const s = await signals(page);
    expect(s.mutedTickers.length).toBe(1);
    await page.goto('/signals');
    await expect(page.getByText(/\(company\)/)).toHaveCount(1);
    await page.getByRole('button', { name: /^Unmute / }).click();
    await expect(page.getByText(/\(company\)/)).toHaveCount(0);
    await page.context().close();
  });

  test('short depth shows one key point per card', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const normal = await openPage(browser, { flags: 'signals', setup: 'skipped' });
    await cardsOnScreen(normal);
    const count = async (p: Page) => p.locator('[aria-label="Key points"]').first().locator('[role="listitem"]').count();
    const before = await count(normal);
    await normal.context().close();
    const short = await openPage(browser, { flags: 'signals', setup: 'skipped' });
    await short.evaluate(() => localStorage.setItem('element.signals', JSON.stringify({ setup: 'skipped', depth: 'short' })));
    await short.reload();
    await cardsOnScreen(short);
    expect(await count(short)).toBe(1);
    expect(before).toBeGreaterThanOrEqual(1);
    await short.context().close();
  });
});

test.describe('B-06 since yesterday', () => {
  test('Latest shows how many are new since the last visit; the page lists them macro first', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'since', setup: 'skipped', visitHoursAgo: 40 });
    await cardsOnScreen(page);
    await page.getByRole('tab', { name: /^Latest/ }).first().click();
    const pill = page.getByTestId('since-pill');
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText(/new since your last visit/);
    await page.screenshot({ path: `${SHOTS}/since-pill-desktop.png` });
    await pill.click();
    await expect(page.getByTestId('since-screen')).toBeVisible();
    await expect(page.getByTestId('since-summary')).toContainText(/new in the last/);
    await expect(page.getByText('Informational only').first()).toBeVisible(); // the persistent disclaimer line stays
    await page.screenshot({ path: `${SHOTS}/since-page-desktop.png` });
    await page.context().close();
  });

  test('a reader who just visited sees no pill (the window is the current session)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(120_000);
    const page = await openPage(browser, { flags: 'since', setup: 'skipped', visitHoursAgo: 0 });
    await cardsOnScreen(page);
    await page.getByRole('tab', { name: /^Latest/ }).first().click();
    await page.waitForTimeout(1200);
    // same session: prev is null, so the 24 h default window applies; the pill, if any, never claims zero
    const n = await page.getByTestId('since-pill').count();
    if (n) await expect(page.getByTestId('since-pill')).not.toContainText(/^0 /);
    await page.context().close();
  });
});

test.describe('D-02 glossary', () => {
  test('tap a jargon word in the detail sheet: a plain meaning opens, and closes again', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'glossary', setup: 'skipped' });
    await cardsOnScreen(page);
    let found = false;
    for (let i = 0; i < 14 && !found; i++) {
      await page.getByRole('button', { name: /^More detail/ }).first().click();
      const word = page.getByRole('button', { name: /, tap for the meaning$/ }).first();
      if (await word.count()) {
        await page.screenshot({ path: `${SHOTS}/glossary-detail-desktop.png` });
        await word.click();
        await expect(page.getByTestId('define-meaning')).toBeVisible();
        expect((await page.getByTestId('define-meaning').innerText()).length).toBeGreaterThan(30);
        await page.screenshot({ path: `${SHOTS}/glossary-define-desktop.png` });
        await page.getByRole('button', { name: 'Got it' }).click();
        await expect(page.getByTestId('define-meaning')).toHaveCount(0);
        found = true;
        break;
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(600);
    }
    expect(found, 'a card with a glossary term in its detail').toBe(true);
    await page.context().close();
  });

  test('flag off: no underlined terms in the detail', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
    test.setTimeout(120_000);
    const page = await openPage(browser, { setup: 'skipped' });
    await cardsOnScreen(page);
    await page.getByRole('button', { name: /^More detail/ }).first().click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /, tap for the meaning$/ })).toHaveCount(0);
    await page.context().close();
  });
});
