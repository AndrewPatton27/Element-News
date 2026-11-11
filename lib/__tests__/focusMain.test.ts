import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusMain, SKIP_TARGET_ID } from '../shared/focusMain.ts';

function el() {
  const attrs: Record<string, string> = {};
  return { focused: 0, attrs, focus() { this.focused++; }, setAttribute(k: string, v: string) { attrs[k] = v; }, hasAttribute: (k: string) => k in attrs };
}

test('focuses the skip target and makes it script-focusable without a Tab stop', () => {
  const t = el(), m = el();
  const doc = { getElementById: (id: string) => (id === SKIP_TARGET_ID ? t : null), querySelector: () => m };
  assert.equal(focusMain(doc), true);
  assert.equal(t.focused, 1);
  assert.equal(t.attrs.tabindex, '-1');
  assert.equal(m.focused, 0);
});

test('falls back to the main landmark, then to nothing', () => {
  const m = el();
  assert.equal(focusMain({ getElementById: () => null, querySelector: (s: string) => (s === '[role="main"]' ? m : null) }), true);
  assert.equal(m.focused, 1);
  assert.equal(focusMain({ getElementById: () => null, querySelector: () => null }), false);
});
