// Commit hygiene guard (D-129): no AI attribution in commit messages, no mojibake in tracked source.
// Usage:
//   node scripts/commit-guard.mjs --message <file>   check one commit message file (used by .githooks/commit-msg)
//   node scripts/commit-guard.mjs                    check every commit reachable from HEAD and all tracked source files
//   node scripts/commit-guard.mjs --history | --mojibake   run only one of the two
// Exit 1 on any finding. Prints commit hashes / file:line, never file contents beyond the matching line number.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Names of AI tools / vendors. A Co-Authored-By trailer naming one of these is rejected.
const AI_NAMES = /claude|anthropic|openai|chatgpt|\bgpt[-\s\d]|copilot|gemini|codex|cursor|devin|aider|\bllm\b|\bai\b|\bbot\b|haiku|sonnet|opus/i;

/** Lines of a commit message that attribute work to an AI. */
export function findAiTrailers(message) {
  const out = [];
  for (const line of message.split(/\r?\n/)) {
    if (/^\s*co-authored-by\s*:/i.test(line) && AI_NAMES.test(line)) out.push(line.trim());
    else if (/generated (with|by) \[?(claude|chatgpt|codex|copilot|gemini)/i.test(line)) out.push(line.trim());
  }
  return out;
}

// Mojibake: UTF-8 text decoded as Windows-1252. Built from code points so this file never contains the pattern itself.
// A-circumflex, a-circumflex + euro sign, A-tilde, each followed by a letter or symbol (not whitespace).
const MOJIBAKE = new RegExp('[\u00c2\u00c3][\u0080-\u00ff]|\u00e2\u20ac|\u00e2\u0080|\u00c3[A-Za-z]|\u00c2[A-Za-z\u00a0-\u00ff]', 'u');
export const MOJIBAKE_DIRS = ['app/', 'components/', 'lib/', 'ingest/', 'supabase/', 'scripts/', 'contract/'];
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|py|css|html|yml|yaml|toml)$/;
// Files that legitimately contain the pattern (they test for it).
export const MOJIBAKE_SKIP = ['lib/__tests__/companyLogic.test.ts']; // its regex literally lists the bad sequences

/** 1-based line numbers of lines with mojibake in a text. */
export function findMojibake(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => { if (MOJIBAKE.test(l)) out.push(i + 1); });
  return out;
}

export function inMojibakeScope(path) {
  return MOJIBAKE_DIRS.some((d) => path.startsWith(d)) && TEXT_EXT.test(path) && !MOJIBAKE_SKIP.includes(path) && !path.includes('node_modules/');
}

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Commits reachable from HEAD whose message has an AI trailer. Uses git log --grep first, then the precise matcher. */
export function historyFindings() {
  const r = git(['log', 'HEAD', '-i', '--grep=co-authored-by', '--grep=generated with', '--format=%H%x00%B%x01']);
  if (r.status !== 0) return [`git log failed: ${(r.stderr || '').trim().slice(0, 120)}`];
  const out = [];
  for (const rec of r.stdout.split('\x01')) {
    const [hash, body] = rec.replace(/^\s+/, '').split('\0');
    if (hash && body && findAiTrailers(body).length) out.push(`commit ${hash.slice(0, 10)} has an AI attribution trailer`);
  }
  return out;
}

export function mojibakeFindings() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) return ['git ls-files failed'];
  const out = [];
  for (const f of r.stdout.split('\0').filter(inMojibakeScope)) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const n of findMojibake(text)) out.push(`mojibake: ${f}:${n}`);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const mi = argv.indexOf('--message');
  if (mi >= 0) {
    const bad = findAiTrailers(readFileSync(argv[mi + 1], 'utf8'));
    if (bad.length) {
      console.error('commit rejected: AI attribution is not allowed in commit messages (CLAUDE.md, D-129). Remove:');
      for (const b of bad) console.error(`  ${b}`);
      process.exit(1);
    }
    return;
  }
  const only = argv.includes('--history') ? 'history' : argv.includes('--mojibake') ? 'mojibake' : 'both';
  const found = [...(only !== 'mojibake' ? historyFindings() : []), ...(only !== 'history' ? mojibakeFindings() : [])];
  if (found.length) {
    for (const f of found.slice(0, 40)) console.error(f);
    if (found.length > 40) console.error(`(+${found.length - 40} more)`);
    process.exit(1);
  }
  console.log('commit guard: no AI trailers in history, no mojibake in tracked source');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
