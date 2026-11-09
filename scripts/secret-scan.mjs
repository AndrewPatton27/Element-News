// Secret scan for what is about to be committed or pushed. Looks for key shapes (JWTs, Supabase secret keys,
// GitHub tokens, Google and Groq API keys, private keys, Healthchecks ping URLs) and for private paths
// (.env files, CLAUDE.md, context/, docs/) that must never be tracked. Prints file and line, never the value.
// Usage: node scripts/secret-scan.mjs --staged      files in the git index (before a commit)
//        node scripts/secret-scan.mjs               every tracked file (CI)
// Exit code 1 when something is found. The scan logic is exported for the tests.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATTERNS = [
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{40,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Groq API key', /\bgsk_[A-Za-z0-9]{40,}/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Healthchecks ping URL', /hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
];
export const FORBIDDEN_PATHS = [/(^|\/)\.env($|\.)(?!example$)/, /^CLAUDE\.md$/, /^context\//, /^docs\//];

/** Findings for one file's text: [{ line, what }]. */
export function scanText(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const [what, re] of PATTERNS) if (re.test(line)) out.push({ line: i + 1, what });
  });
  return out;
}

export function forbiddenPath(path) {
  return FORBIDDEN_PATHS.some((re) => re.test(path.replace(/\\/g, '/')));
}

function listFiles(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
}

function main() {
  const staged = process.argv.includes('--staged');
  const files = listFiles(staged);
  let bad = 0;
  for (const f of files) {
    if (forbiddenPath(f)) { console.log(`FORBIDDEN PATH ${f}`); bad++; continue; }
    let text;
    try {
      const buf = readFileSync(f);
      if (buf.includes(0)) continue;               // binary
      text = buf.toString('utf8');
    } catch { continue; }
    for (const hit of scanText(text)) { console.log(`${hit.what}: ${f}:${hit.line}`); bad++; }
  }
  console.log(`secret scan: ${files.length} files (${staged ? 'staged' : 'tracked'}), ${bad} finding${bad === 1 ? '' : 's'}`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
