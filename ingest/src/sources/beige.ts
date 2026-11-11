// Fed Beige Book (M9c3) -> template cards: a preview a few days before each release and a release card with short
// quotes from the national summary. Public domain (federalreserve.gov/disclaimer.htm, read 2026-11-11: "in the public
// domain ... may be copied and distributed without permission", asks to cite the Board). The summary page host is
// www.federalreserve.gov (rule 2 domain). Copy limit: each quote is one sentence of at most 25 words (rule 6, Fed text).
// Inputs: the clock, the config release dates, the summary page HTML. Outputs: BeigeRelease | null, PublishPayload.
// Series key BEIGE_BOOK:<release date>: the release card replaces the preview (core.supersede_series), keyed by the same date
// plus a stage suffix so both can exist as separate rows (BEIGE_BOOK:2026-11-25 preview, BEIGE_BOOK:2026-11-25b release).

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, MONTHS_LONG } from './agencyData.ts';

const DAY = 86_400_000;
const AGENCY = 'Federal Reserve Board';
const day = (d: string): number => new Date(`${d}T00:00:00Z`).getTime();
const today = (now: Date): number => day(now.toISOString().slice(0, 10));
const longDate = (d: string): string => { const [, m, dd] = d.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${dd}`; };

export type BeigeStage = 'preview' | 'release';

/** The release that needs a card now: preview within the lead window, release card from the release day for releaseDays. */
export function beigeDue(now: Date): { date: string; stage: BeigeStage } | null {
  const c = config.agency.beige;
  const t = today(now);
  for (const date of [...c.releases].sort()) {
    const diff = (day(date) - t) / DAY;
    if (diff <= 0 && diff > -c.releaseDays) return { date, stage: 'release' };
    if (diff > 0 && diff <= c.previewLeadDays) return { date, stage: 'preview' };
  }
  return null;
}

export function beigeSummaryUrl(date: string): string {
  return config.agency.beige.summaryUrl.replace('{ym}', date.slice(0, 4) + date.slice(5, 7));
}

export interface BeigeSummary { activity: string | null; labor: string | null; prices: string | null }

const textLines = (html: string): string[] => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/?(p|h\d|div|li|tr|br)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8212;|&mdash;/g, ' - ')
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** First sentence of a paragraph when it is at most `maxWords` words, else null (a long sentence is never cut). */
export function firstSentence(paragraph: string | undefined, maxWords: number = config.agency.beige.maxQuoteWords): string | null {
  if (!paragraph) return null;
  const m = /^(.+?[a-z0-9)"][.!?])(\s|$)/.exec(paragraph);
  const s = (m?.[1] ?? '').trim();
  if (!s || s.split(/\s+/).length > maxWords) return null;
  return s;
}

/** Summary page HTML -> the first sentence under National Summary headings (null when the layout changed). */
export function parseBeigeSummary(html: string): BeigeSummary {
  const lines = textLines(html);
  const start = lines.findIndex((l) => l === 'National Summary');
  const part = start >= 0 ? lines.slice(start) : lines;
  const after = (heading: string): string | undefined => { const i = part.findIndex((l) => l === heading); return i >= 0 ? part[i + 1] : undefined; };
  return { activity: firstSentence(after('Overall Economic Activity')), labor: firstSentence(after('Labor Markets')), prices: firstSentence(after('Prices')) };
}

export function beigeCard(due: { date: string; stage: BeigeStage }, summary: BeigeSummary | null, now: Date): PublishPayload {
  const c = config.agency.beige;
  const when = longDate(due.date);
  if (due.stage === 'preview') {
    const headline = `Fed's Beige Book comes out ${when}`;
    const body = `The Federal Reserve publishes its Beige Book on ${when}: a report from all 12 Fed districts on jobs, prices and growth, based on talks with local businesses. It is released two weeks before each Fed policy meeting.`;
    return buildAgencyDataCard({
      dedupeKey: `BEIGE_BOOK:${due.date}`, headline, body, category: 'economy', asOf: now.toISOString(),
      agencyName: AGENCY, agencyUrl: c.pageUrl, docLabel: 'Beige Book', attribution: c.attribution,
      paragraphs: [body, 'What it is: the Beige Book is a plain-language read on the economy from the 12 regional Federal Reserve Banks. It has no numbers to forecast with, but it shows what firms are seeing before the official data arrives.', 'The date comes from the Federal Reserve Board.'],
      keyPoints: [`Release date: ${when}`, 'Covers: all 12 Fed districts', 'Topics: activity, jobs, prices', `Source: ${AGENCY}`],
    });
  }
  const quotes = [summary?.activity, summary?.labor, summary?.prices].filter((x): x is string => !!x);
  const headline = "Fed's new Beige Book is out, with reports from all 12 districts";
  const body = quotes.length
    ? `The Federal Reserve published its Beige Book on ${when}. On activity, it says: "${quotes[0]}"`
    : `The Federal Reserve published its Beige Book on ${when}: a report from all 12 Fed districts on jobs, prices and growth. The full text is on the Fed's site.`;
  const labels = ['Activity', 'Jobs', 'Prices'];
  const present = [summary?.activity, summary?.labor, summary?.prices];
  return buildAgencyDataCard({
    dedupeKey: `BEIGE_BOOK:${due.date}b`, headline, body, category: 'economy', asOf: new Date(`${due.date}T18:00:00Z`).toISOString(),
    agencyName: AGENCY, agencyUrl: beigeSummaryUrl(due.date), docLabel: 'Beige Book', attribution: c.attribution,
    paragraphs: [
      body,
      ...quotes.slice(1).map((q, i) => `On ${labels[present.indexOf(q)].toLowerCase()}, the report says: "${q}"`),
      'What it is: the Beige Book is a plain-language read on the economy from the 12 regional Federal Reserve Banks, published about two weeks before each policy meeting.',
    ],
    keyPoints: [`Released: ${when}`, 'Covers: all 12 Fed districts', ...present.map((q, i) => (q ? `${labels[i]}: quoted from the national summary` : null)).filter((x): x is string => !!x), `Source: ${AGENCY}`],
  });
}
