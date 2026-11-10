import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkProps } from '../shared/linkProps.ts';

const calls: string[] = [];
const actions = { track: () => calls.push('track'), open: () => calls.push('open') };

test('web: a real href that opens in a new tab with noopener; press only tracks', () => {
  calls.length = 0;
  const p = buildLinkProps('https://www.sec.gov/x', true, actions);
  assert.ok(p);
  assert.equal(p.href, 'https://www.sec.gov/x');
  assert.deepEqual(p.hrefAttrs, { target: '_blank', rel: 'noopener noreferrer' });
  p.onPress();
  assert.deepEqual(calls, ['track']); // the browser navigates, so no second open
});

test('phone: no href, press opens the URL', () => {
  calls.length = 0;
  const p = buildLinkProps('https://www.sec.gov/x', false, actions);
  assert.ok(p);
  assert.equal(p.href, undefined);
  p.onPress();
  assert.deepEqual(calls, ['open']);
});

test('unsafe URLs never become links', () => {
  for (const u of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '', 'file:///etc/passwd']) {
    assert.equal(buildLinkProps(u, true, actions), null, u);
    assert.equal(buildLinkProps(u, false, actions), null, u);
  }
});
