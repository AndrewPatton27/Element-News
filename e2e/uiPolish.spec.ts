import { expect, test, type Browser, type Page } from '@playwright/test';

// ui-polish-m8: the layout and motion promises of the UI polish pass. Runs once (desktop
// project) and opens its own phone / desktop contexts.

const H = '[data-testid="card-headline"]';

async function open(browser: Browser, size: { width: number; height: number }, phone: boolean, path = '/'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone });
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

test('wide web: About is a top-bar link and nothing floats over the content', async ({ browser }) => {
  for (const path of ['/', '/brief', '/search']) {
    const page = await open(browser, { width: 1280, height: 800 }, false, path);
    const about = page.getByRole('link', { name: 'About Element' });
    await expect(about).toHaveCount(1, { timeout: 30_000 });
    const box = await about.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(100); // in the 64 px top bar (under the sample banner)
    await page.context().close();
  }
});

test('360 x 640 phone: the data card shows its change and agency citation without scrolling', async ({ browser }) => {
  const page = await open(browser, { width: 360, height: 640 }, true);
  await expect(page.locator(H).first()).toBeVisible({ timeout: 30_000 });
  const r = await page.evaluate(() => {
    const inView = (el: Element) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.top >= 0 && b.bottom <= window.innerHeight;
    };
    const texts = Array.from(document.querySelectorAll('div, span')).filter((e) => e.children.length === 0) as HTMLElement[];
    const cite = texts.find((e) => /via FRED/.test(e.innerText) && inView(e));
    const change = texts.find((e) => /^▲ up \+/.test(e.innerText.trim()) && inView(e));
    const like = Array.from(document.querySelectorAll('[aria-label="More like this"]')).find(inView);
    return {
      cite: cite ? cite.getBoundingClientRect().bottom : null,
      change: !!change,
      bar: like ? like.getBoundingClientRect().top : null,
    };
  });
  expect(r.change).toBe(true);
  expect(r.cite).not.toBeNull();
  expect(r.bar).not.toBeNull();
  expect(r.cite!).toBeLessThan(r.bar!); // the citation sits above the bottom bar, inside the card
  await page.context().close();
});

test('the moving Numbers strip is one keyboard stop', async ({ browser }) => {
  const page = await open(browser, { width: 1280, height: 800 }, false);
  const strip = page.getByRole('link', { name: /^Numbers to know: / });
  await expect(strip).toHaveCount(1, { timeout: 30_000 });
  // no other focusable copy of a ticker item
  expect(await page.getByRole('link', { name: /Opens Numbers to know\.$/ }).count()).toBe(1);
  await page.context().close();
});

test('arrow keys move instantly (no smooth scroll on a key press)', async ({ browser }) => {
  const page = await open(browser, { width: 1280, height: 800 }, false);
  await expect(page.locator(H).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  const before = await page.evaluate((sel) => {
    const el = Array.from(document.querySelectorAll(sel)).find((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }) as HTMLElement | undefined;
    return el?.innerText ?? '';
  }, H);
  await page.keyboard.press('ArrowDown');
  // Two frames later the next card is already fully in place.
  const after = await page.evaluate(
    (sel) =>
      new Promise<string>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = Array.from(document.querySelectorAll(sel)).find((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }) as HTMLElement | undefined;
            done(el?.innerText ?? '');
          }),
        ),
      ),
    H,
  );
  expect(after).not.toBe('');
  expect(after).not.toBe(before);
  await page.context().close();
});

test('More detail sheet: a short pull springs back, a long pull closes it', async ({ browser }) => {
  const page = await open(browser, { width: 390, height: 844 }, true);
  await expect(page.locator(H).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^More detail./ }).first().click();
  const sheet = page.getByRole('dialog', { name: /^More detail: / });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(450); // entrance done
  const cb = (await sheet.getByRole('button', { name: 'Close' }).boundingBox())!;
  const x = cb.x - 120; // on the header row, left of the close button
  const y = cb.y + cb.height / 2;
  const top0 = (await sheet.boundingBox())!.y;
  const cdp = await page.context().newCDPSession(page);
  const drag = async (dist: number, stepMs: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let d = 10; d <= dist; d += 10) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + d }] });
      await page.waitForTimeout(stepMs);
    }
    await page.waitForTimeout(stepMs * 10); // let the finger rest: no flick
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  await drag(60, 25); // short and slow
  await page.waitForTimeout(700);
  await expect(sheet).toBeVisible();
  expect(Math.abs((await sheet.boundingBox())!.y - top0)).toBeLessThan(3); // sprang back

  await drag(420, 8); // past 30% of the sheet
  await expect(sheet).toHaveCount(0, { timeout: 3_000 });
  await page.context().close();
});
