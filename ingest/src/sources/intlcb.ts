// Shared helpers for the foreign central-bank headline lane (M9 intl sources): ECB, Bank of England, BIS.
// Terms read 2026-11-11 (context/data-sources.md). None of the three is public domain, none states AI-summary reuse, so the
// card is a link-out style template card: the feed's headline (one title, verbatim, at most 25 words, 90 characters), a fixed
// sentence naming the institution, and a link to its own page. No feed description, no page download, no AI (rules 1, 2, 6).
// Inputs: RssItem[] per feed. Outputs: PublishPayload | null. Key: INTLCB-<feed id>-<guid hash> (kind summary, never superseded).

import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, shortDate } from './agencyData.ts';
import type { RssItem } from './fed.ts';

export type IntlFeed = (typeof config.agency.intlcb.feeds)[number];

/** Items inside the age window, not dated in the future, newest first, deduplicated by link. */
export function selectIntl(items: RssItem[], now: Date): RssItem[] {
  const cutoff = now.getTime() - config.agency.intlcb.maxAgeDays * 86_400_000;
  const seen = new Set<string>();
  return items
    .filter((i) => { const t = Date.parse(i.pubDate); return t >= cutoff && t <= now.getTime() + 3_600_000; })
    .filter((i) => !seen.has(i.link) && seen.add(i.link))
    .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
}

export function intlCard(i: RssItem, feed: IntlFeed): PublishPayload | null {
  let url: URL;
  try { url = new URL(i.link.replace(/([^:])\/\/+/g, '$1/')); } catch { return null; }   // the ECB feed has a double slash in its paths
  if (url.protocol !== 'https:' || !feed.hosts.includes(url.hostname)) return null;
  const title = i.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > config.headlineMaxChars || title.split(' ').length > 25) return null;   // cannot be a headline; skipped, not cut
  const date = shortDate(i.pubDate.slice(0, 10));
  const body = `${feed.agency} published this on ${date}. It is one of the world's major central banks or central-bank bodies, so its words can move interest rates and markets. The full text is on its site.`;
  const attribution = `Source: ${feed.agency}`;
  const hash = createHash('sha256').update(i.guid || i.link).digest('hex').slice(0, 10);
  const card = buildAgencyDataCard({
    dedupeKey: `INTLCB-${feed.id}-${hash}`, headline: title, body, category: 'economy', asOf: i.pubDate,
    agencyName: feed.agency, agencyUrl: url.toString(), docLabel: feed.docLabel, attribution,
    paragraphs: [
      body,
      `What this means: ${feed.short} decisions and speeches shape borrowing costs and currency moves outside the U.S. too, which feed back into global markets. The page has the details.`,
      `The release comes from ${feed.agency}.`,
    ],
    keyPoints: [`Institution: ${feed.short}`, `Published: ${date}`, `Source: ${feed.agency}`],
  });
  return { ...card, kind: 'summary', event_type: null, sources: card.sources.map((s) => ({ ...s, license_class: 'company_filing' as const })) };
}
