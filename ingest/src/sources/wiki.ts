// Wikipedia "In the news" (REST featured feed) -> RawItem, category world.
// Text is CC BY-SA 4.0: every card credits the article ("Adapted from Wikipedia ...") and the
// app links the license. The AI sees only the story sentence plus the first linked article's
// plain-text extract (both inside the JSON). No article page is downloaded and thumbnails or
// images in the payload are never read (rule 9). en.wikipedia.org is on the API host list only.
// Inputs: the REST featured-feed JSON. Outputs: RawItems (world, cc_by_sa) or skip reasons.

import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { decodeEntities } from '../html.ts';
import type { RawItem } from '../types.ts';

export interface WikiNewsItem {
  story: string;                       // HTML with a <!--Mon DD--> date comment
  links?: {
    title?: string;
    titles?: { normalized?: string };
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  }[];
}

/** Featured-feed URL for the UTC day `daysBack` days before `now` (0 = today). The `news` list may be missing for past days. */
export function wikiFeedUrl(now: Date, daysBack = 0): string {
  const d = new Date(now.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10).split('-');
  return config.wiki.featuredUrl.replace('{yyyy}', d[0]).replace('{mm}', d[1]).replace('{dd}', d[2]);
}

/**
 * Wikimedia User-Agent ("Element/0.1 (<contact>) node-fetch"), built at run time from the
 * contact in SEC_USER_AGENT (its email address, else the whole value). Null if there is no contact.
 */
export function wikimediaUserAgent(secUserAgent: string): string | null {
  const email = /[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/.exec(secUserAgent)?.[0];
  const contact = (email ?? secUserAgent).replace(/[()]/g, '').trim();
  return contact ? `${config.wiki.clientName} (${contact}) ${config.wiki.library}` : null;
}

/** Parses the feed. A missing `news` key means no items (not an error). */
export function parseWikiFeed(text: string): WikiNewsItem[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('wikipedia: response is not JSON'); }
  const news = (j as { news?: unknown })?.news;
  if (news === undefined) return [];
  if (!Array.isArray(news)) throw new Error('wikipedia: news is not a list');
  return news.filter((n): n is WikiNewsItem => !!n && typeof (n as WikiNewsItem).story === 'string');
}

/** Story HTML -> plain sentence (tags removed without adding spaces, entities decoded). */
export function storyText(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''))
    .replace(/\s*\([^()]*\b(?:pictured|shown)\)/gi, '')     // image captions like "(satellite image shown)": no images here
    .replace(/\s+/g, ' ').trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Date from the <!--Mon DD--> comment (year from `now`; a date in the future means last year), else now. */
export function storyDate(html: string, now: Date): string {
  const m = /<!--\s*([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s*-->/.exec(html);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mi < 0) return now.toISOString();
  let t = Date.UTC(now.getUTCFullYear(), mi, Number(m[2]));
  if (t > now.getTime() + 86_400_000) t = Date.UTC(now.getUTCFullYear() - 1, mi, Number(m[2]));
  return new Date(t).toISOString();
}

export type WikiSkipReason = 'no_link' | 'bad_url' | 'empty_story';

/** Story -> RawItem with the CC BY-SA credit (AI text = story + first link's extract), or a skip reason. */
export function wikiItemToItem(n: WikiNewsItem, now: Date): { item: RawItem } | { skip: WikiSkipReason } {
  const story = storyText(n.story);
  if (!story) return { skip: 'empty_story' };
  const link = n.links?.[0];
  const page = link?.content_urls?.desktop?.page;
  if (!link || !page) return { skip: 'no_link' };
  let url: URL;
  try { url = new URL(page); } catch { return { skip: 'bad_url' }; }
  if (url.protocol !== 'https:' || url.hostname !== 'en.wikipedia.org') return { skip: 'bad_url' };
  const title = (link.titles?.normalized ?? link.title ?? '').replace(/_/g, ' ').trim() || 'Wikipedia';
  const extract = (link.extract ?? '').replace(/\s+/g, ' ').trim();
  const attribution = `Adapted from Wikipedia ("${title}") · CC BY-SA 4.0`;
  return {
    item: {
      source: 'wiki_itn',
      external_id: createHash('sha1').update(`${story}\n${url}`).digest('hex').slice(0, 20),   // story text + link
      url: url.toString(),
      title: story.slice(0, 200),
      published_at: storyDate(n.story, now),
      license_class: 'cc_by_sa',
      category: config.wiki.category,
      event_type: config.wiki.eventType,
      tickers: [],
      source_name: 'Wikipedia',
      source_kind: 'news',
      doc_label: 'In the news',
      summary_text: (extract ? `${story}\n\n${extract}` : story).slice(0, config.wiki.aiTextMaxChars),   // the ONLY text the AI sees
      attribution,
    },
  };
}
