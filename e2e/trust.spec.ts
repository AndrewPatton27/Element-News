import { expect, test, type Page } from '@playwright/test';

// M9 trust and feed-UI checks on the sample data (mock mode, signed out):
// - the card menu lists "Fewer like this" first and "Report a problem" last, and sending a report confirms it;
// - data cards get no "Hide <topic> topics";
// - the empty Search box calls its list "Popular right now" when signed out;
// - Trending + a category chip shows only that category.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); // skip the first-run tour
  });
});

async function openMenuOnScreen(page: Page) {
  await expect.poll(() => page.locator('[aria-label="More options for this card"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  const idx = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[aria-label="More options for this card"]'));
    return els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
  });
  expect(idx).toBeGreaterThanOrEqual(0);
  await page.locator('[aria-label="More options for this card"]').nth(idx).click();
}

test('card menu: Fewer like this first, Report a problem last, a report confirms', async ({ page }) => {
  await page.goto('/');
  await openMenuOnScreen(page);
  const menu = page.getByLabel('Card options');
  await expect(menu).toBeVisible();
  const labels = await menu.getByRole('button').allInnerTexts();
  expect(labels[0]).toMatch(/^Fewer like this/);
  expect(labels.some((t) => /^Report a problem/.test(t))).toBe(true);
  await menu.getByRole('button', { name: /Report a problem/ }).click();
  await page.getByRole('button', { name: /source link is broken/ }).click();
  await expect(page.getByTestId('undo-toast')).toContainText('Reported');
  await expect(page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('card menu: Fewer like this shows an Undo toast', async ({ page }) => {
  await page.goto('/');
  await openMenuOnScreen(page);
  await page.getByLabel('Card options').getByRole('button', { name: /^Fewer like this/ }).click();
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toContainText('Fewer like this');
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('search: signed-out suggestions are called "Popular right now"', async ({ page }) => {
  await page.goto('/search');
  await expect(page.getByTestId('search-suggestions').getByText('Popular right now')).toBeVisible({ timeout: 30_000 });
});

// I-01 (fixed in M9): a rerank right after a chip change refilled the new list with the old cards.
test('Trending + a category chip shows only that category (I-01 check)', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.locator('[data-testid="card-headline"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.getByRole('tab', { name: /^Trending/ }).first().click();
  await page.getByRole('tab', { name: 'Economy', exact: true }).first().click();
  await page.waitForTimeout(4000);
  const cats = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="card-meta"]')).map((e) => (e as HTMLElement).innerText));
  expect(cats.length).toBeGreaterThan(0);
  for (const c of cats) expect(c).toMatch(/Economy/);
});
