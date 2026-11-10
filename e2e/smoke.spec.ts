import { expect, test, type Page } from '@playwright/test';

// Smoke test of the feed on sample data: the feed loads, the next card shows, like and
// dislike work, the sources sheet opens, share gives a /b/<id> link, and the delayed
// banner appears when the mock status says so.

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); // skip the first-run tour
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); // use copy-link, not the OS sheet
    // record outbound links instead of opening real sites (keeps the test offline-safe)
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
});

/** Index (among all elements matching `selector`) of the first one fully on screen, or -1. */
async function onScreenIndex(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
    });
  }, selector);
}

async function currentHeadline(page: Page): Promise<string> {
  const idx = await onScreenIndex(page, '[data-testid="card-headline"]');
  expect(idx, 'a card headline is on screen').toBeGreaterThanOrEqual(0);
  return page.locator('[data-testid="card-headline"]').nth(idx).innerText();
}

async function nextCard(page: Page) {
  const before = await currentHeadline(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => currentHeadline(page).catch(() => before), { timeout: 10_000 }).not.toBe(before);
  return currentHeadline(page);
}

test('feed loads with the sample banner, disclaimer, sources and like / dislike', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/SAMPLE DATA/)).toBeVisible();
  const first = await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  await expect(page.getByText('Informational only · Not investment advice').first()).toBeVisible();
  // never a publisher image or a price on a card
  expect(await page.locator('img').count()).toBe(0);
  // no overflow sideways at this viewport
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('next card: keyboard moves to a different card', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  const first = await currentHeadline(page);
  const second = await nextCard(page);
  expect(second).not.toBe(first);
  await page.waitForTimeout(500); // past the 320 ms move lock (D-88), or the key is ignored on purpose
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => currentHeadline(page)).toBe(first);
});

test('every card has like and dislike buttons that toggle and are tap-sized', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  for (let card = 0; card < 2; card++) {
    const likeSel = '[aria-label="More like this"]';
    const dislikeSel = '[aria-label="Less like this"]';
    const li = await onScreenIndex(page, likeSel);
    const di = await onScreenIndex(page, dislikeSel);
    expect(li, 'like button on screen').toBeGreaterThanOrEqual(0);
    expect(di, 'dislike button on screen').toBeGreaterThanOrEqual(0);
    const like = page.locator(likeSel).nth(li);
    const dislike = page.locator(dislikeSel).nth(di);
    for (const b of [like, dislike]) {
      const box = await b.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await dislike.click();
    await expect(dislike).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await dislike.click(); // pressing again undoes it
    await expect(dislike).toHaveAttribute('aria-pressed', 'false');
    if (card === 0) await nextCard(page);
  }
});

test('sources sheet opens with a link to the original and closes', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  const sel = '[aria-label^="Sources:"]';
  const i = await onScreenIndex(page, sel);
  expect(i).toBeGreaterThanOrEqual(0);
  await page.locator(sel).nth(i).click();
  const sheet = page.getByLabel('Sources', { exact: true });
  await expect(sheet).toBeVisible();
  const link = sheet.getByRole('link').first();
  await expect(link).toBeVisible();
  // real anchors (M9 trust): every source link has an https href, opens in a new tab and is noopener
  const links = sheet.locator('a[href]');
  expect(await links.count()).toBeGreaterThan(0);
  for (const el of await links.all()) {
    await expect(el).toHaveAttribute('href', /^https:\/\//);
    await expect(el).toHaveAttribute('target', '_blank');
    await expect(el).toHaveAttribute('rel', /noopener/);
  }
  // the browser does the navigation; stop it here so the test stays offline
  await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), true));
  await link.click();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(sheet).toBeHidden();
});

test('share copies the card /b/<id> page link', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  const sel = '[aria-label="Share"]';
  const i = await onScreenIndex(page, sel);
  expect(i).toBeGreaterThanOrEqual(0);
  await page.locator(sel).nth(i).click();
  await expect(page.getByText('Link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^https:\/\/[^/]+\/b\/[0-9a-f-]{36}$/);
  // The same path opens the shared-card page (app/b/[id].tsx; in production the Pages Function adds the
  // link-preview tags to the same shell).
  const res = await page.goto(new URL(link).pathname, { waitUntil: 'domcontentloaded' });
  expect(res!.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 2, name: /\[SAMPLE\]/ }).filter({ visible: true })).toBeVisible({ timeout: 30_000 });
  // standalone view: BOTH notices inside the view (rule 5, D-80), a source link, like and dislike (D-63), Open Element
  await expect(page.getByText(/Not investment advice/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/may contain errors/i).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sources' }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Like this story', exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dislike this story', exact: true }).filter({ visible: true })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  await page.getByRole('link', { name: 'Open Element' }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('share page: an unknown or malformed card id shows a friendly page with a way into the app', async ({ page }) => {
  for (const path of ['/b/00000000-0000-4000-8000-000000000000', '/b/not-a-card']) {
    await page.goto(path);
    await expect(page.getByText('This story is not available').filter({ visible: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Not investment advice/).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Element' }).filter({ visible: true })).toBeVisible();
  }
});

test('Updates delayed banner shows only when the status says so', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => currentHeadline(page).catch(() => ''), { timeout: 30_000 }).toMatch(/\[SAMPLE\]/);
  await expect(page.getByText(/Updates delayed/)).toHaveCount(0);
  await page.goto('/?mock_delayed=1');
  await expect(page.getByText(/^Updates delayed · last updated .+ ago$/)).toBeVisible();
});

test('search: empty box suggests up to 5 stories above the topics, a suggestion opens its detail', async ({ page }) => {
  await page.goto('/search');
  const box = page.getByTestId('search-suggestions');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box.getByText('Popular right now')).toBeVisible();
  const rows = box.locator('[aria-label$="Opens more detail"]');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  // the existing chips stay below the suggestions
  const chips = page.getByText('Try a company');
  await expect(chips).toBeVisible();
  const boxY = (await box.boundingBox())!.y;
  expect((await chips.boundingBox())!.y).toBeGreaterThan(boxY);
  await rows.first().click();
  await expect(page.locator('[aria-label^="More detail: "]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  // typing a query replaces the suggestions with results, without the error screen
  await page.getByLabel('Search stories, companies and topics').fill('sample');
  await expect(box).toBeHidden();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});