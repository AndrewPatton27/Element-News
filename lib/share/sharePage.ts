// The shared-card page /b/<id>: pure helpers used by the app route (app/b/[id].tsx) and by the Cloudflare
// Pages Function (functions/b/[id].ts) that puts per-card Open Graph / Twitter tags into index.html.
// No React, no Node built-ins: it runs in node --test and in the Workers runtime.
//
// Rules: the title is the card's headline as written (capped at 200 characters), the description is the
// first sentence of the blurb; no image tags ever (rule 9); every interpolated value is HTML-escaped; inline
// <script> elements are never touched, so the CSP hashes computed from index.html at build time still match.

import type { BlurbCard } from '../../contract/types.ts';
import { isBlurbCard, textOnlyData } from '../shared/types.ts';

/** Card ids are UUIDs (core.blurbs.id). */
export const CARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHARE_TITLE_MAX = 200;
export const SHARE_DESCRIPTION_MAX = 300;
export const SITE_NAME = 'Element';

export function isCardId(id: unknown): id is string {
  return typeof id === 'string' && CARD_ID_RE.test(id);
}

/** Escapes text for an HTML text node or a double- or single-quoted attribute. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

/** Collapses whitespace and drops control characters (they would only confuse link previews). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cap(text: string, max: number): string {
  const chars = Array.from(text); // never split a surrogate pair
  return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + '\u2026';
}

/** The first sentence of a blurb (ends at . ! or ? followed by a space and a capital, digit or quote). */
export function firstSentence(body: string | null | undefined): string {
  const text = clean(body ?? '');
  if (!text) return '';
  const m = /^(.+?[.!?]["'\u201d\u2019)]?)\s+(?=["'\u201c\u2018(]?[A-Z0-9])/.exec(text);
  return cap(m ? m[1] : text, SHARE_DESCRIPTION_MAX);
}

export interface ShareMeta {
  title: string;
  description: string;
  url: string;
}

/** Title, description and canonical URL for a card's share page (plain text, not yet escaped). */
export function shareMeta(card: Pick<BlurbCard, 'headline' | 'body'>, url: string): ShareMeta {
  return {
    title: cap(clean(card.headline), SHARE_TITLE_MAX),
    description: firstSentence(card.body),
    url,
  };
}

/** The meta tags for <head>. Escaped; no og:image / twitter:image (rule 9). */
export function shareMetaTags(meta: ShareMeta): string {
  const tag = (attr: 'name' | 'property', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  return [
    tag('property', 'og:type', 'article'),
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:title', meta.title),
    meta.description ? tag('property', 'og:description', meta.description) : '',
    tag('property', 'og:url', meta.url),
    tag('name', 'twitter:card', 'summary'),
    tag('name', 'twitter:title', meta.title),
    meta.description ? tag('name', 'twitter:description', meta.description) : '',
    meta.description ? tag('name', 'description', meta.description) : '',
    `<link rel="canonical" href="${escapeHtml(meta.url)}" />`,
  ].filter(Boolean).join('');
}

// Tags in the shell this page replaces: the <title>, and any description / Open Graph / Twitter / canonical
// tag already there (so no duplicates).
const OLD_META = /<meta\s+(?:name|property)=["'](?:description|og:[\w:]+|twitter:[\w:]+)["'][^>]*>|<link\s+rel=["']canonical["'][^>]*>/gi;

/**
 * index.html with the card's tags. Only the <head> before the first <script> is edited, and only title,
 * meta and link tags: inline scripts stay byte for byte. Returns null when the shell has no <head>.
 */
export function injectShareMeta(html: string, meta: ShareMeta): string | null {
  const open = /<head[^>]*>/i.exec(html);
  const close = html.search(/<\/head>/i);
  if (!open || close < 0 || close < open.index) return null;
  const headStart = open.index + open[0].length;
  const head = html.slice(headStart, close);
  // Edit only the head; scripts inside it are copied unchanged by splitting around them.
  const parts = head.split(/(<script\b[\s\S]*?<\/script>)/i);
  let titled = false;
  const edited = parts.map((part, i) => {
    if (i % 2 === 1) return part; // a <script> element: untouched
    let p = part.replace(OLD_META, '');
    p = p.replace(/<title[^>]*>[\s\S]*?<\/title>/i, () => {
      if (titled) return '';
      titled = true;
      return `<title>${escapeHtml(meta.title)} \u00b7 ${SITE_NAME}</title>`;
    });
    return p;
  }).join('');
  const tags = (titled ? '' : `<title>${escapeHtml(meta.title)} \u00b7 ${SITE_NAME}</title>`) + shareMetaTags(meta);
  return html.slice(0, headStart) + edited + tags + html.slice(close);
}

/** Inline <script> bodies (no src attribute) in order: the same rule as scripts/security-headers.mjs. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/i.test(m[1])) out.push(m[2]);
  return out;
}

/** A card from api.card_by_id, or null when the answer is not a card. */
export function parseSharedCard(x: unknown): BlurbCard | null {
  return isBlurbCard(x) ? textOnlyData(x) : null;
}

/** True for a key that is safe to use from a public page: never a secret / service-role key (rule 10). */
export function isPublishableKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length < 20 || key.length > 4096 || /\s/.test(key)) return false;
  if (/^sb_secret_/i.test(key)) return false;
  if (/^sb_publishable_/i.test(key)) return true;
  // Legacy anon keys are JWTs: accept only role "anon".
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
    return (JSON.parse(json) as { role?: unknown }).role === 'anon';
  } catch {
    return false;
  }
}

/** The Supabase URL and publishable key the built index.html already carries (its early-load script). */
export function supabaseFromShell(html: string): { url: string; key: string } | null {
  const url = /var u="(https:\/\/[a-z0-9-]+\.supabase\.co)"/i.exec(html)?.[1];
  const key = /"apikey":"([^"\\]+)"/.exec(html)?.[1];
  return url && key && isPublishableKey(key) ? { url, key } : null;
}
