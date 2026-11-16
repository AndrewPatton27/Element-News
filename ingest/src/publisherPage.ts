// Publisher page text for NewsData link-out items (D-296). Fetches the article page once, checks the site's robots.txt,
// and returns plain article text for the summarizer. The text is never stored or shown; only the AI summary is.
// Inputs: an article URL and an injectable fetch. Outputs: article text, or '' when the page is not usable
// (robots disallow, error status, not HTML, paywall stub, too short). Never throws for a bad page.

import { fetchAllowed, type FetchLike } from './allowlist.ts';
import { config } from './config.ts';
import { decodeEntities, htmlToText } from './html.ts';

export interface PublisherPageOptions {
  /** Pipeline fetcher (Deps.fetchText with kind 'publisher'); throws on a non-2xx status. Default: fetchAllowed with the options below. */
  fetchText?: (url: string) => Promise<string>;
  fetchImpl?: FetchLike;
  userAgent?: string;
  log?: (line: string) => void;
}

const REGEX_SPECIALS = '.+?^$(){}|[]' + String.fromCharCode(92);
/** robots.txt pattern -> regex source: * matches anything, a trailing $ anchors the end, everything else is literal. */
function globToRegex(pattern: string): string {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let out = '';
  for (const ch of body) out += ch === '*' ? '.*' : REGEX_SPECIALS.includes(ch) ? String.fromCharCode(92) + ch : ch;
  return out + (anchored ? '$' : '');
}

/** True when robots.txt text allows `path` for our agent. Minimal parser: User-agent groups, Allow/Disallow, longest match wins. */
export function robotsAllows(robots: string, path: string, agent = 'elementnewsbot'): boolean {
  type Rule = { allow: boolean; pattern: string };
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      if (val) cur.rules.push({ allow: key === 'allow', pattern: val });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const r of rules) {
    const re = new RegExp('^' + globToRegex(r.pattern));
    if (re.test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

const BOILERPLATE_WORDS = 'cookie|consent|newsletter|subscribe|paywall|related|promo|advert|comment|share|social';
const BOILERPLATE_BLOCK = new RegExp('<[^>]+(?:class|id)=["\'][^"\']*(?:' + BOILERPLATE_WORDS + ')[^"\']*["\'][^>]*>[\s\S]*?</(?:div|section|aside|ul)>', 'gi');

/** Picks the readable article text out of an HTML page: <article> / <main> if present, else the whole body; boilerplate dropped. */
export function extractArticleText(html: string, maxChars = config.publisherPage.maxChars): string {
  const cleaned = html
    .replace(/<(nav|header|footer|aside|form|svg|iframe|figure|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(BOILERPLATE_BLOCK, ' ');
  const pick = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1] ?? cleaned;
  const paras = [...pick.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1])).filter((p) => p.split(/\s+/).length >= 8);
  // pages often repeat a paragraph (mobile and desktop copies): keep the first of each
  const text = paras.length >= 2 ? [...new Set(paras)].join(String.fromCharCode(10)) : htmlToText(pick);
  return decodeEntities(text).slice(0, maxChars);
}

/** Fetches and extracts one publisher page. Returns '' (and logs why) when no usable text is available. */
export async function fetchPublisherText(url: string, opts: PublisherPageOptions = {}): Promise<string> {
  const c = config.publisherPage;
  const log = opts.log ?? (() => {});
  const ua = opts.userAgent ?? c.userAgent;
  if (!c.enabled) return '';
  const get = opts.fetchText ?? (async (target: string): Promise<string> => {
    const r = await fetchAllowed(target, { kind: 'publisher', userAgent: ua, headers: { Accept: 'text/html,application/xhtml+xml' }, fetchImpl: opts.fetchImpl, timeoutMs: c.timeoutMs });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return r.text;
  });
  try {
    const u = new URL(url);
    try {
      const robots = await get(`${u.origin}/robots.txt`);
      if (!robotsAllows(robots, u.pathname + u.search)) { log(`publisher page: robots.txt disallows ${u.hostname}`); return ''; }
    } catch { /* no readable robots.txt: allowed, per the standard */ }
    const body = (await get(url)).slice(0, c.maxBytes);
    if (!/<(html|body|article|p)[ >]/i.test(body)) { log(`publisher page: not HTML from ${u.hostname}`); return ''; }
    const text = extractArticleText(body);
    if (text.length < c.minChars) { log(`publisher page: only ${text.length} chars from ${u.hostname} (paywall or empty shell)`); return ''; }
    return text;
  } catch (e) {
    log(`publisher page: ${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`);
    return '';
  }
}
