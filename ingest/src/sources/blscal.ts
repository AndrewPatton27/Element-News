// BLS release calendar (ICS) -> template "what is coming" cards for the big economic releases.
// Public domain (BLS copyright page, read 2026-11-10); the ICS file is the agency's own published schedule.
// Inputs: ICS text (https://www.bls.gov/schedule/news_release/bls.ics, page host www.bls.gov). Outputs: ScheduledRelease[] and PublishPayload.
// Times in the file are US Eastern ("TZID=US-Eastern"); we keep the local date and time as written and never convert them.
// One card per release, published up to config.agency.blscal.leadDays before it. The release name is the card's series, so a
// newer notice for the same report replaces the older one (core.supersede_series).

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, MONTHS } from './agencyData.ts';

export interface ScheduledRelease { name: string; date: string; time: string }   // date YYYY-MM-DD, time HH:MM (Eastern, 24 h)

const AGENCY = 'U.S. Bureau of Labor Statistics';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface MajorRelease { match: string; slug: string; title: string; what: string; url: string }
/** Releases that move markets or that everyday readers hear about. Everything else on the calendar is ignored. */
export const MAJOR_RELEASES: MajorRelease[] = [
  { match: 'Employment Situation', slug: 'JOBS', title: 'Jobs report', what: 'the monthly count of U.S. jobs added and the unemployment rate', url: 'https://www.bls.gov/news.release/empsit.nr0.htm' },
  { match: 'Consumer Price Index', slug: 'CPI', title: 'Consumer price index (inflation)', what: 'how fast everyday prices are rising', url: 'https://www.bls.gov/cpi/' },
  { match: 'Producer Price Index', slug: 'PPI', title: 'Producer price index', what: 'the prices businesses receive for what they sell', url: 'https://www.bls.gov/ppi/' },
  { match: 'Job Openings and Labor Turnover Survey', slug: 'JOLTS', title: 'Job openings report', what: 'how many jobs employers are trying to fill and how many people quit', url: 'https://www.bls.gov/jlt/' },
  { match: 'Employment Cost Index', slug: 'ECI', title: 'Employment cost index', what: 'how much employers pay for wages and benefits', url: 'https://www.bls.gov/eci/' },
  { match: 'Productivity and Costs', slug: 'PRODUCTIVITY', title: 'Productivity and costs report', what: 'how much each hour of work produces and what labor costs per unit of output', url: 'https://www.bls.gov/lpc/' },
  { match: 'U.S. Import and Export Price Indexes', slug: 'IMPORT_PRICES', title: 'Import and export price report', what: 'the prices of goods the U.S. buys from and sells to other countries', url: 'https://www.bls.gov/mxp/' },
  { match: 'Real Earnings', slug: 'REAL_EARNINGS', title: 'Real earnings report', what: 'what workers earn after inflation', url: 'https://www.bls.gov/news.release/realer.nr0.htm' },
];

const unfold = (ics: string): string[] => ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

/** ICS text -> scheduled releases (all of them, any year), oldest first. Events without a parseable start are dropped. */
export function parseBlsCalendar(ics: string): ScheduledRelease[] {
  const out: ScheduledRelease[] = [];
  let cur: { start?: string; name?: string } | null = null;
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      const m = cur?.start ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(cur.start) : null;
      if (m && cur?.name) out.push({ name: cur.name, date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` });
      cur = null;
    } else if (cur) {
      if (line.startsWith('DTSTART')) cur.start = line.slice(line.indexOf(':') + 1).trim();
      else if (line.startsWith('SUMMARY:')) cur.name = line.slice(8).replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** The major release a calendar row is, or null. The whole name must match: a regional or state CPI row does not. */
export function majorFor(name: string): MajorRelease | null {
  const n = name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  return MAJOR_RELEASES.find((m) => n === m.match.toLowerCase()) ?? null;
}

/** Eastern date (YYYY-MM-DD) of an instant. */
export function easternDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Major releases dated from today (Eastern) through today + leadDays, soonest first. */
export function upcomingReleases(rows: ScheduledRelease[], now: Date, leadDays = config.agency.blscal.leadDays): (ScheduledRelease & { major: MajorRelease })[] {
  const today = easternDate(now), last = addDays(today, leadDays);
  const out: (ScheduledRelease & { major: MajorRelease })[] = [];
  for (const r of rows) {
    const major = majorFor(r.name);
    if (major && r.date >= today && r.date <= last) out.push({ ...r, major });
  }
  return out;
}

const clock = (t: string): string => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'a.m.' : 'p.m.'} ET`;
};

export function blsCalendarCard(r: ScheduledRelease & { major: MajorRelease }, now: Date): PublishPayload {
  const [y, m, d] = r.date.split('-').map(Number);
  const day = DAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
  const when = `${day}, ${MONTHS[m - 1]} ${d}`;
  const at = clock(r.time);
  const headline = `${r.major.title} due ${when} at ${at}`;
  const body = `The Bureau of Labor Statistics is scheduled to publish its ${r.major.title.toLowerCase()} on ${when} at ${at}. It covers ${r.major.what}.`;
  return buildAgencyDataCard({
    dedupeKey: `BLSCAL_${r.major.slug}:${r.date}`, headline, body, category: 'economy', asOf: now.toISOString(),
    agencyName: AGENCY, agencyUrl: r.major.url, docLabel: 'BLS release schedule',
    attribution: config.agency.blscal.attribution,
    paragraphs: [
      body,
      'What this is: the release calendar the Bureau of Labor Statistics publishes for its main reports. BLS updates the calendar as needed, usually at least a week before a release.',
      'The dates come from the U.S. Bureau of Labor Statistics.',
    ],
    keyPoints: [`Release: ${r.name}`, `Date: ${when}`, `Time: ${at}`, `Source: ${AGENCY}`],
  });
}
