// One command before a release: type checks, every test suite, SQL checks, Python tests, secret scan.
// Usage: npm run release:check            (add -- --e2e to also run the Playwright suite)
// Prints a PASS / FAIL / SKIP table and exits 1 if any step failed. Only step names and the tail of a
// failing step's own output are printed; the secret scan prints file and line, never values, and
// environment variables are never echoed. SKIP is for steps that cannot run here (no Python, no SQL runner).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const npx = win ? 'npx.cmd' : 'npx';
const npm = win ? 'npm.cmd' : 'npm';

/** The ordered step list. A step is { name, cmd, args, cwd?, skip?: () => string | null }. */
export function buildSteps({ e2e = false, exists = existsSync, pythonCmd = null, env = process.env } = {}) {
  const sqlRunner = env.RELEASE_SQL_RUNNER || 'supabase/tests/run-pglite.mjs';
  const steps = [
    { name: 'no private files tracked', cmd: process.execPath, args: ['scripts/private-files-check.mjs'] },
    { name: 'tsc app', cmd: npx, args: ['tsc', '--noEmit'] },
    { name: 'tsc ingest', cmd: npx, args: ['tsc', '--noEmit', '-p', 'ingest/tsconfig.json'] },
    { name: 'tsc functions', cmd: npx, args: ['tsc', '--noEmit', '-p', 'supabase/functions/tsconfig.json'] },
    { name: 'tsc worker', cmd: npx, args: ['tsc', '--noEmit', '-p', 'workers/watchdog/tsconfig.json'] },
    { name: 'test:app', cmd: npm, args: ['run', 'test:app'] },
    { name: 'test:ingest', cmd: npm, args: ['run', 'test:ingest'] },
    { name: 'test:functions', cmd: npm, args: ['run', 'test:functions'] },
    { name: 'test:worker', cmd: npm, args: ['run', 'test:worker'] },
    { name: 'test:scripts', cmd: npm, args: ['run', 'test:scripts'] },
    // supabase/tests/run-pglite.mjs runs every *_check.sql in PGlite (exit 0 = all passed). RELEASE_SQL_RUNNER
    // can point at a different runner.
    {
      name: 'SQL checks (PGlite)',
      cmd: process.execPath,
      args: [sqlRunner],
      skip: () => (exists(sqlRunner) ? null : 'no PGlite runner found (set RELEASE_SQL_RUNNER)'),
    },
    {
      name: 'python tests (ml)',
      cmd: pythonCmd ?? 'python',
      args: ['-m', 'pytest', 'tests', '-q'],
      cwd: 'ml',
      skip: () => (!pythonCmd ? 'Python not found on PATH' : !exists('ml/tests') ? 'ml/tests does not exist yet' : null),
    },
    { name: 'secret scan', cmd: process.execPath, args: ['scripts/secret-scan.mjs'] },
  ];
  if (e2e) steps.push({ name: 'test:e2e', cmd: npm, args: ['run', 'test:e2e'] });
  return steps;
}

export function formatTable(rows) {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.note ?? ''}`.trimEnd()).join('\n');
}

export function summarize(rows) {
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  return { failed, exitCode: failed ? 1 : 0 };
}

/** Runs the steps with an injectable runner (for tests). run(step) -> { status, output }. */
export function runSteps(steps, run, log = () => {}) {
  const rows = [];
  for (const step of steps) {
    const why = step.skip?.();
    if (why) {
      log(`WARNING: skipping ${step.name}: ${why}`);
      rows.push({ name: step.name, status: 'SKIP', note: why });
      continue;
    }
    const t = Date.now();
    const r = run(step);
    const ok = r.status === 0;
    rows.push({ name: step.name, status: ok ? 'PASS' : 'FAIL', note: `${((Date.now() - t) / 1000).toFixed(1)}s`, output: ok ? '' : r.output });
  }
  return rows;
}

function findPython() {
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

function main() {
  const steps = buildSteps({ e2e: process.argv.includes('--e2e'), pythonCmd: findPython() });
  const run = (s) => {
    console.log(`> ${s.name}`);
    const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: 'utf8', shell: win && s.cmd.endsWith('.cmd'), maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
  };
  const rows = runSteps(steps, run, (m) => console.warn(m));
  for (const r of rows.filter((x) => x.status === 'FAIL')) {
    console.log(`\n--- ${r.name}: last output ---\n${(r.output || '').trim().split('\n').slice(-25).join('\n')}`);
  }
  console.log(`\n${formatTable(rows)}`);
  const { failed, exitCode } = summarize(rows);
  console.log(failed ? `\nRELEASE CHECK FAILED: ${failed} step(s)` : '\nRELEASE CHECK PASSED');
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
