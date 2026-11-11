import { expect, test, type Browser, type Page } from '@playwright/test';

// M9 batch 2 (feed UI), mock data, signed out:
//  - I-12  switching tabs is client-side: no document request, no reload, never a blank screen
//  - I-01  Trending / Latest + a category chip shows only that category, and "All" brings the rest back
//  - G-04  "Follow story" label on wide cards; Following threads label the period of each update
//  - dimmed disliked cards in Latest, ticker details, "More detail" reachable on a card that scrolls
//  - screenshots at 360, 390, 820 and 1280 px (test-results/m9b-shots, untracked)

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

test.describe('tabs are client side (I-12)', () => {
  for (const [label, size, phone] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]] as const) {
    test(`${label}: no document request, no reload and no blank frame when switching tabs`, async ({ browser }, info) => {
      test.skip(info.project.name !== 'desktop', 'opens its own contexts; runs once');
      test.setTimeout(180_000);
      const page = await openPage(browser, size, phone);
      const docs: string[] = [];
      page.on('request', (r) => {
        if (r.resourceType() === 'document') docs.push(r.url());
      });
      await cardsOnScreen(page);
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        (window as unknown as { __marker: string }).__marker = 'same-document';
        const w = window as unknown as { __blank: number; __frames: number };
        w.__blank = 0;
        w.__frames = 0;
        const tick = () => {
          w.__frames++;
          // A blank frame: (almost) no text at all, or no app bar (bottom tabs on a phone, top bar on desktop).
          const text = document.body.innerText.trim().length;
          const bar = document.querySelector('[role="banner"]') || document.querySelector('[role="tablist"][aria-label="Main"]');
          if (text < 30 || !bar) w.__blank++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const go = async (name: string) => {
        const target = phone ? page.getByRole('tab', { name, exact: true }) : page.getByRole('link', { name, exact: true });
        await target.first().click();
        await page.waitForTimeout(900);
      };
      // feed tabs
      await page.getByRole('tab', { name: /^Latest/ }).first().click();
      await page.waitForTimeout(700);
      await page.getByRole('tab', { name: /^For you/ }).first().click();
      await page.waitForTimeout(700);
      await page.getByRole('tab', { name: /^Trending/ }).first().click();
      await page.waitForTimeout(700);
      // the other screens, then back to the feed
      for (const name of ['Brief', 'Search', 'Following']) await go(name);
      if (phone) await go('Feed');
      else await page.getByRole('link', { name: /home$/ }).first().click();
      await cardsOnScreen(page);
      await page.waitForTimeout(500);
      expect(docs, 'document requests after the first load').toEqual([]);
      const state = await page.evaluate(() => ({ marker: (window as unknown as { __marker?: string }).__marker, blank: (window as unknown as { __blank: number }).__blank, frames: (window as unknown as { __frames: number }).__frames }));
      expect(state.marker).toBe('same-document');
      expect(state.frames).toBeGreaterThan(30);
      expect(state.blank, 'frames with no text or no app bar').toBe(0);
      await page.context().close();
    });
  }
});
