import { expect, test } from '@playwright/test';

// Companies on sample data: the Companies screen groups companies by sector with recent card counts,
// the filter finds a company by typo, a company page lists its cards with the disclaimer, Follow puts
// the company first on the Companies screen, and an unknown ticker shows a friendly page. No prices.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); // skip the first-run tour
  });
});

test('Companies screen: sectors, counts, typo filter, company page, follow first', async ({ page }) => {
  await page.goto('/companies');
  await expect(page.getByText(/SAMPLE DATA/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Banks, Payments & Insurance/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ cards? in 30 days/).first()).toBeVisible();

  // typo-tolerant filter
  await page.getByLabel('Filter companies by name or ticker').fill('Adatum Bnak');
  const row = page.getByRole('link', { name: /^Adatum Bank, ticker ADTB/ });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(/\/company\/ADTB$/);
  await expect(page.getByRole('heading', { name: 'Adatum Bank' })).toBeVisible();
  await expect(page.getByText(/\[SAMPLE\] Adatum Bank/).first()).toBeVisible();
  // the Companies screen stays mounted (hidden) under this one, so look at visible text only
  await expect(page.getByText(/Informational only · Not investment advice/).filter({ visible: true }).first()).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);

  // follow from the company page, then it is listed first on the Companies screen
  await page.getByRole('button', { name: 'Follow Adatum' }).filter({ visible: true }).first().click();
  await expect(page.getByRole('button', { name: /Following Adatum/ }).filter({ visible: true }).first()).toBeVisible();
  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: /Companies you follow · 1/ })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unknown company shows a friendly page with a way back', async ({ page }) => {
  await page.goto('/company/ZZZZ');
  await expect(page.getByText('We could not find that company')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Browse companies' }).click();
  await expect(page).toHaveURL(/\/companies$/);
});
