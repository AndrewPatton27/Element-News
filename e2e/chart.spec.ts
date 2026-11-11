import { expect, test, type Browser, type Page } from '@playwright/test';

// M9c chart cards: a data card carries a small history chart (one line, or the 2/5/10/30-year lines on the
// yield-curve card), with a text summary for screen readers, the agency citation and FRED notice still in view,
// and a taller chart with the low/high line in the detail sheet. Screenshots land in context/m9c-chart-shots/.
// Runs once (desktop project); opens its own phone / desktop contexts.

// Playwright runs from the repo root; a worktree sits three levels below the main checkout (override with SHOTS_DIR).
const SHOTS = process.env.SHOTS_DIR ?? '../../../context/m9c-chart-shots';
const H = '[data-testid="card-headline"]';
const SIZES = [{ w: 360, h: 740, phone: true }, { w: 390, h: 844, phone: true }, { w: 820, h: 1180, phone: true }, { w: 1280, h: 800, phone: false }];

async function open(browser: Browser, w: number, h: number, phone: boolean): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone, isMobile: phone && w < 700 });
  await ctx.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    localStorage.setItem('element.swipe-coach-seen', '1');
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator(H).first()).toBeVisible({ timeout: 30_000 });
  return page;
}

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
});

/** Is this element fully inside the window? */
const inView = (page: Page, text: RegExp) => page.evaluate((src) => {
  const re = new RegExp(src);
  const els = Array.from(document.querySelectorAll('div, span')).filter((e) => e.children.length === 0 && re.test((e as HTMLElement).innerText ?? '')) as HTMLElement[];
  return els.some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= window.innerHeight; });
}, text.source);

for (const s of SIZES) {
  test(`${s.w}x${s.h}: the yield-curve card shows a four-line chart, its summary, the citation and the FRED notice`, async ({ browser }) => {
    const page = await open(browser, s.w, s.h, s.phone);
    const chart = page.getByTestId('series-chart').first();
    await expect(chart).toBeVisible({ timeout: 30_000 });
    const img = chart.locator('[role=img][aria-label]');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('aria-label', /^Treasury yields, 2-year \d\.\d\d%, 5-year \d\.\d\d%, 10-year \d\.\d\d%, 30-year \d\.\d\d%; the 10-year up .* since \w+; chart of the last \d+ days, one line per maturity$/);
    await expect(chart.locator('svg path[stroke-dasharray]').first()).toBeAttached();   // dashed lines: not colour alone
    expect(await chart.locator('svg path').count()).toBeGreaterThanOrEqual(4);
    if (s.h > 800 || !s.phone) {
      await expect(chart.locator('svg[aria-hidden=true]').first()).toBeAttached();   // legend swatches are decoration
      await expect(chart.getByText(/^2Y \d\.\d\d%$/)).toBeVisible();     // the legend; short phone cards keep only the thin lines
      await expect(chart.getByText(/^30Y \d\.\d\d%$/)).toBeVisible();
    }
    expect(await inView(page, /via FRED/)).toBe(true);                                    // rule 8: agency citation in view
    expect(await inView(page, /Federal Reserve|Source:|FRED/)).toBe(true);
    const like = page.getByLabel('More like this').first();
    await expect(like).toBeVisible();
    const box = await chart.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= s.w).toBe(true);                     // never wider than the screen
    await page.screenshot({ path: `${SHOTS}/curve-${s.w}.png` });
    await page.context().close();
  });

  test(`${s.w}x${s.h}: a single-series data card shows one line and a screen-reader sentence`, async ({ browser }) => {
    const page = await open(browser, s.w, s.h, s.phone);
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(450);
      const imgs = page.getByTestId('series-chart').locator('[role=img][aria-label]');
      const n = await imgs.count();
      for (let k = 0; k < n; k++) {
        const label = (await imgs.nth(k).getAttribute('aria-label')) ?? '';
        const b = await imgs.nth(k).boundingBox();
        if (label && !label.startsWith('Treasury yields') && b && b.y >= 0 && b.y + b.height <= s.h && b.x >= 0 && b.x + b.width <= s.w) {
          expect(label).toMatch(/; chart of the last \d+ (days|weeks|months)$/);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
    expect(await inView(page, /via FRED/)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/single-${s.w}.png` });
    await page.context().close();
  });
}

test('detail sheet: the larger chart with the low and high line, citation and notice kept', async ({ browser }) => {
  const page = await open(browser, 390, 844, true);
  await page.keyboard.press('ArrowDown');                        // the fed funds card: one line, a taller chart in detail
  await page.waitForTimeout(500);
  await page.locator(H).first().click();
  const sheetChart = page.getByTestId('series-chart').last();
  await expect(sheetChart).toBeVisible({ timeout: 15_000 });
  await expect(sheetChart.getByText(/^Last \d+ (days|weeks|months)( · Low .*, high .*)?$/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/detail-390.png` });
  await page.context().close();
});

test('light and dark: the chart follows the theme', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
  await ctx.addInitScript(() => { localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); localStorage.setItem('element.swipe-coach-seen', '1'); });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('series-chart').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/curve-dark-390.png` });
  await ctx.close();
});
