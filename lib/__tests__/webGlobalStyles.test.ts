import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_RING_COLOR, installWebGlobalCss, webGlobalCss } from '../theme/webGlobalStyles.ts';

test('global web CSS has a keyboard-only focus ring, long-word wrapping and reduced motion', () => {
  const css = webGlobalCss();
  assert.match(css, /\[role="button"\]:focus-visible/);
  assert.match(css, new RegExp(`outline:2px solid ${FOCUS_RING_COLOR}`));
  assert.match(css, /:focus:not\(:focus-visible\)\{outline:none;\}/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('installWebGlobalCss adds one style element and never twice', () => {
  const els: Record<string, unknown> = {};
  const appended: unknown[] = [];
  const doc = {
    getElementById: (id: string) => els[id] ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el: any) => { els[el.id] = el; appended.push(el); return el; } },
  };
  assert.equal(installWebGlobalCss(doc), true);
  assert.equal(installWebGlobalCss(doc), false);
  assert.equal(appended.length, 1);
  assert.equal(installWebGlobalCss(undefined), false);
});
