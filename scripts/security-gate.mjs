// Pre-release security gate. Read-only checks; prints PASS / WARN / FAIL / SKIP per check, never a secret value.
// Usage:
//   node scripts/security-gate.mjs                       private files, tracked secrets, local build (dist-pages)
//   node scripts/security-gate.mjs --require-build       same, but a missing dist-pages/ is a FAIL (production releases)
//   node scripts/security-gate.mjs --url https://element-news.pages.dev   also check the live response headers (one GET)
//   node scripts/security-gate.mjs --db                  also run scripts/security-gate.sql with
//                                                        `npx supabase db query --remote --read-only` and check grants
//   node scripts/security-gate.mjs --db-json out.json    check a saved JSON result of that query instead
//   --dir <folder>                                       build folder (default dist-pages)
// Exit 1 when any check FAILs. Wired into `npm run release:check -- --prod`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenPath, scanText } from './secret-scan.mjs';
import { findPrivate } from './private-files-check.mjs';
import { inlineScripts, parseHeadersFile, sha256Source } from './security-headers.mjs';

// ---- response headers --------------------------------------------------------------------------------------
export const REQUIRED_HEADERS = {
  'x-content-type-options': /^nosniff$/i,
  'referrer-policy': /^(strict-origin-when-cross-origin|strict-origin|no-referrer|same-origin)$/i,
  'permissions-policy': /camera=\(\)/,
  'strict-transport-security': /max-age=\d{7,}/,
};

/** Problems with one header set (Map or plain object of lowercase names) against the page's inline scripts. */
export function checkHeaderSet(headers, html = '') {
  const get = (n) => (headers instanceof Map ? headers.get(n) : headers[n]) ?? '';
  const out = [];
  for (const [name, re] of Object.entries(REQUIRED_HEADERS)) if (!re.test(get(name))) out.push(`missing or weak ${name}`);
  const csp = get('content-security-policy');
  if (!/frame-ancestors\s+'none'/.test(csp) && !/^deny$/i.test(get('x-frame-options'))) out.push('page can be framed (no frame-ancestors / X-Frame-Options)');
  const full = /script-src/.test(csp) ? csp : get('content-security-policy-report-only');
  if (!/script-src/.test(full)) out.push('no script-src policy (enforced or report-only)');
  else {
    const scriptSrc = (full.split(';').find((d) => d.trim().startsWith('script-src')) ?? '');
    if (/'unsafe-inline'|'unsafe-eval'|\*/.test(scriptSrc)) out.push("script-src allows 'unsafe-inline', 'unsafe-eval' or *");
    const missing = inlineScripts(html).filter((s) => !scriptSrc.includes(sha256Source(s)));
    if (missing.length) out.push(`${missing.length} inline script(s) not covered by a script-src hash`);
  }
  return out;
}

/** Local build: dist/_headers must give every path the security headers; hashed assets immutable; HTML revalidated. */
export function checkBuildHeaders(headersText, html) {
  const rules = parseHeadersFile(headersText);
  const all = rules.find((r) => r.path === '/*');
  if (!all) return ['_headers has no "/*" rule with the security headers'];
  const out = checkHeaderSet(all.headers, html);
  const cache = (p) => rules.find((r) => r.path === p)?.headers.get('cache-control') ?? '';
  if (!/immutable/.test(cache('/_expo/static/*'))) out.push('hashed bundles (/_expo/static/*) are not cached immutable');
  if (!/max-age=0/.test(cache('/'))) out.push('index HTML (/) is not revalidated (max-age=0)');
  return out;
}

// ---- bundle secrets ----------------------------------------------------------------------------------------
/** Names of server-side secrets whose VALUES must never appear in the web bundle. */
export const SERVER_SECRET_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'FRED_API_KEY', 'CRON_SECRET',
  'WATCHDOG_TOKEN', 'GITHUB_TOKEN', 'RESEND_API_KEY', 'NEWSDATA_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HEALTHCHECK_URL'];

/** Findings for one bundle file: key shapes plus exact server-secret values (only names are reported). */
export function scanBundleText(text, secretValues = {}) {
  const out = scanText(text).map((h) => `${h.what} at line ${h.line}`);
  for (const [name, value] of Object.entries(secretValues)) if (value && value.length >= 12 && text.includes(value)) out.push(`value of ${name}`);
  return out;
}

export function readSecretValues(env = process.env, envFile = '.env') {
  const vals = {};
  let file = '';
  try { file = readFileSync(envFile, 'utf8'); } catch { /* no .env */ }
  for (const name of SERVER_SECRET_NAMES) {
    const line = file.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    const v = (env[name] ?? (line ? line.slice(name.length + 1) : '')).split('#')[0].trim().replace(/^["']|["']$/g, '');
    if (v) vals[name] = v;
  }
  return vals;
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  walk(dir);
  return out;
}

// ---- database grants ---------------------------------------------------------------------------------------
/** api functions anon may execute (public read RPCs and the token-gated brief/ops calls). */
export const ANON_API = ['card_by_id', 'confirm_brief', 'daily_brief', 'feed', 'feed_status', 'following_feed', 'number_trends', 'ops_status',
  'related_cards', 'search', 'sources', 'subscribe_brief', 'top_stories', 'unsubscribe_brief', 'update_brief_subscription', 'weekly_brief'];
/** api functions only signed-in users may execute (in addition to ANON_API). */
export const AUTH_API = ['delete_account', 'delete_my_data', 'feed_for_you', 'get_prefs', 'my_brief_subscriptions', 'my_categories',
  'set_prefs', 'track', 'unsubscribe_my_brief', 'update_my_brief_time'];

/** rows: output of scripts/security-gate.sql. Returns { fail: [...], warn: [...] } with object names only. */
export function checkGrants(rows) {
  const fail = [], warn = [];
  const fq = (r) => `${r.s}.${r.name}(${r.args ?? ''})`;
  for (const r of rows) {
    if (r.k === 'fn') {
      if (r.secdef && !/search_path=/.test(r.cfg ?? '')) fail.push(`SECURITY DEFINER without pinned search_path: ${fq(r)}`);
      if (r.s === 'api') {
        if (r.anon && !ANON_API.includes(r.name)) fail.push(`anon can execute service-only ${fq(r)}`);
        if (r.authd && !ANON_API.includes(r.name) && !AUTH_API.includes(r.name)) fail.push(`authenticated can execute service-only ${fq(r)}`);
        if (!r.anon && ANON_API.includes(r.name)) warn.push(`public RPC not executable by anon: ${fq(r)}`);
      } else if (['core', 'ingest', 'public', 'vault'].includes(r.s) && (r.anon || r.authd)) {
        fail.push(`client role can execute ${fq(r)}`);
      } else if (r.s === 'net' && (r.anon || r.authd)) {
        warn.push(`client role holds EXECUTE on ${fq(r)} (safe only while the net schema is not exposed; fixed by 20261118000000_security_fixes.sql)`);
      }
    } else if (r.k === 'rel') {
      if (['core', 'ingest', 'public'].includes(r.s) && (r.anon || r.authd)) fail.push(`client role has table privileges on ${r.s}.${r.name}`);
      if (['core', 'ingest'].includes(r.s) && r.args === 'r' && r.rls === false) fail.push(`row level security off on ${r.s}.${r.name}`);
    } else if (r.k === 'schema') {
      if (['core', 'ingest', 'vault', 'cron'].includes(r.s) && (r.anon || r.authd)) fail.push(`client role has USAGE on schema ${r.s}`);
    }
  }
  return { fail, warn };
}

/** Parses `supabase db query --output-format json` output (a status line may precede the JSON). */
export function parseDbOutput(text) {
  const i = text.indexOf('{');
  const j = JSON.parse(i >= 0 ? text.slice(i) : text);
  if (!Array.isArray(j.rows)) throw new Error(j.error?.message ? `query failed: ${j.error.message}` : 'no rows in query output');
  return j.rows;
}

// ---- runner ------------------------------------------------------------------------------------------------
export function formatRows(rows) {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.note}`).join('\n');
}

export function exitCode(rows) { return rows.some((r) => r.status === 'FAIL') ? 1 : 0; }

const row = (name, problems, okNote, warnings = []) => (problems.length
  ? { name, status: 'FAIL', note: problems.slice(0, 12).join('; ') + (problems.length > 12 ? ` (+${problems.length - 12} more)` : '') }
  : warnings.length ? { name, status: 'WARN', note: warnings.slice(0, 6).join('; ') + (warnings.length > 6 ? ` (+${warnings.length - 6} more)` : '') }
    : { name, status: 'PASS', note: okNote });

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const rows = [];
  const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (tracked.status !== 0) rows.push({ name: 'private files', status: 'FAIL', note: 'git ls-files failed' });
  else {
    const files = tracked.stdout.split('\0').filter(Boolean);
    const priv = [...new Set([...findPrivate(files), ...files.filter(forbiddenPath)])];
    rows.push(row('private files not tracked', priv.map((p) => `tracked: ${p}`), `${files.length} tracked files checked`));
    const hits = [];
    for (const f of files) {
      let buf; try { buf = readFileSync(f); } catch { continue; }
      if (buf.includes(0)) continue;
      for (const h of scanText(buf.toString('utf8'))) hits.push(`${h.what}: ${f}:${h.line}`);
    }
    rows.push(row('no secrets in tracked files', hits, 'no key shapes found'));
  }

  const dir = arg('--dir') ?? 'dist-pages';
  if (!existsSync(join(dir, 'index.html'))) {
    const why = `${dir}/index.html not found (run npm run export:web first)`;
    rows.push({ name: 'bundle secrets', status: process.argv.includes('--require-build') ? 'FAIL' : 'SKIP', note: why });
    rows.push({ name: 'build headers', status: process.argv.includes('--require-build') ? 'FAIL' : 'SKIP', note: why });
  } else {
    const secrets = readSecretValues();
    const found = [];
    for (const f of listFiles(dir)) {
      if (!/\.(js|html|json|css|map|txt|_headers)$|_headers$/.test(f)) continue;
      for (const h of scanBundleText(readFileSync(f, 'utf8'), secrets)) found.push(`${h} in ${relative(dir, f)}`);
    }
    rows.push(row('bundle secrets', found, `no key shapes or server secret values (${Object.keys(secrets).length} server values compared)`));
    const headersPath = join(dir, '_headers');
    rows.push(existsSync(headersPath)
      ? row('build headers', checkBuildHeaders(readFileSync(headersPath, 'utf8'), readFileSync(join(dir, 'index.html'), 'utf8')), `${dir}/_headers OK`)
      : { name: 'build headers', status: 'FAIL', note: `${dir}/_headers missing` });
  }

  const url = arg('--url');
  if (url) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      const html = await r.text();
      const h = new Map([...r.headers].map(([k, v]) => [k.toLowerCase(), v]));
      rows.push(row('live headers', r.ok ? checkHeaderSet(h, html) : [`HTTP ${r.status}`], `${new URL(url).host} OK`));
    } catch (e) { rows.push({ name: 'live headers', status: 'FAIL', note: `request failed: ${e.name}` }); }
  }

  const dbJson = arg('--db-json');
  if (dbJson || process.argv.includes('--db')) {
    try {
      let text;
      if (dbJson) text = readFileSync(dbJson, 'utf8');
      else {
        const win = process.platform === 'win32';
        const q = spawnSync(win ? 'npx.cmd' : 'npx', ['supabase', 'db', 'query', '--remote', '--read-only', '-f', 'scripts/security-gate.sql', '--output-format', 'json'],
          { encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 });
        if (q.status !== 0) throw new Error(`supabase db query exited ${q.status}`);
        text = q.stdout;
      }
      const { fail, warn } = checkGrants(parseDbOutput(text));
      rows.push(row('database grants', fail, 'anon/authenticated grants match the allowlists', warn));
    } catch (e) { rows.push({ name: 'database grants', status: 'FAIL', note: e.message.slice(0, 200) }); }
  }

  console.log(formatRows(rows));
  const code = exitCode(rows);
  console.log(code ? '\nSECURITY GATE FAILED' : '\nSECURITY GATE PASSED');
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
