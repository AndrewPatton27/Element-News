import { expect, test, type Page } from '@playwright/test';

// Feed navigation must be deterministic: every accepted action moves exactly one card, never skips,
// never goes backwards unless asked, and the order of cards already queued never changes under the
// reader (no reorders, no cards inserted between). A sampler in the page records, every frame,
// which card headline is on screen and the order of the rendered cards; the tests then press keys
// fast, hold them (auto-repeat), swipe, and check the recorded sequence.

const H = '[data-testid="card-headline"]';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((sel) => {
    localStorage.setItem('element.tutorial-seen.v1', new Date().toISOString()); // skip the first-run tour
    localStorage.setItem('element.swipe-coach-seen', '1'); // no swipe hint
    type Move = { from: string; to: string; delta: number };
    const nav = { cur: '' as string, moves: [] as Move[], reorders: [] as string[], inserts: [] as string[], last: [] as string[] };
    (window as unknown as { __nav: typeof nav }).__nav = nav;
    const tick = () => {
      const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      const order = els.map((e) => e.innerText.trim());
      const cur = els.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
      })?.innerText.trim();
      // Cards both lists share must keep their relative order, and no new card may appear
      // between two cards that were already rendered next to each other.
      const prev = nav.last;
      const common = order.filter((h) => prev.includes(h));
      const prevCommon = prev.filter((h) => order.includes(h));
      if (common.join('|') !== prevCommon.join('|')) nav.reorders.push(`${prevCommon.join(' / ')}  =>  ${common.join(' / ')}`);
      order.forEach((h, i) => {
        if (prev.includes(h) || i === 0 || i === order.length - 1) return;
        const a = prev.indexOf(order[i - 1]);
        const b = prev.indexOf(order[i + 1]);
        if (a >= 0 && b === a + 1) nav.inserts.push(`${h} inserted between ${order[i - 1]} and ${order[i + 1]}`);
      });
      nav.last = order;
      if (cur && cur !== nav.cur) {
        if (nav.cur) nav.moves.push({ from: nav.cur, to: cur, delta: order.indexOf(cur) - order.indexOf(nav.cur) });
        nav.cur = cur;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, H);
});

type Nav = { cur: string; moves: { from: string; to: string; delta: number }[]; reorders: string[]; inserts: string[] };
const nav = (page: Page) => page.evaluate(() => (window as unknown as { __nav: Nav }).__nav);

async function ready(page: Page) {
  await page.goto('/');
  await expect.poll(async () => (await nav(page)).cur, { timeout: 60_000 }).toMatch(/\[SAMPLE\]/);
  // Let the first paint's follow-up work (tab heads, the next page, the side column) land: that
  // is exactly when the old feed re-ordered itself under the reader.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const n = (window as unknown as { __nav: Nav }).__nav;
    n.moves = [];
    n.reorders = [];
    n.inserts = [];
  });
}

async function settle(page: Page) {
  await page.waitForTimeout(1200);
  return nav(page);
}

function expectClean(n: Nav) {
  expect(n.reorders, 'cards already queued never change order').toEqual([]);
  expect(n.inserts, 'no card is inserted between queued cards').toEqual([]);
}

test('ArrowRight pressed fast: strictly forward, one card at a time, no reorders', async ({ page }) => {
  await ready(page);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
  }
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.length, 'fast presses still move the feed').toBeGreaterThanOrEqual(2);
  expect(n.moves.map((m) => m.delta), 'every move is exactly one card forward').toEqual(n.moves.map(() => 1));
  expect(new Set(n.moves.map((m) => m.to)).size, 'no card shown twice').toBe(n.moves.length);
});

test('ArrowRight at a steady pace: each press moves exactly one card', async ({ page }) => {
  await ready(page);
  const presses = 10;
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
  }
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.map((m) => m.delta)).toEqual(Array(presses).fill(1));
});

test('holding a key (auto-repeat) moves one card, not many', async ({ page }) => {
  await ready(page);
  for (const key of ['ArrowRight', 'ArrowDown']) {
    await page.evaluate((k) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      for (let i = 0; i < 25; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: k, repeat: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    }, key);
    await page.waitForTimeout(700);
  }
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.map((m) => m.delta)).toEqual([1, 1]);
});

test('down, like, dislike, up: +1, +1, +1, -1', async ({ page }) => {
  await ready(page);
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowLeft', 'ArrowUp']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(600);
  }
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.map((m) => m.delta)).toEqual([1, 1, 1, -1]);
});

test('Undo after a like goes back exactly one card and clears the like', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(600);
  const liked = (await nav(page)).cur;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  await page.getByTestId('undo-toast').getByRole('button', { name: /undo/i }).click();
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.map((m) => m.delta)).toEqual([1, 1, -1]);
  expect(n.cur).toBe(liked);
});

// The corner toast: small, bottom-left, aria-live, a 44 px Undo target, and clear of the card the
// reader is on (headline, More detail, like / dislike / follow / share buttons).
async function checkCornerToast(page: Page, shot: string) {
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  await page.waitForTimeout(900);
  const pill = (await toast.boundingBox())!;
  const undoBtn = toast.getByRole('button', { name: /undo/i });
  await expect(undoBtn).toBeVisible();
  const hit = (await undoBtn.boundingBox())!;
  const vp = page.viewportSize()!;
  await page.screenshot({ path: shot });
  // The pill looks small (about 36 px); the Undo tap target is a full 44 px.
  expect(pill.height).toBeLessThanOrEqual(40);
  expect(hit.height).toBeGreaterThanOrEqual(44);
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(pill.width).toBeLessThanOrEqual(Math.min(200, vp.width * 0.5));
  // Lower-left corner.
  expect(pill.x).toBeLessThan(vp.width / 2);
  expect(pill.y + pill.height).toBeGreaterThan(vp.height * 0.6);
  // Everything the toast can catch a tap on: the pill and the Undo target.
  const x0 = Math.min(pill.x, hit.x), y0 = Math.min(pill.y, hit.y);
  const box = { x: x0, y: y0, width: Math.max(pill.x + pill.width, hit.x + hit.width) - x0, height: Math.max(pill.y + pill.height, hit.y + hit.height) - y0 };
  // Over the small print, not over the card the reader is now on: its headline, body text,
  // sources and action buttons stay clear.
  const blockers = await page.evaluate((sel) => {
    const heads = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const cur = heads.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    const out: { what: string; x: number; y: number; w: number; h: number }[] = [];
    // The part of the element a reader can actually see and tap: clipped by every scrolling or
    // overflow-hidden ancestor (a tall card scrolls inside its box, so "More detail" can sit half
    // below the card's bottom edge, where the toast cannot cover it).
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      let l = r.left, t = r.top, rt = r.right, bt = r.bottom;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        l = Math.max(l, pr.left); t = Math.max(t, pr.top); rt = Math.min(rt, pr.right); bt = Math.min(bt, pr.bottom);
      }
      return { left: l, top: t, width: Math.max(0, rt - l), height: Math.max(0, bt - t) };
    };
    const add = (what: string, el: Element | null | undefined) => {
      if (!el) return;
      const r = visible(el);
      if (r.width > 0 && r.height > 0 && r.top + r.height > 0 && r.top < window.innerHeight) out.push({ what, x: r.left, y: r.top, w: r.width, h: r.height });
    };
    add('headline', cur);
    document
      .querySelectorAll('[aria-label="More like this"], [aria-label="Less like this"], [aria-label^="Follow this story"], [aria-label^="Following this story"], [aria-label="Share"]')
      .forEach((b) => add('button', b));
    document.querySelectorAll('[aria-label^="More detail"]').forEach((b) => add('more detail', b));
    return out;
  }, H);
  const overlaps = blockers.filter((b) => !(b.x >= box.x + box.width || b.x + b.w <= box.x || b.y >= box.y + box.height || b.y + b.h <= box.y));
  expect(overlaps, 'toast overlaps').toEqual([]);
}

test('the like toast sits bottom-left, small, and covers no card text or buttons', async ({ page }, info) => {
  await ready(page);
  await page.keyboard.press('ArrowRight');
  await checkCornerToast(page, info.outputPath(`toast-${info.project.name}.png`));
});

test('the hide-topic toast uses the same corner and covers nothing', async ({ page }, info) => {
  await ready(page);
  // Data cards have no "Hide <topic>" item (M9): move to a news card first.
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
  await page.getByText(/^Hide .* topics$/).click();
  await expect(page.getByTestId('undo-toast')).toHaveAttribute('aria-label', /topics hidden\./);
  await checkCornerToast(page, info.outputPath(`toast-hide-${info.project.name}.png`));
});

test('swipe right (touch) moves exactly one card forward', async ({ page, browserName }, info) => {
  test.skip(info.project.name !== 'mobile' || browserName !== 'chromium', 'touch swipe is a phone gesture');
  await ready(page);
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize()!;
  const y = vp.height * 0.45;
  for (let s = 0; s < 2; s++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y }] });
    for (let x = 80; x <= 340; x += 20) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(8);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(900);
  }
  const n = await settle(page);
  expectClean(n);
  expect(n.moves.map((m) => m.delta)).toEqual([1, 1]);
});
