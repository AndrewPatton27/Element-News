// Outbound request guard. Full pages are only ever downloaded from the hosts in
// config.pageHosts; data APIs only from config.apiHosts (+ the Supabase host).
// Every request goes through fetchAllowed, which re-checks each redirect hop.
// Inputs: a URL, its host kind ('page' | 'api') and fetch options (headers, cache TTL, fake fetch).
// Outputs: { status, text, url } of the final response, or an AllowlistError for a refused URL.
// Side effects: spaces requests (rate limit) and keeps an optional on-disk GET cache (config.cacheDir).

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';

/** Thrown when a URL (or a redirect hop) is outside the allowlist or malformed. */
export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

export type HostKind = 'page' | 'api';

function parse(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AllowlistError(`not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new AllowlistError(`only https is allowed: ${url}`);
  if (u.username || u.password) throw new AllowlistError(`credentials in URL are not allowed: ${u.hostname}`);
  if (u.port && u.port !== '443') throw new AllowlistError(`non-standard port is not allowed: ${u.host}`);
  return u;
}

/** Throws unless `url` is https on one of the three allowed page hosts (exact match). */
export function assertAllowedPage(url: string): URL {
  const u = parse(url);
  if (!(config.pageHosts as readonly string[]).includes(u.hostname.toLowerCase())) {
    throw new AllowlistError(`page host not allowed: ${u.hostname}`);
  }
  return u;
}

/** Throws unless `url` is https on an allowed data-API host (or the given extra hosts). */
export function assertAllowedApi(url: string, extraHosts: readonly string[] = []): URL {
  const u = parse(url);
  const hosts = [...config.apiHosts, ...extraHosts].map((h) => h.toLowerCase());
  if (!hosts.includes(u.hostname.toLowerCase())) {
    throw new AllowlistError(`API host not allowed: ${u.hostname}`);
  }
  return u;
}

/** Throws unless `url` is allowed for its kind: page hosts for 'page', API hosts (+ extraHosts) for 'api'. */
export function assertAllowed(url: string, kind: HostKind, extraHosts: readonly string[] = []): URL {
  return kind === 'page' ? assertAllowedPage(url) : assertAllowedApi(url, extraHosts);
}

// ---- rate limiter (simple spacing between requests) ------------------------------

let nextSlot = 0;
async function rateLimit(perSecond: number): Promise<void> {
  const gap = 1000 / perSecond;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ---- fetch -----------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchAllowedOptions {
  kind: HostKind;
  userAgent?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  extraHosts?: readonly string[];
  fetchImpl?: FetchLike;              // tests inject a fake
  cacheTtlMinutes?: number;           // > 0 enables the local file cache (GET only)
  cacheDir?: string;
  perSecond?: number;
}

/**
 * fetch() that refuses any URL (and any redirect target) outside the allowlist.
 * Redirects are followed manually so each hop is checked. Returns the body text.
 */
export async function fetchAllowed(url: string, opts: FetchAllowedOptions): Promise<{ status: number; text: string; url: string; retryAfterMs?: number }> {
  const fetchImpl = opts.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const method = opts.method ?? 'GET';
  assertAllowed(url, opts.kind, opts.extraHosts);

  const ttl = opts.cacheTtlMinutes ?? 0;
  const cacheFile = ttl > 0 && method === 'GET'
    ? join(opts.cacheDir ?? config.cacheDir, createHash('sha1').update(url).digest('hex') + '.txt')
    : null;
  if (cacheFile) {
    try {
      const st = await stat(cacheFile);
      if (Date.now() - st.mtimeMs < ttl * 60_000) {
        return { status: 200, text: await readFile(cacheFile, 'utf8'), url };
      }
    } catch { /* no cache entry */ }
  }

  let current = url;
  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    await rateLimit(opts.perSecond ?? config.maxRequestsPerSecond);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
    const res = await fetchImpl(current, {
      method,
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new AllowlistError(`redirect without location from ${new URL(current).hostname}`);
      const next = new URL(loc, current).toString();
      assertAllowed(next, opts.kind, opts.extraHosts);   // throws on a hop to another host
      current = next;
      continue;
    }
    const text = await res.text();
    if (cacheFile && res.ok) {
      await mkdir(opts.cacheDir ?? config.cacheDir, { recursive: true });
      await writeFile(cacheFile, text, 'utf8');
    }
    const hint = res.headers.get('retry-after');
    const retryAfterMs = hint ? (Number.isFinite(Number(hint)) ? Math.max(0, Number(hint) * 1000) : Math.max(0, Date.parse(hint) - Date.now())) : undefined;
    return { status: res.status, text, url: current, retryAfterMs };
  }
  throw new AllowlistError(`too many redirects starting at ${new URL(url).hostname}`);
}
