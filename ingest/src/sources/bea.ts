// BEA news-release RSS -> RawItem. Public domain (BEA FAQ). The AI sees only the feed
// item's own text (title + description); BEA pages are never downloaded, and apps.bea.gov
// is on the API host list only (not the page list).
// Inputs: an RssItem (parsed by fed.ts parseRss). Outputs: a RawItem (economy / macro_release).

import { config } from '../config.ts';
import { htmlToText } from '../html.ts';
import type { RawItem } from '../types.ts';
import type { RssItem } from './fed.ts';

/** BEA feed item -> RawItem with the BEA credit line; summary text = title + plain description. */
export function beaItemToItem(i: RssItem): RawItem {
  const desc = htmlToText(i.description, config.sourceTextMaxChars);
  return {
    source: 'bea_rss',
    external_id: i.guid,
    url: i.link,
    title: i.title,
    published_at: i.pubDate,
    license_class: 'public_domain',
    category: 'economy',
    event_type: 'macro_release',
    tickers: [],
    source_name: 'U.S. Bureau of Economic Analysis',
    source_kind: 'government',
    doc_label: 'News release',
    summary_text: desc && desc !== i.title ? `${i.title}. ${desc}` : i.title,
    attribution: config.beaAttribution,
  };
}
