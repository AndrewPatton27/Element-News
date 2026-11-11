import { expect, test, type Browser, type Page } from '@playwright/test';

// M9 batch 2, second half (mock data, signed out; each test runs once on the desktop project and opens its own
// phone or desktop context):
//  - I-01  Latest / Trending + a category chip shows only that category, and "All" brings the rest back
//  - G-04  "Follow story" label on wide cards; Following threads label the period of each update
//  - dimmed disliked cards in Latest, ticker details, "More detail" reachable on a card that scrolls
//  - screenshots at 360, 390, 820 and 1280 px (test-results/m9b-shots, untracked; run this file last)

const H = '[data-testid="card-headline"]';

async function openPage(browser: Browser, size: { width: number; height: number }, phone: boolean, path = '/'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone });
  await ctx.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    localStorage.setItem('element.swipe-coach-seen', '1');
  });
  const page = await ctx.newPage();
  await page.goto(path);
  return page;
}

const cardsOnScreen = (page: Page) => expect.poll(() => page.locator(H).count(), { timeout: 60_000 }).toBeGreaterThan(0);
const meta = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="card-meta"]')).map((e) => (e as HTMLElement).innerText));

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
});

test('category chips (I-01): Latest and Trending + Economy show only Economy; All brings the other topics back', async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await openPage(browser, { width: 390, height: 844 }, true);
  await cardsOnScreen(page);
  for (const tab of [/^Latest/, /^Trending/]) {
    await page.getByRole('tab', { name: tab }).first().click();
    await page.getByRole('tab', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('tab', { name: 'Economy', exact: true }).first().click();
    await expect.poll(async () => (await meta(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(3000);
    const eco = await meta(page);
    expect(eco.length).toBeGreaterThan(0);
    for (const c of eco) expect(c).toMatch(/Economy/);
    await page.getByRole('tab', { name: 'All', exact: true }).first().click();
    await expect.poll(async () => (await meta(page)).some((c) => !/Economy/.test(c)), { timeout: 30_000 }).toBe(true);
  }
  await page.context().close();
});

test('G-04: wide cards say "Follow story"; phones keep the icon with its accessible name', async ({ browser }) => {
  test.setTimeout(120_000);
  const wide = await openPage(browser, { width: 1280, height: 800 }, false);
  await cardsOnScreen(wide);
  const wideBtn = wide.locator('[aria-label="Follow this story"]').first();
  await expect(wideBtn).toContainText('Follow story');
  await wideBtn.click();
  await expect(wide.locator('[aria-label^="Following this story"]').first()).toContainText('Following');
  await wide.context().close();
  const phone = await openPage(browser, { width: 390, height: 844 }, true);
  await cardsOnScreen(phone);
  const phoneBtn = phone.locator('[aria-label="Follow this story"]').first();
  await expect(phoneBtn).toBeVisible();
  expect(((await phoneBtn.innerText()) || '').trim()).toBe('');
  await phone.context().close();
});

test('G-04 / G-02: a followed story shows the period of each update in its thread', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await openPage(browser, { width: 1280, height: 800 }, false);
  await cardsOnScreen(page);
  await page.locator('[aria-label="Follow this story"]').first().click();
  await page.getByRole('link', { name: 'Following', exact: true }).first().click();
  const updates = page.getByLabel('Updates').first();
  await expect(updates).toBeVisible({ timeout: 30_000 });
  await expect(updates).toContainText(/(Period [^·]+|As of [A-Z][a-z]{2} \d{1,2}) · /);
  await expect(page.getByRole('button', { name: 'Stop following this story' }).first()).toContainText('Following');
  await page.context().close();
});

test('Latest: a disliked card stays in time order but is dimmed; Trending is never dimmed', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await openPage(browser, { width: 1280, height: 800 }, false);
  await cardsOnScreen(page);
  await page.getByRole('tab', { name: /^Latest/ }).first().click();
  await expect.poll(() => page.locator(H).count(), { timeout: 30_000 }).toBeGreaterThan(0);
  const first = (await page.locator(H).first().innerText()).trim();
  await expect(page.getByTestId('card-dimmed')).toHaveCount(0);
  await page.getByRole('button', { name: 'Less like this' }).first().click();
  await expect(page.getByTestId('card-dimmed')).toHaveCount(1);
  expect((await page.locator(H).first().innerText()).trim()).toBe(first); // same place, not removed or moved
  await page.getByRole('tab', { name: /^Trending/ }).first().click();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('card-dimmed')).toHaveCount(0);
  await page.context().close();
});

test('ticker: loop copy hidden from screen readers, dates on values, 14 px minimum, pauses on hover', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await openPage(browser, { width: 1280, height: 800 }, false);
  await cardsOnScreen(page);
  const strip = page.getByRole('link', { name: /^Numbers to know:/ });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  const found = await strip.evaluate((el) => {
    const hidden = Array.from(el.querySelectorAll('[aria-hidden="true"]'));
    const sizes = Array.from(el.querySelectorAll('*')).filter((n) => n.children.length === 0 && (n.textContent || '').trim()).map((n) => parseFloat(getComputedStyle(n).fontSize));
    return { rows: hidden.length, minFont: Math.min(...sizes), text: (el as HTMLElement).innerText };
  });
  expect(found.rows, 'both copies of the list are aria-hidden').toBeGreaterThanOrEqual(2);
  expect(found.minFont).toBeGreaterThanOrEqual(14);
  expect(found.text).toMatch(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,4}/); // a date on the values
  // Hover holds the strip still; moving away lets it run again.
  const x = () => strip.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().left);
  await strip.hover();
  const a = await x();
  await page.waitForTimeout(700);
  expect(Math.abs((await x()) - a)).toBeLessThan(0.5);
  await page.mouse.move(640, 500);
  const b = await x();
  await page.waitForTimeout(700);
  expect(Math.abs((await x()) - b)).toBeGreaterThan(5);
  await page.context().close();
});

test('360 x 560 phone: "More detail" can be tapped on every card, also when the card scrolls', async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await openPage(browser, { width: 360, height: 560 }, true);
  await cardsOnScreen(page);
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1200); // let the card settle after the key press
    const r = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('[data-testid="card-headline"]')) as HTMLElement[];
      const cur = heads.find((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= window.innerHeight; });
      const more = Array.from(document.querySelectorAll('[aria-label^="More detail"]')).find((b) => { const q = b.getBoundingClientRect(); const c = q.top + q.height / 2; return q.width > 0 && c > 120 && c < window.innerHeight - 100; }) as HTMLElement | undefined;
      if (!cur) return { head: '', has: false, hit: false };
      if (!more) return { head: cur.innerText, has: false, hit: false };
      const q = more.getBoundingClientRect();
      const hit = document.elementFromPoint(q.left + 20, q.top + q.height / 2);
      return { head: cur.innerText, has: true, hit: !!hit && (more === hit || more.contains(hit)), why: `${q.top}-${q.bottom} vs ${hit ? (hit.getAttribute('aria-label') || hit.tagName) + ' ' + hit.getBoundingClientRect().top : 'none'}` };
    });
    if (r.has) expect(r.hit, `More detail is clipped on "${r.head}" ${(r as { why?: string }).why}`).toBe(true);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(900);
  }
  await page.context().close();
});

test('screenshots at 360, 390, 820 and 1280', async ({ browser }) => {
  test.setTimeout(300_000);
  const sizes = [{ n: 360, h: 740, phone: true }, { n: 390, h: 844, phone: true }, { n: 820, h: 1100, phone: false }, { n: 1280, h: 800, phone: false }];
  for (const z of sizes) {
    const page = await openPage(browser, { width: z.n, height: z.h }, z.phone);
    await cardsOnScreen(page);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `test-results/m9b-shots/feed-${z.n}.png` });
    await page.getByRole('tab', { name: 'Economy', exact: true }).first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `test-results/m9b-shots/economy-${z.n}.png` });
    await page.getByRole('tab', { name: /^Latest/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Less like this' }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/m9b-shots/latest-dimmed-${z.n}.png` });
    await page.getByRole('tab', { name: /^Trending/ }).first().click();
    await page.getByRole('tab', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.locator('[aria-label="Follow this story"]').first().click();
    await page.waitForTimeout(600);
    await (z.n < 1024 ? page.getByRole('tab', { name: 'Following', exact: true }) : page.getByRole('link', { name: 'Following', exact: true })).first().click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `test-results/m9b-shots/following-${z.n}.png` });
    await page.context().close();
  }
  const short = await openPage(browser, { width: 360, height: 560 }, true);
  await cardsOnScreen(short);
  await short.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) {
    await short.screenshot({ path: `test-results/m9b-shots/short-360x560-card${i + 1}.png` });
    await short.keyboard.press('ArrowDown');
    await short.waitForTimeout(1200);
  }
  await short.context().close();
});
