// Bank of England news and speeches (two RSS feeds, feed text only). Terms read 2026-11-11 (bankofengland.co.uk/legal):
// personal / internal non-commercial use only, anything else needs permission; so this source stays OFF until Drew accepts
// the risk (INTLCB_NONCOMMERCIAL_OK=1) and the card is the verbatim headline plus a link only (see intlcb.ts).
import { parseRss, type RssItem } from './fed.ts';

export const parseBoe = (xml: string): RssItem[] => parseRss(xml);
