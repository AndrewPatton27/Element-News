import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteps, runSteps, summarize, formatTable } from '../release-check.mjs';

const names = (steps) => steps.map((s) => s.name);

test('step order and optional e2e', () => {
  const base = names(buildSteps({ env: {} }));
  assert.equal(base[0], 'no private files tracked');
  assert.deepEqual(base.slice(1, 5), ['tsc app', 'tsc ingest', 'tsc functions', 'tsc worker']);
  assert.ok(base.indexOf('test:worker') < base.indexOf('SQL checks (PGlite)'));
  assert.ok(base.indexOf('python tests (ml)') < base.indexOf('secret scan'));
  assert.ok(!base.includes('test:e2e'));
  assert.equal(names(buildSteps({ e2e: true, env: {} })).at(-1), 'test:e2e');
  assert.ok(!base.includes('security gate (prod)'));
  const prod = buildSteps({ prod: true, env: {} });
  assert.equal(names(prod).at(-1), 'security gate (prod)');
  assert.deepEqual(prod.at(-1).args, ['scripts/security-gate.mjs', '--require-build']);
});

test('python skipped when absent or ml/tests missing; SQL skipped without runner', () => {
  const find = (steps, n) => steps.find((s) => s.name === n);
  assert.match(find(buildSteps({ pythonCmd: null, env: {}, exists: () => true }), 'python tests (ml)').skip(), /not found/);
  assert.match(find(buildSteps({ pythonCmd: 'python', env: {}, exists: () => false }), 'python tests (ml)').skip(), /ml\/tests/);
  assert.equal(find(buildSteps({ pythonCmd: 'python', env: {}, exists: () => true }), 'python tests (ml)').skip(), null);
  assert.match(find(buildSteps({ env: {}, exists: () => false }), 'SQL checks (PGlite)').skip(), /no PGlite runner/);
  assert.equal(find(buildSteps({ env: { RELEASE_SQL_RUNNER: 'x.mjs' }, exists: (p) => p === 'x.mjs' }), 'SQL checks (PGlite)').skip(), null);
});

test('runSteps records PASS/FAIL/SKIP and exit code is non-zero on failure', () => {
  const steps = [{ name: 'a' }, { name: 'b' }, { name: 'c', skip: () => 'nope' }];
  const warnings = [];
  const rows = runSteps(steps, (s) => (s.name === 'b' ? { status: 1, output: 'boom' } : { status: 0, output: '' }), (m) => warnings.push(m));
  assert.deepEqual(rows.map((r) => r.status), ['PASS', 'FAIL', 'SKIP']);
  assert.equal(rows[1].output, 'boom');
  assert.equal(warnings.length, 1);
  assert.equal(summarize(rows).exitCode, 1);
  assert.equal(summarize(rows.filter((r) => r.status !== 'FAIL')).exitCode, 0);
  assert.match(formatTable(rows), /FAIL\s+b/);
});
