import { expect, test, type Page } from '@playwright/test';

// M9c fix3 (persona run 3b): keyboard skip link and focus stops, For you "Pick topics", For you reason line for a followed
// company, the "Reported" toast clear of the card footer, and the bottom Feed tab returning to the last feed tab.
// Sample (mock) data, signed out. Run with --workers=1.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    localStorage.setItem('element.swipe-coach-seen', '1');
  });
});

const activeInfo = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { label: a?.getAttribute('aria-label') ?? '', inTarget: !!a?.closest('#skip-target') || a?.id === 'skip-target', isTarget: a?.id === 'skip-target' };
  });

test('keyboard: a skip link is the first Tab stop and lands on the cards (one more Tab is inside the card area)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="card-headline"]').first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Tab');
  expect((await activeInfo(page)).label).toBe('Skip to content');
  await page.keyboard.press('Enter');
  expect((await activeInfo(page)).isTarget).toBe(true);
  await page.keyboard.press('Tab');
  expect((await activeInfo(page)).inTarget).toBe(true);
});

test('keyboard: the FRED notice on a data card is not a Tab stop', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="card-headline"]').first()).toBeVisible({ timeout: 30_000 });
  const stops = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, [role="link"]'))
      .filter((e) => /FRED/.test((e as HTMLElement).innerText ?? '') && e.children.length === 0)
      .map((e) => (e as HTMLElement).tabIndex),
  );
  expect(stops.length).toBeGreaterThan(0);
  for (const t of stops) expect(t).toBeLessThan(0);
});

test('For you "Pick topics" opens the topic setup, not the account page', async ({ page }) => {
  await page.goto('/?tab=for_you');
  await page.getByRole('link', { name: 'Pick topics' }).click();
  await expect(page).toHaveURL(/\/following/);
  await page.goto('/?tab=for_you');
  await page.evaluate(() => localStorage.setItem('element.flags', 'all'));
  await page.reload();
  await page.getByRole('link', { name: 'Pick topics' }).click();
  await expect(page).toHaveURL(/\/setup/);
});

test('For you shows "Because you follow ..." for a followed company, same session', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('element.follows', JSON.stringify({ topics: [], sources: [], tickers: ['NWND'] })));
  await page.goto('/?tab=for_you');
  const reason = page.getByTestId('card-reason').first();
  await expect(reason).toBeVisible({ timeout: 30_000 });
  await expect(reason).toHaveText('Because you follow NWND');
  await expect(page.locator('[data-testid="card-headline"]').first()).toContainText('Northwind');
});

test('the Reported toast covers neither the source name nor the card actions', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.locator('[aria-label="More options for this card"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(900);
  const idx = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label="More options for this card"]')).findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    }),
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  await page.locator('[aria-label="More options for this card"]').nth(idx).click();
  await page.getByRole('button', { name: /Report a problem/ }).click();
  await page.getByRole('button', { name: /source link is broken/ }).click();
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toContainText('Reported');
  await page.waitForTimeout(900);
  const pill = (await toast.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(pill.y + pill.height).toBeLessThan(vp.height * 0.5); // a top bar, clear of the card footer
  // Every on-screen source name (the footer's left end) lies below the toast, and so do the footer buttons.
  const footerTop = await page.evaluate(() => {
    const tops = Array.from(document.querySelectorAll('[aria-label="More like this"]'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight)
      .map((r) => r.top);
    return tops.length ? Math.max(...tops) : null; // the lowest one is the current card's footer
  });
  expect(footerTop).not.toBeNull();
  expect(pill.y + pill.height).toBeLessThanOrEqual(footerTop!);
});

test('the bottom Feed tab returns to the last-used feed tab', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'the bottom tab bar is the phone layout');
  await page.goto('/?tab=latest');
  await expect(page.getByRole('tab', { name: 'Latest' }).first()).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  await page.getByRole('tab', { name: 'Brief' }).click();
  await expect(page).toHaveURL(/\/brief/);
  await page.getByRole('tab', { name: 'Feed' }).click();
  await expect(page.getByRole('tab', { name: 'Latest' }).first()).toHaveAttribute('aria-selected', 'true');
});

test('a fresh launch still opens Trending', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Trending' }).first()).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
});
