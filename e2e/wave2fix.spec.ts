import { expect, test, type Browser, type Page } from '@playwright/test';

// Wave 2 fixes from persona run 3 (M9c, D-230 to D-233), mock data, signed out. Flags default OFF; the tests flip them
// with the mock-only override `localStorage['element.flags']`. Covers: setup picks stay visible (#5), the since pill
// matches the page and sits above the fold (#7, #8), the tour skip and deep links (#9), Tech vs Tech/AI (#10),
// glossary tap targets (#11), accessible names and landmarks (#13).

const H = '[data-testid="card-headline"]';

async function openPage(browser: Browser, o: { flags?: string; phone?: boolean; setup?: 'skipped' | 'done' | null; tour?: boolean; signals?: object; visitHoursAgo?: number; path?: string; size?: { width: number; height: number } } = {}): Promise<Page> {
  const phone = o.phone ?? false;
  const size = o.size ?? (phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone });
  await ctx.addInitScript(
    ({ flags, setup, sig, tour, visit }) => {
      if (sessionStorage.getItem('__w2_init')) return;
      sessionStorage.setItem('__w2_init', '1');
      if (!tour) localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
      localStorage.setItem('element.swipe-coach-seen', '1');
      if (flags) localStorage.setItem('element.flags', flags);
      if (setup || sig) localStorage.setItem('element.signals', JSON.stringify({ ...(sig ?? {}), ...(setup ? { setup } : {}) }));
      if (visit !== null) localStorage.setItem('element.visit', JSON.stringify({ prev: null, last: Date.now() - visit * 3_600_000 }));
    },
    { flags: o.flags ?? '', setup: o.setup ?? null, sig: o.signals ?? null, tour: o.tour ?? false, visit: o.visitHoursAgo ?? null },
  );
  const page = await ctx.newPage();
  await page.goto(o.path ?? '/');
  return page;
}

const cardsOnScreen = (page: Page) => expect.poll(() => page.locator(H).count(), { timeout: 60_000 }).toBeGreaterThan(0);
const signals = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('element.signals') ?? '{}'));
const desktopOnly = (info: { project: { name: string } }) => test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');

test.describe('#5 setup picks stay visible', () => {
  test('Rates, Labor and Trade show on Following and For you with "because you picked"', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'onboarding', path: '/setup' });
    await expect(page.getByText('Question 1 of 3')).toBeVisible({ timeout: 60_000 });
    for (const n of ['Rates', 'Labor', 'Trade']) await page.getByRole('checkbox', { name: n }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('radio', { name: /I am learning/ })).toBeVisible();
    await page.getByRole('radio', { name: /I am learning/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/tab=for_you/, { timeout: 30_000 });
    await expect(page.getByTestId('picked-reason')).toHaveText('Because you picked Rates, Labor and Trade in setup.', { timeout: 30_000 });
    await page.goto('/following');
    await expect(page.getByRole('button', { name: 'Stop following Rates' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop following Labor' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop following Trade' })).toBeVisible();
    await expect(page.getByTestId('following-picked-reason')).toContainText('Because you picked Rates, Labor and Trade');
    await page.getByRole('button', { name: 'Stop following Labor' }).click();
    expect((await signals(page)).interests).toEqual(['rates', 'trade']);
    await page.context().close();
  });
});

test.describe('#7 #8 since pill', () => {
  test('first visit says the window, equals the page count, and is above the fold at 1024x768', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'since', setup: 'skipped', size: { width: 1024, height: 768 } });
    await cardsOnScreen(page);
    await page.getByRole('tab', { name: /^Latest/ }).first().click();
    const pill = page.getByTestId('since-pill');
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText(/new in the last 24 hours/);
    const box = await pill.boundingBox();
    expect(box && box.y + box.height).toBeLessThan(768);
    const n = Number(((await pill.innerText()).match(/^(\d+) new/) ?? [])[1]);
    await pill.click();
    await expect(page.getByTestId('since-summary')).toContainText(`${n} new in the last 24 hours`, { timeout: 30_000 });
    await page.context().close();
  });
});

test.describe('#9 tour skip and deep links', () => {
  test('Skip tutorial does not open the setup and a feed URL keeps its tab', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'onboarding', tour: true, path: '/?tab=latest' });
    const skip = page.getByRole('button', { name: 'Skip tutorial' });
    await expect(skip).toBeVisible({ timeout: 60_000 });
    await skip.click();
    await cardsOnScreen(page);
    await expect(page).not.toHaveURL(/setup/);
    await expect(page).toHaveURL(/tab=latest/);
    await expect(page.getByRole('tab', { name: /^Latest/ }).first()).toHaveAttribute('aria-selected', 'true');
    expect((await signals(page)).setup).toBe('skipped');
    await page.context().close();
  });

  test('a bare feed URL is never sent to the setup', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'onboarding', path: '/?tab=latest' });
    await cardsOnScreen(page);
    await expect(page).not.toHaveURL(/setup/);
    await expect(page.getByRole('tab', { name: /^Latest/ }).first()).toHaveAttribute('aria-selected', 'true');
    await page.context().close();
  });

  test('flags off: skipping the tour still lands on Trending', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(180_000);
    const page = await openPage(browser, { tour: true, path: '/?tab=latest' });
    await page.getByRole('button', { name: 'Skip tutorial' }).click({ timeout: 60_000 });
    await cardsOnScreen(page);
    await expect(page).toHaveURL(/tab=top/);
    await page.context().close();
  });
});

test.describe('#10 Tech vs Tech/AI', () => {
  test('opted in: one Tech/AI chip, no separate Tech chip', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'topics', setup: 'skipped', signals: { optIn: ['tech-ai'] } });
    await cardsOnScreen(page);
    await expect(page.getByRole('tab', { name: 'Tech/AI', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tech', exact: true })).toHaveCount(0);
    await page.context().close();
  });
  test('not opted in: the Tech chip stays and Tech/AI is absent', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(180_000);
    const page = await openPage(browser, { flags: 'topics', setup: 'skipped' });
    await cardsOnScreen(page);
    await expect(page.getByRole('tab', { name: 'Tech', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tech/AI', exact: true })).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('#11 glossary', () => {
  test('the words row has 44 px buttons and one tap opens the meaning', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'glossary', setup: 'skipped' });
    await cardsOnScreen(page);
    let found = false;
    for (let i = 0; i < 14 && !found; i++) {
      await page.getByRole('button', { name: /^More detail/ }).first().click();
      const chip = page.getByTestId('glossary-words').getByRole('button').first();
      if (await chip.count()) {
        const box = await chip.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThan(43.5); // the sheet is still scaling in: 43.96 is 44
        await chip.click(); // first tap
        await expect(page.getByTestId('define-meaning')).toBeVisible();
        found = true;
        break;
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(600);
    }
    expect(found, 'a card with a glossary word in its detail').toBe(true);
    await page.context().close();
  });
});

test.describe('#13 names and landmarks', () => {
  test('/brief and /following have a main landmark; tour and setup buttons have names', async ({ browser }, info) => {
    desktopOnly(info);
    test.setTimeout(240_000);
    const page = await openPage(browser, { flags: 'onboarding', tour: true });
    await expect(page.getByRole('button', { name: 'Skip tutorial' })).toBeVisible({ timeout: 60_000 });
    const unnamed = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button,[role="button"],[role="radio"],[role="checkbox"]'))
          .filter((el) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el).position === 'fixed')
          .filter((el) => !(el.getAttribute('aria-label') || (el as HTMLElement).innerText?.trim() || el.getAttribute('aria-labelledby')))
          .map((el) => el.outerHTML.slice(0, 120)),
      );
    expect(await unnamed()).toEqual([]);
    await page.getByRole('button', { name: 'Skip tutorial' }).click();
    await page.goto('/setup');
    await expect(page.getByText('Question 1 of 3')).toBeVisible({ timeout: 60_000 });
    expect(await unnamed()).toEqual([]);
    for (const route of ['/brief', '/following']) {
      await page.goto(route);
      await expect(page.getByRole('main')).toHaveCount(1, { timeout: 30_000 });
    }
    await page.context().close();
  });
});
