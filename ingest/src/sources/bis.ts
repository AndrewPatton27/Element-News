// Bank for International Settlements media releases and central bankers' speeches (RSS 1.0 / RDF, feed text only). Terms read
// 2026-11-11 (bis.org/terms_conditions.htm): free use for non-commercial purposes, extracts of about 400 words with credit,
// automated use not addressed; so OFF until Drew accepts the risk (INTLCB_NONCOMMERCIAL_OK=1), headline plus link only.
// The feed has no pubDate: the date is dc:date. Items are <item rdf:about=...> blocks outside <channel>.
import { blocks, tagText } from '../html.ts';
import type { RssItem } from './fed.ts';

export function parseBis(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const it of blocks(xml, 'item')) {
    const title = tagText(it, 'title') ?? '';
    const link = tagText(it, 'link') ?? '';
    const t = Date.parse(tagText(it, 'dc:date') ?? '');
    if (!title || !link || !Number.isFinite(t)) continue;
    out.push({ title, link, description: '', category: null, pubDate: new Date(t).toISOString(), guid: link });
  }
  return out;
}
