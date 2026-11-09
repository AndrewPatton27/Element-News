// SEC press-release RSS -> RawItem. SEC publications are US government works, but the feed page states no
// reuse terms (partly verified), so the stricter 10-word copy limit applies (license class 'company_filing').
// The AI sees only the feed's title + (truncated) description; no page download. Cite the SEC.
// Inputs: RssItems (parseRss in fed.ts). Outputs: RawItems (category markets, event_type null).

import { config } from '../config.ts';
import { htmlToText } from '../html.ts';
import type { RawItem } from '../types.ts';
import type { RssItem } from './fed.ts';

/** Press releases within `maxAgeDays` that are not dated in the future, unique by link, newest first. */
export function selectSecPress(list: RssItem[], now: Date, maxAgeDays: number = config.secPressMaxAgeDays): RssItem[] {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const seen = new Set<string>();
  return list
    .filter((i) => { const t = Date.parse(i.pubDate); return t >= cutoff && t <= now.getTime(); })
    .filter((i) => !seen.has(i.link) && seen.add(i.link))
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

export function secPressToItem(i: RssItem): RawItem {
  const desc = htmlToText(i.description, config.sourceTextMaxChars);
  return {
    source: 'sec_press',
    external_id: i.guid,
    url: i.link,
    title: i.title,
    published_at: i.pubDate,
    license_class: 'company_filing',
    category: 'markets',
    event_type: null,
    tickers: [],
    source_name: 'U.S. Securities and Exchange Commission',
    source_kind: 'government',
    doc_label: 'Press release',
    summary_text: desc && desc !== i.title ? `${i.title}. ${desc}` : i.title,
    attribution: config.secPressAttribution,
  };
}
