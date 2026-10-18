// Federal Reserve press-release RSS -> RawItem, plus press-release page text.
// The RSS parser and merge helper are shared with bea.ts (and rewrite.ts).
// Inputs: RSS XML and press-release HTML. Outputs: RssItems, RawItems (policy) and plain text.

import { config } from '../config.ts';
import { blocks, htmlToText, tagText } from '../html.ts';
import type { RawItem } from '../types.ts';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  category: string | null;
  pubDate: string;                   // ISO
  guid: string;
}

/** Parses RSS <item>s (title, link, description, category, pubDate as ISO, guid); items without title or link are dropped. */
export function parseRss(xml: string): RssItem[] {
  return blocks(xml, 'item').map((it) => {
    const link = tagText(it, 'link') ?? '';
    return {
      title: tagText(it, 'title') ?? '',
      link,
      description: tagText(it, 'description') ?? '',
      category: tagText(it, 'category'),
      pubDate: new Date(tagText(it, 'pubDate') ?? '').toISOString(),
      guid: tagText(it, 'guid') ?? link,
    };
  }).filter((i) => i.title && i.link);
}

/** Fed feed item -> RawItem; monetary-policy releases get event_type 'fed', others null. */
export function fedItemToItem(i: RssItem): RawItem {
  const monetary = /monetary/i.test(i.category ?? '') || /\/monetary\d/.test(i.link);
  return {
    source: 'fed_rss',
    external_id: i.guid,
    url: i.link,
    title: i.title,
    published_at: i.pubDate,
    license_class: 'public_domain',
    category: 'policy',
    event_type: monetary ? 'fed' : null,
    tickers: [],
    source_name: 'Federal Reserve Board',
    source_kind: 'government',
    doc_label: 'Press release',
    summary_text: i.description && i.description !== i.title ? `${i.title}. ${i.description}` : i.title,
  };
}

/** Merge items from several feeds, unique by URL, newest first, within `maxAgeDays`. */
export function mergeFedItems(lists: RssItem[][], now: Date, maxAgeDays = 7): RssItem[] {
  const seen = new Map<string, RssItem>();
  for (const list of lists) for (const i of list) if (!seen.has(i.link)) seen.set(i.link, i);
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return [...seen.values()]
    .filter((i) => Date.parse(i.pubDate) >= cutoff)
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

/** Press-release page -> text of the article body (falls back to the whole page). */
export function fedPageText(html: string): string {
  const m = /<div[^>]+id="article"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html)
    ?? /<div[^>]+id="content"[^>]*>([\s\S]*)/i.exec(html);
  return htmlToText(m ? m[1] : html, config.sourceTextMaxChars);
}
