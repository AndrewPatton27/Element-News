import { expect, test } from '@playwright/test';

// M9c design polish (D-210 to D-216): small layout regressions found at 360 px, sample (mock) data.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    localStorage.setItem('element.flags', 'signals,topics');
  });
});

test.use({ viewport: { width: 360, height: 780 } });

test('360 px: the feed header does not run past the screen edge', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'For you' })).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  const box = await page.getByRole('tab', { name: 'For you' }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
});

test('For you hint line: links are 44 px tall', async ({ page }) => {
  await page.goto('/?tab=for_you');
  const link = page.getByRole('link', { name: /Pick topics|Edit topics/ });
  await expect(link).toBeVisible();
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole('link', { name: /Sign in to sync/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('detail sheet: no "Source:" key point and no key point repeating the numbers panel', async ({ page }) => {
  await page.goto('/');
  await page.getByText('More detail').first().click();
  await expect(page.getByRole('heading', { name: 'Key points' })).toBeVisible();
  await expect(page.getByText(/^Source: /)).toHaveCount(0);
  await expect(page.getByText('Many mortgage and loan rates follow this rate').first()).toBeVisible();
});

test('signals: the whole opt-in row toggles the switch (56 px target)', async ({ page }) => {
  await page.goto('/signals');
  const row = page.getByRole('switch', { name: /Crypto: off/ });
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await row.click();
  await expect(page.getByRole('switch', { name: /Crypto: on/ })).toBeVisible();
});
