// European Central Bank press releases, speeches and interviews (one RSS feed, feed text only). Terms read 2026-11-11
// (ecb.europa.eu/services/disclaimer): reuse allowed if the ECB is credited and the text is shown accurately; no AI statement,
// so cards carry only the verbatim headline and a link (see intlcb.ts). Rule 8: the ECB is named on the card.
import { parseRss, type RssItem } from './fed.ts';

export const parseEcb = (xml: string): RssItem[] => parseRss(xml);
