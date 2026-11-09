// Security response headers for the Cloudflare Pages site (written to dist-pages/_headers by fix-pages-assets.mjs).
// Two policies:
//   Content-Security-Policy (enforced): only the directives that cannot break the app - no framing
//     (frame-ancestors 'none'), no <base> or plugin tricks, forms only to this origin.
//   Content-Security-Policy-Report-Only: the full script/connect policy, with sha256 hashes of every inline
//     <script> in index.html. Browsers log violations in the console without blocking. After a deploy shows no
//     violations, set ENFORCE_FULL_CSP = true (or pass { enforceFull: true }) to enforce it.
// Inputs: index.html text, the public Supabase URL. Outputs: the _headers file text. Pure; tested in
// scripts/__tests__/securityGate.test.mjs.
import { createHash } from 'node:crypto';

export const ENFORCE_FULL_CSP = false;

/** Inline <script> bodies (no src attribute) in an HTML document, in order. */
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/i.test(m[1])) out.push(m[2]);
  return out;
}

export function sha256Source(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The enforced, framing-only policy. */
export const BASE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

/** The full policy for this app. supabaseUrl is the public https://<ref>.supabase.co origin (or '' when absent). */
export function fullCsp({ scriptHashes = [], supabaseUrl = '' } = {}) {
  const sb = /^https:\/\/[\w.-]+$/.test(supabaseUrl) ? supabaseUrl : '';
  const connect = ["'self'", sb, sb && sb.replace(/^https:/, 'wss:'), 'https://cloudflareinsights.com'].filter(Boolean);
  return [
    "default-src 'self'",
    `script-src 'self' ${[...new Set(scriptHashes)].join(' ')} https://static.cloudflareinsights.com`.replace(/\s+/g, ' '),
    // react-native-web writes styles at runtime (style tags and style attributes).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    BASE_CSP,
  ].join('; ');
}

/** Headers every response gets. */
export function securityHeaderLines({ html = '', supabaseUrl = '', enforceFull = ENFORCE_FULL_CSP } = {}) {
  const full = fullCsp({ scriptHashes: inlineScripts(html).map(sha256Source), supabaseUrl });
  return [
    'Strict-Transport-Security: max-age=31536000; includeSubDomains',
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy: same-origin',
    enforceFull ? `Content-Security-Policy: ${full}` : `Content-Security-Policy: ${BASE_CSP}`,
    ...(enforceFull ? [] : [`Content-Security-Policy-Report-Only: ${full}`]),
  ];
}

/** The complete _headers file: security headers on every path, then cache rules (hashed assets immutable, HTML revalidated). */
export function buildHeadersFile(opts = {}) {
  const sec = securityHeaderLines(opts).map((l) => `  ${l}`).join('\n');
  const cache = (path, value) => `${path}\n  Cache-Control: ${value}\n`;
  return [
    `/*\n${sec}\n`,
    cache('/_expo/static/*', 'public, max-age=31536000, immutable'),
    cache('/assets/*', 'public, max-age=31536000, immutable'),
    cache('/', 'public, max-age=0, must-revalidate'),
    cache('/index.html', 'public, max-age=0, must-revalidate'),
  ].join('\n');
}

/** Parses a Cloudflare _headers file into [{ path, headers: Map(lowercase name -> value) }]. */
export function parseHeadersFile(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { cur = { path: raw.trim(), headers: new Map() }; rules.push(cur); continue; }
    const i = raw.indexOf(':');
    if (cur && i > 0) cur.headers.set(raw.slice(0, i).trim().toLowerCase(), raw.slice(i + 1).trim());
  }
  return rules;
}
