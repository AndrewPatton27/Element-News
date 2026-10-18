// Tiny HTML/XML helpers (no dependencies). Good enough for SEC/Fed pages and feeds;
// not a general parser.
// Inputs: HTML/XML strings. Outputs: plain text, tag blocks, tag text and attribute values.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', reg: '®',
  copy: '©', sect: '§', middot: '·', bull: '•',
};

/** Decodes numeric (&#39; &#x27;) and common named HTML entities; unknown ones are left as is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Strips tags, scripts and styles; decodes entities; collapses whitespace; caps length. */
export function htmlToText(html: string, maxChars = Infinity): string {
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** All <tag>...</tag> blocks (non-nested). */
export function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

/** Text content of the first <tag>, CDATA unwrapped and entities decoded. */
export function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return decodeEntities(raw).trim();
}

/** Value of an attribute on the first matching tag, e.g. attr(xml, 'link', 'href'). */
export function attr(xml: string, tag: string, name: string, where?: (tagSource: string) => boolean): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  for (const m of xml.matchAll(re)) {
    if (where && !where(m[0])) continue;
    const a = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(m[0]);
    if (a) return decodeEntities(a[1]);
  }
  return null;
}
