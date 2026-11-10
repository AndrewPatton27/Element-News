// Security headers for responses made by the Pages Function (functions/b/[id].ts). Cloudflare does not apply
// dist-pages/_headers to Function responses, so the Function sets them itself. This mirrors
// scripts/security-headers.mjs (which needs node:crypto, not available in Workers) with Web Crypto;
// lib/__tests__/sharePage.test.ts checks that both give the same headers for the same index.html.

import { inlineScripts } from './sharePage.ts';

export const ENFORCE_FULL_CSP = false; // keep equal to scripts/security-headers.mjs
export const BASE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

async function sha256Source(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}

export function fullCsp(scriptHashes: string[], supabaseUrl: string): string {
  const sb = /^https:\/\/[\w.-]+$/.test(supabaseUrl) ? supabaseUrl : '';
  const connect = ["'self'", sb, sb && sb.replace(/^https:/, 'wss:'), 'https://cloudflareinsights.com'].filter(Boolean);
  return [
    "default-src 'self'",
    `script-src 'self' ${[...new Set(scriptHashes)].join(' ')} https://static.cloudflareinsights.com`.replace(/\s+/g, ' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    BASE_CSP,
  ].join('; ');
}

/** [name, value] pairs, in the same order as the _headers file. */
export async function securityHeaders(html: string, supabaseUrl: string, enforceFull: boolean = ENFORCE_FULL_CSP): Promise<[string, string][]> {
  const full = fullCsp(await Promise.all(inlineScripts(html).map(sha256Source)), supabaseUrl);
  return [
    ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Content-Security-Policy', enforceFull ? full : BASE_CSP],
    ...(enforceFull ? [] : [['Content-Security-Policy-Report-Only', full] as [string, string]]),
  ];
}
