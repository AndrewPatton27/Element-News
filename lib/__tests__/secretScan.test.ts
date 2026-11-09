// The secret scan used by CI and before commits (scripts/secret-scan.mjs). Fake keys are built from pieces so this
// file itself never looks like a secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain .mjs script without types
import { forbiddenPath, scanText } from '../../scripts/secret-scan.mjs';

const seg = (n: number) => 'A1b2C3d4E5'.repeat(Math.ceil(n / 10)).slice(0, n);

test('secret scan: finds key shapes and reports the line, not the value', () => {
  const jwt = ['eyJ' + seg(20), 'eyJ' + seg(20), seg(30)].join('.');
  const cases: Array<[string, string]> = [
    ['JWT', `const k = "${jwt}";`],
    ['Supabase secret key', 'x = ' + 'sb_secret_' + seg(30)],
    ['GitHub token', 'ghp' + '_' + seg(40)],
    ['GitHub fine-grained token', 'github' + '_pat_' + seg(60)],
    ['Google API key', 'AIza' + seg(35)],
    ['Groq API key', 'gsk' + '_' + seg(48)],
    ['Private key block', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['Healthchecks ping URL', 'https://hc-ping.com/' + '11111111-2222-3333-4444-555555555555'],
  ];
  for (const [what, line] of cases) {
    const hits = scanText(`ok\n${line}\nok`);
    assert.deepEqual(hits, [{ line: 2, what }], what);
  }
});

test('secret scan: ordinary code, short test keys and public key names pass', () => {
  assert.deepEqual(scanText("const key = 'eyJ-test-service-role-key';\nSUPABASE_PUBLISHABLE_KEY=\nsb_publishable_testkey1234567890\n"), []);
});

test('secret scan: private paths must never be tracked', () => {
  for (const p of ['.env', '.env.local', 'CLAUDE.md', 'context/todo.md', 'docs/PLAN.md', 'workers/watchdog/.env']) assert.equal(forbiddenPath(p), true, p);
  for (const p of ['.env.example', 'README.md', 'app/index.tsx', 'supabase/functions/functions.md']) assert.equal(forbiddenPath(p), false, p);
});
