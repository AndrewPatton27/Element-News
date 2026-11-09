// Federal Reserve Board speeches and testimony RSS -> RawItem. Public domain (federalreserve.gov/disclaimer.htm,
// cite the Board). Board members only: Reserve Bank presidents' speeches are not on this feed and are outside the
// licence. The AI sees only the feed's title + description (no page download). Items dated in the future
// (embargo timestamps) are held back until their pubDate.
// Inputs: RssItems (parseRss in fed.ts). Outputs: RawItems (policy, event_type null: a speech is not a rate decision).

import { config } from '../config.ts';
import type { RawItem } from '../types.ts';
import type { RssItem } from './fed.ts';

/** Speeches already delivered (pubDate <= now) and within `maxAgeDays`, unique by link, newest first. */
export function selectFedSpeeches(lists: RssItem[][], now: Date, maxAgeDays: number = config.fedSpeechMaxAgeDays): RssItem[] {
  const seen = new Map<string, RssItem>();
  for (const l of lists) for (const i of l) if (!seen.has(i.link)) seen.set(i.link, i);
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return [...seen.values()]
    .filter((i) => /\/newsevents\/(speech|testimony)\//.test(i.link))
    .filter((i) => { const t = Date.parse(i.pubDate); return t >= cutoff && t <= now.getTime(); })
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

/** Speech feed item -> RawItem (title + short description is all the AI gets). */
export function fedSpeechToItem(i: RssItem): RawItem {
  const testimony = /\/testimony\//.test(i.link);
  return {
    source: 'fed_speech',
    external_id: i.guid,
    url: i.link,
    title: i.title,
    published_at: i.pubDate,
    license_class: 'public_domain',
    category: 'policy',
    event_type: null,
    tickers: [],
    source_name: 'Federal Reserve Board',
    source_kind: 'government',
    doc_label: testimony ? 'Testimony' : 'Speech',
    summary_text: i.description && i.description !== i.title ? `${i.title}. ${i.description}` : i.title,
    attribution: config.fedSpeechAttribution,
  };
}
