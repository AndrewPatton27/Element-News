// The For you ranker record notice (wording approved by Drew) must appear verbatim on the About page
// (For you and Your data), in the Delete my data note on Account, and in the sign-in fine print.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const NOTICE =
  'To ensure the quality of recommended posts, we keep a short record of which cards were shown to you in each batch, for 21 days, linked only to your account. Deleting your data removes it.';
const root = path.resolve(import.meta.dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

test('About page shows the ranker record notice verbatim, in For you and in Your data', () => {
  const about = read('app/about.tsx');
  assert.equal(about.split(NOTICE).length - 1, 2);
  const forYou = about.indexOf('How the feeds are ordered');
  const yourData = about.indexOf('title="Your data"');
  const first = about.indexOf(NOTICE);
  const second = about.indexOf(NOTICE, first + 1);
  assert.ok(forYou < first && first < yourData && yourData < second);
});

test('Account and sign-in notes carry the same notice verbatim', () => {
  for (const f of ['app/account.tsx', 'app/signin.tsx']) assert.ok(read(f).includes(NOTICE), f);
});
