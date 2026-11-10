// FOMC meeting calendar -> one template data card per upcoming meeting (config.agency.fomc.meetings, copied
// from the Fed's calendar page). Minutes themselves come through the existing Fed press path (fed.ts, rule 2,
// public domain, 25-word copy limit); this file only announces the dates. No network, no AI.
// Inputs: the clock. Outputs: meetings in the lead window and a PublishPayload.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, MONTHS, shortDate } from './agencyData.ts';

const DAY = 86_400_000;
const AGENCY = 'Federal Reserve Board';
const day = (d: string): Date => new Date(`${d}T00:00:00Z`);

/** Meetings that start within the lead window (or are under way). */
export function upcomingMeetings(now: Date): [string, string, boolean][] {
  const f = config.agency.fomc;
  const today = day(now.toISOString().slice(0, 10)).getTime();
  return f.meetings.filter(([start, end]) => (day(end).getTime() - today) / DAY >= 0 && (day(start).getTime() - today) / DAY <= f.leadDays);
}

function range(start: string, end: string): string {
  const [, m1, d1] = start.split('-').map(Number);
  const [, m2, d2] = end.split('-').map(Number);
  return m1 === m2 ? `${MONTHS[m1 - 1]} ${d1}-${d2}` : `${MONTHS[m1 - 1]} ${d1} - ${MONTHS[m2 - 1]} ${d2}`;
}

export function fomcCard(m: [string, string, boolean], now: Date): PublishPayload {
  const [start, end, sep] = m;
  const f = config.agency.fomc;
  const minutes = new Date(day(end).getTime() + f.minutesDelayDays * DAY).toISOString().slice(0, 10);
  const when = range(start, end);
  const headline = `Fed policy meeting set for ${when}`;
  const body = `The Federal Open Market Committee meets ${when} to decide the federal funds rate target. The decision statement comes out on ${shortDate(end)}, `
    + `and the minutes follow about three weeks later, around ${shortDate(minutes)}.${sep ? ' This meeting also includes new economic projections.' : ''}`;
  return buildAgencyDataCard({
    dedupeKey: `fomc-calendar:${end}`, headline, body, category: 'policy', asOf: now.toISOString(),
    agencyName: AGENCY, agencyUrl: f.calendarUrl, docLabel: 'FOMC calendar',
    attribution: config.fedSpeechAttribution,
    paragraphs: [
      body,
      'What this means: the committee sets the short-term interest rate that many loan and savings rates follow.',
      'The dates come from the Federal Reserve Board. Later-year dates are tentative until confirmed at the meeting before them.',
    ],
    keyPoints: [`Meeting: ${when}`, `Decision day: ${shortDate(end)}`, `Minutes expected: about ${shortDate(minutes)}`, ...(sep ? ['Includes the Summary of Economic Projections'] : []), `Source: ${AGENCY}`],
  });
}
