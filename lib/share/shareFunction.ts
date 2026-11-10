// What the Pages Function functions/b/[id].ts does, with its inputs passed in (tested in node with fakes):
//   1. the id must be a card UUID;
//   2. load index.html from the static assets;
//   3. ask Supabase for the card (api.card_by_id) with the PUBLISHABLE key only (rule 10), 1.5 s timeout;
//   4. answer index.html with the card's Open Graph / Twitter tags, the security headers and a short cache.
// On any problem it calls `fallback()` (the normal static answer: index.html, so the app's own /b/<id> route
// shows the card or a friendly "not found").

import { injectShareMeta, isCardId, isPublishableKey, parseSharedCard, shareMeta, supabaseFromShell } from './sharePage.ts';
import { securityHeaders } from './shareHeaders.ts';

export const SHARE_FETCH_TIMEOUT_MS = 1500;
/** Browsers revalidate; the edge may keep a card page for 5 minutes (headline edits show up quickly). */
export const SHARE_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, must-revalidate';

export interface ShareEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface ShareDeps {
  request: Request;
  id: unknown;
  env: ShareEnv;
  /** Fetches a static asset (env.ASSETS.fetch). */
  asset: (url: string) => Promise<Response>;
  /** The normal answer without this Function (context.next()). */
  fallback: () => Promise<Response>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function supabaseConfig(env: ShareEnv, html: string): { url: string; key: string } | null {
  const url = (env.SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
  if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && isPublishableKey(key)) return { url, key };
  return supabaseFromShell(html);
}

export async function handleShareRequest(d: ShareDeps): Promise<Response> {
  try {
    if (d.request.method !== 'GET' && d.request.method !== 'HEAD') return await d.fallback();
    if (!isCardId(d.id)) return await d.fallback();
    const page = new URL(d.request.url);
    const shell = await d.asset(new URL('/', page).toString());
    if (!shell.ok) return await d.fallback();
    const html = await shell.text();
    const sb = supabaseConfig(d.env, html);
    if (!sb) return await d.fallback();

    const doFetch = d.fetchFn ?? fetch;
    const res = await doFetch(`${sb.url}/rest/v1/rpc/card_by_id`, {
      method: 'POST',
      headers: { apikey: sb.key, Accept: 'application/json', 'Accept-Profile': 'api', 'Content-Type': 'application/json', 'Content-Profile': 'api' },
      body: JSON.stringify({ p_id: d.id }),
      signal: AbortSignal.timeout(d.timeoutMs ?? SHARE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return await d.fallback();
    const card = parseSharedCard(await res.json());
    if (!card || card.id.toLowerCase() !== d.id.toLowerCase()) return await d.fallback();

    const canonical = `${page.origin}/b/${encodeURIComponent(d.id.toLowerCase())}`;
    const out = injectShareMeta(html, shareMeta(card, canonical));
    if (!out) return await d.fallback();
    const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': SHARE_CACHE_CONTROL });
    for (const [name, value] of await securityHeaders(out, sb.url)) headers.set(name, value);
    return new Response(d.request.method === 'HEAD' ? null : out, { status: 200, headers });
  } catch {
    return d.fallback();
  }
}
