import { expect, test, type Page } from '@playwright/test';

// "Brief never empty" (release M9, workstream 7, D-119): the Brief always shows stories, never the
// "not ready" box. Sample (mock) data. A back end with no brief yet is simulated with the mock-only flag
// __ELEMENT_MOCK_EMPTY_BRIEF__; a saved last good brief then fills the screen with its date.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); // skip the first-run tour
  });
});

const NOT_READY = /not ready/i;

async function openBrief(page: Page) {
  await page.goto('/brief');
  await expect(page.getByTestId('brief-lead')).toBeVisible();
}

test('brief never empty: the normal brief has a 3-bullet lead and an honest span line', async ({ page }) => {
  await openBrief(page);
  await expect(page.getByText(NOT_READY)).toHaveCount(0);
  const bullets = page.getByTestId('brief-lead').getByRole('button');
  expect(await bullets.count()).toBeGreaterThan(0);
  expect(await bullets.count()).toBeLessThanOrEqual(3);
  // "Generated … · Last 24 hours" / "· Since Friday" (Monday), or "Updated <date>" when it shows the last good stories
  await expect(page.getByText(/Last 24 hours|Since Friday|Updated [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+/).first()).toBeVisible();
  await expect(page.getByText(/last 72 h/i)).toHaveCount(0);
});

test('brief never empty: when the back end has no brief, the last good brief shows with its date', async ({ page }) => {
  await openBrief(page); // saves the live brief as the last good one
  await page.addInitScript(() => {
    (globalThis as { __ELEMENT_MOCK_EMPTY_BRIEF__?: boolean }).__ELEMENT_MOCK_EMPTY_BRIEF__ = true;
  });
  await page.reload();
  await expect(page.getByTestId('brief-lead')).toBeVisible();
  await expect(page.getByText(NOT_READY)).toHaveCount(0);
  await expect(page.getByText(/^Updated [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ · saved copy/)).toBeVisible();
});

test('brief never empty: with nothing saved and nothing live the screen says so plainly, never "not ready"', async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { __ELEMENT_MOCK_EMPTY_BRIEF__?: boolean }).__ELEMENT_MOCK_EMPTY_BRIEF__ = true;
  });
  await page.goto('/brief');
  await expect(page.getByText(/No stories in your daily brief yet/)).toBeVisible();
  await expect(page.getByText(NOT_READY)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
