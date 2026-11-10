import { expect, test, type Browser, type Page } from '@playwright/test';

// Card layout at four sizes (phone, small phone, tablet, desktop), on the sample data.
// Checks the rules the card redesign must keep and saves a screenshot of each size to
// test-results/cards/ (git-ignored) for a human look:
// - the bottom bar is ONE line: source, like, dislike, follow and share share a row;
// - every bar button is a 44 px tap target, nothing spills sideways;
// - no AI notice or disclaimer inside the card; the feed shows them once in a persistent
//   strip under the card area (D-80) that is on screen, never overlaps the card, and is
//   one line on wide web and at most two lines on phones;
// - like and dislike are on every card (D-63); never an image.
// It opens its own browser contexts, so it runs once (in the desktop project).

const SIZES = [
  { name: 'phone-390x844', width: 390, height: 844, mobile: true },
  { name: 'small-phone-360x640', width: 360, height: 640, mobile: true },
  { name: 'tablet-820x1180', width: 820, height: 1180, mobile: true },
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'desktop-short-1280x640', width: 1280, height: 640, mobile: false },
];

const NOTICE = 'AI-generated summaries may contain errors · Informational only · Not investment advice';
const SHOTS = process.env.CARD_SHOTS_DIR ?? 'test-results/cards';
const CARDS_TO_CHECK = Number(process.env.CARD_SHOTS_COUNT ?? 4);

async function open(browser: Browser, size: (typeof SIZES)[number]): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: size.mobile,
    hasTouch: size.mobile,
    deviceScaleFactor: size.mobile ? 2 : 1,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString());
    window.open = (() => null) as typeof window.open;
  });
  await page.goto('/');
  await expect(page.getByText(/SAMPLE DATA/)).toBeVisible({ timeout: 30_000 });
  return page;
}

interface BarCheck {
  headline: string;
  rows: number[]; // vertical centres of the bar items
  sizes: { w: number; h: number; label: string }[];
  notice: string;
  noticeTop: number;
  noticeBottom: number;
  noticeLines: number;
  barBottom: number;
  cardHasLabels: boolean;
  overflow: boolean;
}

// Measures the bar of the card whose headline is on screen.
async function measure(page: Page): Promise<BarCheck | null> {
  return page.evaluate((notice) => {
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1;
    };
    const h = Array.from(document.querySelectorAll('[data-testid="card-headline"]')).find(inView);
    if (!h) return null;
    const pick = (sel: string) => Array.from(document.querySelectorAll(sel)).find(inView) as HTMLElement | undefined;
    const items = [
      pick('[aria-label^="Sources:"]'),
      pick('[aria-label="More like this"]'),
      pick('[aria-label="Less like this"]'),
      pick('[aria-label^="Follow"], [aria-label^="Following this story"]'),
      pick('[aria-label="Share"]'),
    ].filter(Boolean) as HTMLElement[];
    const strip = Array.from(document.querySelectorAll('[role="note"]')).find((el) => (el.textContent ?? '').replace(/\u00A0/g, ' ').includes(notice)) as HTMLElement | undefined;
    const text = strip?.querySelector('div, span') as HTMLElement | null;
    const sr = strip?.getBoundingClientRect();
    const lineHeight = text ? parseFloat(getComputedStyle(text).lineHeight) || 16 : 16;
    // the card = the nearest ancestor of the headline that also holds the bar's Share button
    let cardEl: HTMLElement | null = h as HTMLElement;
    const share = items[items.length - 1];
    while (cardEl && share && !cardEl.contains(share)) cardEl = cardEl.parentElement;
    const cardText = cardEl?.innerText ?? '';
    const boxes = items.map((el) => el.getBoundingClientRect());
    return {
      headline: (h as HTMLElement).innerText,
      rows: boxes.map((r) => Math.round(r.top + r.height / 2)),
      sizes: items.map((el, i) => ({ w: boxes[i].width, h: boxes[i].height, label: el.getAttribute('aria-label') ?? '' })),
      notice: (strip?.textContent ?? '').replace(/\u00A0/g, ' '),
      noticeTop: sr ? sr.top : -1,
      noticeBottom: sr ? sr.bottom : -1,
      noticeLines: text ? Math.round(text.getBoundingClientRect().height / lineHeight) : 0,
      barBottom: Math.max(...boxes.map((r) => r.bottom)),
      cardHasLabels: /Not investment advice|may contain errors/.test(cardText),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, NOTICE);
}

for (const size of SIZES) {
  test(`card layout at ${size.name}`, async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; once is enough');
    const page = await open(browser, size);
    let last = '';
    for (let i = 0; i < CARDS_TO_CHECK; i++) {
      await expect.poll(async () => (await measure(page))?.headline ?? '', { timeout: 15_000 }).not.toBe(last);
      await page.waitForTimeout(500); // let the snap and the fonts settle before the screenshot
      const m = await measure(page);
      expect(m, 'a card is on screen').not.toBeNull();
      const bar = m!;
      last = bar.headline;
      await page.screenshot({ path: `${SHOTS}/${size.name}-${i + 1}.png` });
      expect(bar.sizes.length, `bar items on "${bar.headline}"`).toBe(5);
      // one line: every item's centre within 4 px of the source block's centre
      for (const y of bar.rows) expect(Math.abs(y - bar.rows[0]), `bar is one line on "${bar.headline}"`).toBeLessThanOrEqual(4);
      for (const s of bar.sizes) {
        expect(s.h, `${s.label} height`).toBeGreaterThanOrEqual(44);
        if (!s.label.startsWith('Sources:')) expect(s.w, `${s.label} width`).toBeGreaterThanOrEqual(44);
      }
      expect(bar.notice, 'persistent notice strip').toBe(NOTICE);
      expect(bar.noticeTop, 'strip is under the card, never over it').toBeGreaterThanOrEqual(bar.barBottom - 1);
      expect(bar.noticeBottom, 'strip is on screen without scrolling').toBeLessThanOrEqual(size.height);
      expect(bar.noticeLines, 'strip line count').toBeLessThanOrEqual(size.mobile && size.width < 600 ? 2 : 1);
      expect(bar.cardHasLabels, 'no AI notice or disclaimer inside the card (D-80)').toBe(false);
      expect(bar.overflow, 'no sideways overflow').toBe(false);
      expect(await page.locator('img').count()).toBe(0);
      if (i < CARDS_TO_CHECK - 1) await page.keyboard.press('ArrowDown');
    }
    await page.context().close();
  });
}

// The other feed-style screens: the same strip, on screen without scrolling, and no
// per-tile AI notice or disclaimer. Screenshots for a human look.
const SCREENS = [
  { name: 'search', path: '/search', query: 'Fed' },
  { name: 'following', path: '/following' },
  { name: 'brief', path: '/brief' },
];

for (const size of [SIZES[0], SIZES[1], SIZES[3]]) {
  test(`feed-style screens show the notice strip at ${size.name}`, async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'opens its own contexts; once is enough');
    test.setTimeout(300_000); // three full page loads on the dev server
    const page = await open(browser, size);
    for (const screen of SCREENS) {
      await page.goto(screen.path);
      if (screen.query) {
        const box = page.getByLabel('Search stories, companies and topics');
        await box.fill(screen.query);
        await box.press('Enter');
        await expect(page.locator('[aria-label^="Sources:"]').first()).toBeVisible({ timeout: 20_000 });
      }
      const strip = page.locator('[role="note"]').filter({ hasText: 'AI-generated summaries may contain errors' });
      await expect(strip).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(600);
      const r = await strip.boundingBox();
      expect(r!.y + r!.height, `${screen.name}: strip on screen`).toBeLessThanOrEqual(size.height);
      await page.screenshot({ path: `${SHOTS}/${size.name}-${screen.name}.png` });
      // tiles carry no copy of the notice: the only match on the page is the strip itself
      expect(await page.getByText(/Not\s+investment\s+advice/).count(), `${screen.name}: notice once`).toBe(1);
    }
    await page.context().close();
  });
}
