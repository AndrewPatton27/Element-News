import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenableUrl } from '../shared/safeUrl.ts';

test('only https URLs may be opened', () => {
  assert.equal(isOpenableUrl('https://www.sec.gov/x'), true);
  assert.equal(isOpenableUrl('HTTPS://fred.stlouisfed.org/legal/'), true);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'http://example.com', 'file:///etc/passwd',
    'intent://x#Intent;end', ' https://example.com', 'https://exa mple.com', '', null, undefined, 42, '//example.com']) {
    assert.equal(isOpenableUrl(bad), false, String(bad));
  }
});
