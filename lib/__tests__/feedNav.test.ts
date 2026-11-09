import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_LOCK_MS,
  SETTLE_GRACE_MS,
  canReactNow,
  currentIndex,
  initNav,
  isKeyRepeat,
  reactNav,
  renderedIds,
  restingIndex,
  settleNav,
  stepNav,
  syncNav,
  undoNav,
  type NavState,
} from '../feed/feedNav.ts';
import { promoteHead } from '../feed/feedOrder.ts';
import { rerankQueue } from '../feed/queueLogic.ts';
import { diversifyFeed } from '../feed/diversify.ts';
import { card } from './helpers.ts';

const ids = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${i}`);
// promoteHead (index.tsx's first-card swap from the tab heads) on plain ids.
const promote = (list: string[], head: string) => promoteHead(list.map((id) => card({ id })), head).map((c) => c.id);

// ---------- basics ----------

test('starts on the first card and renders five rows', () => {
  const s = initNav(ids(20));
  assert.equal(s.currentId, 'c0');
  assert.deepEqual(renderedIds(s), ids(5));
});

test('a step moves exactly one card and locks briefly', () => {
  let s = initNav(ids(10));
  const r = stepNav(s, 1, 1000);
  assert.ok(r.accepted);
  s = r.state;
  assert.equal(s.currentId, 'c1');
  assert.equal(stepNav(s, 1, 1000 + NAV_LOCK_MS - 1).accepted, false, 'a second press inside the lock is dropped');
  assert.equal(stepNav(s, 1, 1000 + NAV_LOCK_MS).state.currentId, 'c2');
});

test('no step past either end', () => {
  const s = initNav(ids(2));
  assert.equal(stepNav(s, -1, 0).accepted, false);
  const last = stepNav(s, 1, 0).state;
  assert.equal(stepNav(last, 1, 10_000).accepted, false);
});

test('like / dislike only act on the card on screen, and step forward one', () => {
  const s = initNav(ids(5));
  assert.equal(canReactNow(s, 'c3', 0), false);
  assert.equal(reactNav(s, 'c3', 0).accepted, false);
  const r = reactNav(s, 'c0', 0);
  assert.equal(r.state.currentId, 'c1');
  assert.equal(reactNav(r.state, 'c1', 10).accepted, false, 'locked');
});

test('like on the last card counts but does not move', () => {
  let s = initNav(ids(2));
  s = stepNav(s, 1, 0).state;
  const r = reactNav(s, 'c1', 10_000);
  assert.ok(r.accepted);
  assert.equal(r.state.currentId, 'c1');
});

test('undo goes back exactly to the reacted card', () => {
  let s = initNav(ids(6));
  s = reactNav(s, 'c0', 0).state; // liked c0, now on c1
  const u = undoNav(s, 'c0', 100);
  assert.ok(u.accepted);
  assert.equal(u.state.currentId, 'c0');
  assert.equal(currentIndex(u.state), currentIndex(s) - 1);
  assert.equal(undoNav(s, 'gone', 100).accepted, false);
});

test('key auto-repeat is recognised', () => {
  assert.equal(isKeyRepeat({ repeat: true }), true);
  assert.equal(isKeyRepeat({ repeat: false }), false);
  assert.equal(isKeyRepeat({}), false);
});

test('resting index rounds the offset to a page', () => {
  assert.equal(restingIndex(0, 800), 0);
  assert.equal(restingIndex(1210, 800), 2);
  assert.equal(restingIndex(-30, 800), 0);
  assert.equal(restingIndex(500, 0), 0);
});

// ---------- scroll reports ----------

test('a stale rest report from before our own scroll is ignored', () => {
  let s = initNav(ids(10));
  s = stepNav(s, 1, 0).state; // animating to c1
  assert.equal(settleNav(s, 0, 100).accepted, false, 'still on c0 mid-animation: not a move back');
  assert.equal(settleNav(s, 0, 100).state.currentId, 'c1');
  s = settleNav(s, 1, 300).state;
  assert.equal(s.pending, null, 'landing clears the pending move');
});

test('after the grace period a rest report is believed (the user interrupted)', () => {
  let s = initNav(ids(10));
  s = stepNav(s, 1, 0).state;
  const r = settleNav(s, 0, SETTLE_GRACE_MS + 1);
  assert.equal(r.state.currentId, 'c0');
  assert.equal(r.cause, 'settle');
});

test('a user scroll moves the current card, back or forward', () => {
  let s = initNav(ids(10));
  s = settleNav(s, 2, 0).state;
  assert.equal(s.currentId, 'c2');
  s = settleNav(s, 1, 10).state;
  assert.equal(s.currentId, 'c1');
});

test('rest reports beyond the rendered rows are ignored', () => {
  const s = initNav(ids(30));
  assert.equal(settleNav(s, 20, 0).accepted, false);
});

// ---------- the frozen order (Drew's recording: reorders and cards inserted between) ----------

test('a refetch that reorders everything changes nothing that is rendered', () => {
  let s = initNav(ids(20));
  s = stepNav(s, 1, 0).state;
  const shuffled = [...ids(20)].reverse();
  const r = syncNav(s, shuffled);
  assert.deepEqual(renderedIds(r.state).slice(0, 5), ids(5));
  assert.equal(r.state.currentId, 'c1');
});

test('new cards only join after the queued ones, never between', () => {
  let s = initNav(ids(8));
  s = stepNav(s, 1, 0).state;
  const r = syncNav(s, ['n0', 'c0', 'n1', 'c1', 'c2', 'n2', ...ids(8).slice(3)]);
  const frozen = renderedIds(s);
  assert.deepEqual(r.state.order.slice(0, frozen.length), frozen);
  assert.ok(r.state.order.indexOf('n0') >= frozen.length);
});

test('the tab-head promotion switching off (old bug: index 1 showed the old first card again)', () => {
  const list = ids(12);
  const promoted = promote(list, 'c5'); // what the pager got at position 0
  let s = initNav(promoted);
  s = stepNav(s, 1, 0).state;
  const seen = [s.currentId];
  // At position > 0 index.tsx stopped promoting: upstream order is the plain list again.
  s = syncNav(s, list).state;
  seen.push(s.currentId);
  for (let t = 1; t <= 4; t++) {
    s = stepNav(s, 1, t * 1000).state;
    seen.push(s.currentId);
  }
  assert.deepEqual(seen, ['c0', 'c0', 'c1', 'c2', 'c3', 'c4'], 'no repeat, no skip after the head swap');
  assert.equal(seen.includes('c5'), false, 'c5 was shown first and is not shown again');
});

test('diversify re-run on page append cannot move rendered cards', () => {
  const page1 = Array.from({ length: 10 }, (_, i) => card({ id: `a${i}`, category: i % 2 ? 'earnings' : 'macro' }));
  const page2 = Array.from({ length: 10 }, (_, i) => card({ id: `b${i}`, category: 'earnings' }));
  let s = initNav(diversifyFeed(page1).map((c) => c.id));
  for (let t = 1; t <= 4; t++) s = stepNav(s, 1, t * 1000).state;
  const before = renderedIds(s);
  s = syncNav(s, diversifyFeed([...diversifyFeed(page1), ...page2]).map((c) => c.id)).state;
  assert.deepEqual(s.order.slice(0, before.length), before);
});

test('rerank after a like with a stale position cannot touch rendered cards', () => {
  const cards = Array.from({ length: 15 }, (_, i) => card({ id: `c${i}`, category: i % 3 ? 'macro' : 'earnings' }));
  let s = initNav(cards.map((c) => c.id));
  for (let t = 1; t <= 4; t++) s = stepNav(s, 1, t * 1000).state;
  const before = renderedIds(s);
  // rerankQueue pins only seenCount + 2; a stale seenCount of 0 would move c2.. under the reader.
  const reranked = rerankQueue([...cards].reverse(), { reactions: {}, follows: { topics: [], sources: [], tickers: [] } } as never, 0, true);
  s = syncNav(s, reranked.map((c) => c.id)).state;
  assert.deepEqual(s.order.slice(0, before.length), before);
  assert.equal(s.currentId, 'c4');
});

test('hiding the current card moves FORWARD to the next one that is left', () => {
  let s = initNav(ids(10));
  s = stepNav(s, 1, 0).state; // on c1
  s = syncNav(s, ids(10).filter((id) => id !== 'c1' && id !== 'c2')).state;
  assert.equal(s.currentId, 'c3');
});

test('hiding a card behind the reader keeps the reader on the same card', () => {
  let s = initNav(ids(10));
  s = stepNav(s, 1, 0).state;
  s = stepNav(s, 1, 1000).state; // on c2
  const r = syncNav(s, ids(10).filter((id) => id !== 'c0'));
  assert.equal(r.state.currentId, 'c2');
  assert.equal(currentIndex(r.state), 1);
});

test('the same list again is a no-op (identity kept, safe to call every render)', () => {
  const s = initNav(ids(10));
  const r = syncNav(s, ids(10));
  assert.equal(r.state, s);
  assert.equal(r.accepted, false);
});

test('everything replaced: start at the first new card', () => {
  const s = stepNav(initNav(ids(5)), 1, 0).state;
  const r = syncNav(s, ids(5, 'z'));
  assert.equal(r.state.currentId, 'z0');
});

// ---------- fuzz: random action sequences ----------

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

type Act = 'down' | 'up' | 'like' | 'dislike' | 'repeat' | 'undo' | 'swipe' | 'scrollRest' | 'staleRest' | 'refetchShuffle' | 'appendPage' | 'insertNew' | 'rerank' | 'headSwap' | 'tick';
const ACTS: Act[] = ['down', 'up', 'like', 'dislike', 'repeat', 'undo', 'swipe', 'scrollRest', 'staleRest', 'refetchShuffle', 'appendPage', 'insertNew', 'rerank', 'headSwap', 'tick'];

for (let seed = 1; seed <= 400; seed++) {
  test(`fuzz ${seed}: no skip, no unasked back move, one card per action, frozen order`, () => {
    const r = rng(seed * 7919);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    let upstream = ids(12);
    let next = 0;
    let s: NavState = initNav(upstream);
    let now = 0;
    let lastReacted: string | null = null;
    const screenOrder = () => s.order;
    for (let step = 0; step < 120; step++) {
      now += Math.floor(r() * 400); // 0..400 ms between events: many inside the lock
      const act = pick(ACTS);
      const before = s;
      const iBefore = currentIndex(before);
      const frozenBefore = renderedIds(before);
      let res = { state: s, accepted: false, cause: 'none' as string };
      switch (act) {
        case 'down':
          res = stepNav(s, 1, now);
          break;
        case 'up':
          res = stepNav(s, -1, now);
          break;
        case 'like':
        case 'dislike':
        case 'swipe': {
          const id = s.currentId!;
          res = reactNav(s, id, now);
          if (res.accepted) lastReacted = id;
          break;
        }
        case 'repeat':
          break; // the screen drops auto-repeat before the machine sees it (isKeyRepeat)
        case 'undo':
          if (lastReacted) res = undoNav(s, lastReacted, now);
          lastReacted = null;
          break;
        case 'scrollRest': {
          // a real user scroll: one page either way from where the list is
          const i = Math.max(0, Math.min(s.revealed - 1, iBefore + (r() < 0.5 ? 1 : -1)));
          res = settleNav(s, i, now + SETTLE_GRACE_MS + 1);
          now += SETTLE_GRACE_MS + 1;
          break;
        }
        case 'staleRest': {
          // a leftover report (the row we came from) while our own scroll is still running; once
          // a move has landed or timed out there is no stale report left to arrive
          if (!s.pending || now >= s.pending.until) break;
          res = settleNav(s, Math.max(0, iBefore - 1), now);
          break;
        }
        case 'refetchShuffle':
          upstream = [...upstream].sort(() => r() - 0.5);
          res = syncNav(s, upstream);
          break;
        case 'appendPage':
          upstream = [...upstream, ...Array.from({ length: 5 }, () => `n${next++}`)];
          res = syncNav(s, upstream);
          break;
        case 'insertNew': {
          const at = Math.floor(r() * upstream.length);
          upstream = [...upstream.slice(0, at), `n${next++}`, ...upstream.slice(at)];
          res = syncNav(s, upstream);
          break;
        }
        case 'rerank': {
          const keep = Math.floor(r() * 3);
          upstream = [...upstream.slice(0, keep), ...upstream.slice(keep).reverse()];
          res = syncNav(s, upstream);
          break;
        }
        case 'headSwap': {
          const h = pick(upstream);
          upstream = promote(upstream, h);
          res = syncNav(s, upstream);
          break;
        }
        case 'tick':
          break;
      }
      s = res.state;
      const iAfter = currentIndex(s);
      // Invariants after every event.
      assert.ok(s.currentId !== null && iAfter >= 0, 'always on a card');
      assert.equal(new Set(s.order).size, s.order.length, 'no duplicates');
      assert.ok(s.revealed >= Math.min(s.order.length, iAfter + 3) || s.revealed === s.order.length, 'next cards rendered');
      // The frozen prefix never changes order and nothing is inserted into it (no removals here).
      assert.deepEqual(s.order.slice(0, frozenBefore.length), frozenBefore, `${act}: rendered cards keep their order`);
      // Movement rules per kind of event.
      const moved = before.currentId !== s.currentId;
      if (act === 'down' || act === 'like' || act === 'dislike' || act === 'swipe') {
        if (moved) assert.equal(iAfter, iBefore + 1, `${act}: exactly one forward`);
      } else if (act === 'up') {
        if (moved) assert.equal(iAfter, iBefore - 1, 'up: exactly one back');
      } else if (act === 'undo') {
        if (moved) assert.ok(iAfter < iBefore, 'undo goes back to the reacted card');
      } else if (act === 'scrollRest') {
        if (moved) assert.equal(Math.abs(iAfter - iBefore), 1, 'a one-page scroll moves one card');
      } else {
        // refetches, inserts, reranks, head swaps, repeats, ticks, stale reports: the reader stays put
        assert.equal(s.currentId, before.currentId, `${act}: never moves the reader`);
        assert.equal(iAfter, iBefore, `${act}: the current card keeps its index`);
      }
      void screenOrder;
    }
  });
}

test('Drew\'s case: held ArrowRight while a background refetch returns a new order and extra cards', () => {
  // Every 30 ms an auto-repeat keydown (dropped by the screen) and, every 4th tick, a real press;
  // a refetch lands every 7th tick with a reshuffled list and new cards in between.
  let upstream = ids(15);
  let s = initNav(upstream);
  const shown: string[] = [s.currentId!];
  let extra = 0;
  for (let t = 1; t <= 120; t++) {
    const now = t * 30;
    const repeat = t % 4 !== 0;
    if (!isKeyRepeat({ repeat })) {
      const r = reactNav(s, s.currentId!, now);
      s = r.state;
    }
    if (t % 7 === 0) {
      // a different order with new cards at the front, in the middle and at the end
      const rev = [...upstream].reverse();
      const mid = Math.floor(rev.length / 2);
      upstream = [`x${extra++}`, ...rev.slice(0, mid), `x${extra++}`, ...rev.slice(mid), `x${extra++}`];
      s = syncNav(s, upstream).state;
    }
    if (shown[shown.length - 1] !== s.currentId) shown.push(s.currentId!);
  }
  // The visible sequence is exactly the frozen order, one card at a time: no gaps, no back moves,
  // no insertions between.
  assert.deepEqual(shown, s.order.slice(0, shown.length));
  assert.ok(shown.length > 5);
  assert.deepEqual(shown.slice(0, 5), ids(5));
});
