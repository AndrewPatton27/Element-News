import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountInitial, shortEmail } from '../accountLabel.ts';

test('accountInitial is the upper-cased first letter, E when unknown', () => {
  assert.equal(accountInitial('drew@example.com'), 'D');
  assert.equal(accountInitial('  zed@x.io'), 'Z');
  assert.equal(accountInitial(''), 'E');
  assert.equal(accountInitial(null), 'E');
});

test('shortEmail keeps the part before @ and cuts long ones', () => {
  assert.equal(shortEmail('drew@example.com'), 'drew');
  assert.equal(shortEmail('a.very.long.address.indeed@example.com'), 'a.very.long.addre…');
  assert.equal(shortEmail('a.very.long.address.indeed@example.com').length, 18);
  assert.equal(shortEmail(''), 'Account');
  assert.equal(shortEmail('@x.com'), 'Account');
});
