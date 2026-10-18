import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRACTICE_INITIAL,
  PRACTICE_MESSAGES,
  TUTORIAL_SEEN_KEY,
  backStep,
  clampStep,
  hasSeenTutorial,
  isLastStep,
  keyToAction,
  markTutorialSeen,
  nextStep,
  practiceHandlers,
  practiceReducer,
  progressLabel,
  shouldAutoShow,
  trapTabIndex,
  type PracticeEvent,
} from '../tutorialLogic.ts';
import { PRACTICE_SAMPLE, TUTORIAL_AI_LABEL, TUTORIAL_MOTION, getTutorialSteps } from '../tutorialSteps.ts';
import { memoryStore, type KeyValueStore } from '../storage.ts';

test('seen flag: unset on first visit, set after markTutorialSeen, versioned key', () => {
  const s = memoryStore();
  assert.equal(hasSeenTutorial(s), false);
  markTutorialSeen(s, new Date('2026-10-18T08:00:00Z'));
  assert.equal(hasSeenTutorial(s), true);
  assert.equal(s.get(TUTORIAL_SEEN_KEY), '2026-10-18T08:00:00.000Z');
  assert.match(TUTORIAL_SEEN_KEY, /^element\.tutorial-seen\.v\d+$/);
});

test('broken storage never traps the reader in the tour', () => {
  const broken: KeyValueStore = {
    get: () => {
      throw new Error('blocked');
    },
    set: () => {
      throw new Error('blocked');
    },
    remove: () => {},
  };
  assert.equal(hasSeenTutorial(broken), true);
  assert.doesNotThrow(() => markTutorialSeen(broken));
});

test('step navigation clamps to the range', () => {
  assert.equal(nextStep(0, 4), 1);
  assert.equal(nextStep(3, 4), 3);
  assert.equal(backStep(0, 4), 0);
  assert.equal(backStep(2, 4), 1);
  assert.equal(clampStep(99, 4), 3);
  assert.equal(clampStep(-1, 4), 0);
  assert.equal(clampStep(Number.NaN, 4), 0);
  assert.equal(clampStep(2, 0), 0);
  assert.equal(isLastStep(3, 4), true);
  assert.equal(isLastStep(2, 4), false);
});

test('keyboard: arrows move, Esc skips, Enter is left to the focused button', () => {
  assert.equal(keyToAction('ArrowDown', 0, 4), 'next');
  assert.equal(keyToAction('ArrowRight', 1, 4), 'next');
  assert.equal(keyToAction('ArrowDown', 3, 4), null);
  assert.equal(keyToAction('ArrowUp', 2, 4), 'back');
  assert.equal(keyToAction('ArrowLeft', 0, 4), null);
  assert.equal(keyToAction('Escape', 2, 4), 'skip');
  assert.equal(keyToAction('Enter', 0, 4), null);
  assert.equal(keyToAction('j', 0, 4), null);
});

test('focus trap wraps Tab and Shift+Tab across dialog controls', () => {
  assert.equal(trapTabIndex(-1, 3), 0);
  assert.equal(trapTabIndex(-1, 3, true), 2);
  assert.equal(trapTabIndex(0, 3, true), 2);
  assert.equal(trapTabIndex(2, 3), 0);
  assert.equal(trapTabIndex(1, 3), 1);
  assert.equal(trapTabIndex(0, 0), -1);
});

test('auto-show only on first visit and never over /tutorial or a reset link', () => {
  assert.equal(shouldAutoShow(false, '/'), true);
  assert.equal(shouldAutoShow(false, '/brief'), true);
  assert.equal(shouldAutoShow(true, '/'), false);
  assert.equal(shouldAutoShow(false, '/tutorial'), false);
  assert.equal(shouldAutoShow(false, '/reset-password'), false);
  assert.equal(shouldAutoShow(false, null), true);
});

test('progress label', () => {
  assert.equal(progressLabel(1, 4), 'Quick tour · 2 of 4');
});

for (const variant of ['mobile', 'web'] as const) {
  test(`${variant}: four steps that describe real behavior`, () => {
    const steps = getTutorialSteps(variant);
    assert.deepEqual(
      steps.map((s) => s.id),
      ['card', 'top', 'brief', 'recap'],
    );
    const all = JSON.stringify(steps);
    // Things the app really does are mentioned.
    for (const word of ['source', 'Brief', 'Following', 'Search', 'For you', 'no account needed', 'AI summary']) {
      assert.ok(all.includes(word), `${variant} mentions ${word}`);
    }
    // Things it does not do are not promised.
    assert.ok(!all.includes('7 AM'), 'no push promise');
    assert.ok(!/pulse/i.test(all), 'cards have no follow pulse button');
    assert.ok(!all.includes('weekly brief'), 'ticker opens sources, not the weekly brief');
    // Advice words never appear.
    assert.ok(!/\b(buy|sell|should)\b/i.test(all));
    // The practice notes do not repeat the disclaimer (shown once, in the footer).
    for (const s of steps) assert.ok(!(s.practiceNote ?? '').includes('Not investment advice'));
  });
}

test('mobile teaches swipes; web teaches thumbs buttons and j/↓ (no ←/→ like keys)', () => {
  const mobile = JSON.stringify(getTutorialSteps('mobile'));
  const web = JSON.stringify(getTutorialSteps('web'));
  assert.ok(mobile.includes('Swipe right') && mobile.includes('Swipe left') && mobile.includes('Swipe up'));
  assert.ok(web.includes('thumbs-up') && web.includes('thumbs-down') && web.includes('Press ↓ or j'));
  assert.ok(!web.includes('Swipe'));
  assert.ok(!web.includes('← to dislike'));
});

test('AI label is the canonical notice', () => {
  assert.equal(TUTORIAL_AI_LABEL, 'AI-generated summary · may contain errors');
});


// ---- Practice card: interactive, but saves nothing ----

test('practice reducer: press toggles, swipe sets, reset clears for another try', () => {
  let s = PRACTICE_INITIAL;
  s = practiceReducer(s, { type: 'press', reaction: 'like' });
  assert.equal(s.reaction, 'like');
  assert.equal(s.message, 'Liked');
  s = practiceReducer(s, { type: 'press', reaction: 'like' });
  assert.equal(s.reaction, null);
  assert.equal(s.message, PRACTICE_MESSAGES.cleared);
  s = practiceReducer(s, { type: 'press', reaction: 'dislike' });
  assert.equal(s.message, 'Disliked');
  s = practiceReducer(s, { type: 'swipe', reaction: 'like' });
  assert.equal(s.reaction, 'like');
  assert.equal(s.message, 'Liked');
  s = practiceReducer(s, { type: 'reset' });
  assert.equal(s.reaction, null);
  s = practiceReducer(s, { type: 'share' });
  assert.equal(s.message, PRACTICE_MESSAGES.share);
  s = practiceReducer(s, { type: 'source' });
  assert.equal(s.message, PRACTICE_MESSAGES.source);
  const before = s.seq;
  s = practiceReducer(s, { type: 'dismiss' });
  assert.equal(s.message, null);
  assert.ok(s.seq > before);
  assert.equal(practiceReducer(s, { type: 'dismiss' }), s, 'dismiss twice is a no-op');
  assert.deepEqual(PRACTICE_INITIAL, { reaction: null, message: null, seq: 0 }, 'initial state never mutated');
});

test('practice swipe uses the feed rule (lib/swipeLogic.ts)', () => {
  const events: PracticeEvent[] = [];
  const h = practiceHandlers((e) => events.push(e));
  assert.equal(h.release(10, 0, 300), null, 'short drag springs back');
  assert.equal(h.release(200, 0, 300), 'like');
  assert.equal(h.release(-200, 0, 300), 'dislike');
  assert.equal(h.release(30, 1.2, 300), 'like', 'fling');
  assert.deepEqual(events, [
    { type: 'swipe', reaction: 'like' },
    { type: 'swipe', reaction: 'dislike' },
    { type: 'swipe', reaction: 'like' },
  ]);
});

test('practice handlers never touch storage, the api, prefs or analytics (fakes injected)', async () => {
  const calls: string[] = [];
  const spyStore = (name: string) => ({
    getItem: () => (calls.push(`${name}.getItem`), null),
    setItem: () => calls.push(`${name}.setItem`),
    removeItem: () => calls.push(`${name}.removeItem`),
    clear: () => calls.push(`${name}.clear`),
    key: () => null,
    length: 0,
  });
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const fakes: Record<string, unknown> = {
    localStorage: spyStore('localStorage'),
    sessionStorage: spyStore('sessionStorage'),
    fetch: async () => {
      calls.push('fetch');
      return new Response('{}');
    },
    XMLHttpRequest: function FakeXhr() {
      calls.push('XMLHttpRequest');
    },
    indexedDB: { open: () => calls.push('indexedDB.open') },
    navigator: { sendBeacon: () => calls.push('sendBeacon'), share: () => calls.push('navigator.share') },
  };
  for (const [k, v] of Object.entries(fakes)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    let state = PRACTICE_INITIAL;
    const h = practiceHandlers((e) => {
      state = practiceReducer(state, e);
    });
    h.like();
    h.dislike();
    h.dislike();
    h.share();
    h.source();
    h.release(250, 0, 300);
    h.reset();
    h.release(-250, -1, 300);
    h.release(5, 0, 300);
    h.dismiss();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, [], 'no storage / network / share calls');
    assert.equal(state.reaction, 'dislike');
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});

test('practice code imports nothing that can save, send or share', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const imports = (src: string) => [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((m) => ({ typeOnly: !!m[1], from: m[2] }));
  const banned = /(\/api|\/storage|localPrefs|account|analytics|supabase|dwell|feedback)/i;
  for (const file of ['../tutorialLogic.ts', '../../components/TutorialPractice.tsx', '../../components/TutorialParts.tsx', '../../components/TutorialMotion.tsx']) {
    const src = read(file);
    for (const imp of imports(src)) {
      if (imp.typeOnly) continue;
      assert.ok(!banned.test(imp.from), `${file} must not import ${imp.from}`);
    }
    if (file.includes('components/')) {
      assert.ok(!/\b(Share|Linking)\b\s*[,}]/.test(src.split('\n').filter((l) => l.startsWith('import')).join('\n')), `${file} must not import Share/Linking`);
      assert.ok(!/\b(localStorage|fetch\(|sendBeacon)/.test(src), `${file} must not touch storage/network`);
    }
  }
  assert.equal(PRACTICE_SAMPLE.practice, true);
  assert.ok(Object.isFrozen(PRACTICE_SAMPLE));
});

test('motion values match the design @keyframes', () => {
  const m = TUTORIAL_MOTION;
  assert.equal(m.sway.ms, 6000);
  assert.deepEqual(m.sway.at, [0, 0.1, 0.22, 0.34, 0.6, 0.72, 0.84, 1]);
  assert.deepEqual(m.sway.x, [0, -14, -14, 0, 14, 14, 0, 0]);
  assert.equal(Math.max(...m.sway.rotateMobile), 2);
  assert.equal(Math.max(...m.sway.rotateWeb), 1.5);
  assert.deepEqual(m.likePill.at, [0, 0.4, 0.6, 0.72, 0.84, 1]);
  assert.equal(m.hint.ms, 1600);
  assert.equal(m.hint.y, 9);
  assert.equal(m.nudge.x, 5);
  assert.equal(m.marquee.msMobile, 30000);
  assert.equal(m.marquee.msWeb, 40000);
  for (const k of ['sway', 'dislikePill', 'likePill', 'hint', 'nudge'] as const) {
    const at = m[k].at;
    assert.equal(at[0], 0);
    assert.equal(at[at.length - 1], 1);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${k} offsets increase`);
  }
});

test('bottom buttons: Back hidden on step 1, Next becomes Done on the last step', async () => {
  const { navButtons, nextOrDone } = await import('../tutorialLogic.ts');
  assert.deepEqual(navButtons(0, 4), { showBack: false, primaryLabel: 'Next' });
  assert.deepEqual(navButtons(2, 4), { showBack: true, primaryLabel: 'Next' });
  assert.deepEqual(navButtons(3, 4), { showBack: true, primaryLabel: 'Done' });
  assert.deepEqual(nextOrDone(1, 4), { type: 'step', step: 2 });
  assert.deepEqual(nextOrDone(3, 4), { type: 'done' });
});
