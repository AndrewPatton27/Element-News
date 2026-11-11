// Regulator press releases (CFTC, OCC, CFPB RSS) for the opt-in Crypto/regulation lane (M9c3) -> template cards, no AI.
// Public domain US government works (CFTC and OCC feed pages state no terms either way; the SEC press path treats the same kind
// of feed as 'company_filing' with the 10-word limit, so these cards copy only the headline, one title of at most 25 words,
// and no description text). Only titles that match config.agency.regpress.crypto publish. The lane tag is not set here: the app
// and core.topic_tags_of derive it from the headline words. Rule 5: the card links the agency's release page.
// Inputs: parseRss() items per feed. Outputs: PublishPayload | null. Key: REGPRESS_<AGENCY>:<yyyy-mm-dd>-<hash> would supersede,
// so the key has no series colon part that repeats: REGPRESS-<agency>-<guid hash>.

import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, shortDate } from './agencyData.ts';
import type { RssItem } from './fed.ts';

type Feed = (typeof config.agency.regpress.feeds)[number];

export const cryptoRe = (): RegExp => new RegExp(config.agency.regpress.crypto, 'i');

/** Items inside the age window, not dated in the future, matching the crypto pattern, newest first. */
export function selectRegPress(items: RssItem[], now: Date): RssItem[] {
  const c = config.agency.regpress;
  const re = cryptoRe();
  const cutoff = now.getTime() - c.maxAgeDays * 86_400_000;
  const seen = new Set<string>();
  return items
    .filter((i) => { const t = Date.parse(i.pubDate); return t >= cutoff && t <= now.getTime() + 3_600_000; })
    .filter((i) => re.test(i.title))
    .filter((i) => !seen.has(i.link) && seen.add(i.link))
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

export function regPressCard(i: RssItem, feed: Feed): PublishPayload | null {
  let url: URL;
  try { url = new URL(i.link); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const title = i.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > config.headlineMaxChars || title.split(' ').length > 25) return null;    // cannot be a headline; skipped, not cut
  const day = i.pubDate.slice(0, 10);
  const date = shortDate(day);
  const body = `The ${feed.agency} announced this on ${date}. It is one of the regulators setting rules for crypto and digital assets, which is why it is in the Crypto lane.`;
  const attribution = `Source: ${feed.agency}`;
  const hash = createHash('sha256').update(i.guid || i.link).digest('hex').slice(0, 10);
  return {
    ...buildAgencyDataCard({
      dedupeKey: `REGPRESS-${feed.id}-${hash}`, headline: title, body, category: 'policy', asOf: i.pubDate,
      agencyName: feed.agency, agencyUrl: url.toString(), docLabel: 'Press release', attribution,
      paragraphs: [
        body,
        `What this means: ${feed.short} decisions on crypto, stablecoins and digital-asset trading decide which products U.S. firms may offer and under what rules. The release has the details.`,
        `The release comes from the ${feed.agency}.`,
      ],
      keyPoints: [`Agency: ${feed.short}`, `Announced: ${date}`, 'Topic: crypto and digital assets', `Source: ${feed.agency}`],
    }),
    kind: 'summary',
    event_type: null,
  };
}
