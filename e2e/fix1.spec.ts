import { expect, test, type Browser, type Page } from '@playwright/test';

// M9c fix1 (persona run 3, defects 2 and 6), sample (mock) data. Opens its own contexts; runs once.

async function open(browser: Browser, size: { width: number; height: number }, path = '/'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: size, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    localStorage.setItem('element.swipe-coach-seen', '1');
  });
  const page = await ctx.newPage();
  await page.goto(path);
  return page;
}

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
});

// The FRED notice (rule 8) must be fully on screen, not clipped by the card or the scrolling middle, on every data card.
for (const size of [{ width: 375, height: 812 }, { width: 360, height: 640 }]) {
  test(`${size.width}x${size.height}: the FRED notice is fully visible on every data card`, async ({ browser }) => {
    const page = await open(browser, size);
    await expect(page.locator('[data-testid="card-headline"]').first()).toBeVisible({ timeout: 30_000 });
    let seen = 0;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('div, span, a')).find((e) => e.children.length === 0 && /uses the FRED/.test((e as HTMLElement).innerText ?? '') && e.getBoundingClientRect().top > 0 && e.getBoundingClientRect().top < window.innerHeight) as HTMLElement | undefined;
        if (!el) return null;
        const b = el.getBoundingClientRect();
        let clip = 0;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const o = getComputedStyle(a).overflowY;
          if (o !== 'visible' && a.scrollHeight < a.clientHeight * 1.8 && a !== document.body && a !== document.documentElement) { const ab = a.getBoundingClientRect(); clip = Math.max(clip, b.bottom - ab.bottom, ab.top - b.top); }
        }
        return { bottom: b.bottom, height: b.height, clip, vh: window.innerHeight };
      });
      if (r) { seen++; expect(r.clip, `clipped by ${r.clip}px at card ${i + 1}`).toBeLessThanOrEqual(0.5); expect(r.bottom).toBeLessThanOrEqual(r.vh); }
      await page.keyboard.press('ArrowDown');
    }
    expect(seen).toBeGreaterThan(0);
    await page.context().close();
  });
}

test('data card "More detail" is never empty: numbers panel, what the number measures, source', async ({ browser }) => {
  const page = await open(browser, { width: 390, height: 844 });
  await expect(page.locator('[data-testid="card-headline"]').first()).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    const data = await page.getByText('New data', { exact: true }).first().isVisible().catch(() => false);
    if (data) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.getByRole('button', { name: /^More detail\./ }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('What this number measures')).toBeVisible();
  await expect(sheet.getByText('Sources', { exact: true })).toBeVisible();
  await expect(sheet.getByText(/isn.t available/)).toHaveCount(0);
  await page.context().close();
});
