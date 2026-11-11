// Annual headline figures (M9c3): Social Security cost-of-living adjustment, Medicare premiums, IRS retirement limits.
// ssa.gov, cms.gov and irs.gov are not on the rule-2 page list and have no API, so each figure is copied BY HAND from the agency's
// announcement into this list (facts, US government works) and a template card runs once after the announcement. The whole
// source is OFF unless ANNUAL_FIGURES_ENABLED=1 (terms: ssa.gov refused the fetch, irs.gov/cms.gov state no reuse terms).
// An entry is added only when its numbers were read from the agency page; "pending" ones stay out of the list until announced.
// Inputs: the clock. Outputs: AnnualFigure[] due, PublishPayload. Key: ANNUAL_<id>:<announced date>.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, shortDate } from './agencyData.ts';

export interface AnnualFigure {
  id: string;                       // series name, e.g. SSA_COLA
  announced: string;                // YYYY-MM-DD, the agency's announcement date
  headline: string;                 // under 90 characters
  body: string;
  agency: string;
  url: string;                      // the agency page the numbers were read from
  docLabel: string;
  category: 'personal-finance' | 'economy';
  why: string;
  keyPoints: string[];
}

/** Verified entries. SSA: figure from the SSA announcement of 2026-10-14 (3.6 percent, 2027), cross-checked against CNBC and Fox Business. */
export const ANNUAL_FIGURES: AnnualFigure[] = [
  {
    id: 'SSA_COLA', announced: '2026-10-14',
    headline: 'Social Security benefits rise 3.6% in 2027',
    body: 'The Social Security Administration announced a 3.6 percent cost-of-living adjustment for 2027, up from 2.8 percent for 2026. Payments with the increase start in January 2027.',
    agency: 'U.S. Social Security Administration', url: 'https://www.ssa.gov/news/en/mip/2026-10-01-f.html', docLabel: 'Cost-of-living adjustment',
    category: 'personal-finance',
    why: 'The adjustment is based on the consumer price index for urban wage earners (CPI-W) from the third quarter, and it applies to benefits for about 76 million people.',
    keyPoints: ['2027 adjustment: 3.6%', '2026 adjustment: 2.8%', 'First payments with the increase: January 2027', 'Source: U.S. Social Security Administration'],
  },
];

/** Entries announced within maxAgeDays and not in the future, newest first. */
export function annualDue(now: Date, list: AnnualFigure[] = ANNUAL_FIGURES): AnnualFigure[] {
  const oldest = now.getTime() - config.agency.annual.maxAgeDays * 86_400_000;
  return list.filter((f) => { const t = Date.parse(`${f.announced}T00:00:00Z`); return t >= oldest && t <= now.getTime(); })
    .sort((a, b) => b.announced.localeCompare(a.announced));
}

export function annualCard(f: AnnualFigure): PublishPayload {
  const asOf = new Date(`${f.announced}T16:00:00Z`).toISOString();
  return buildAgencyDataCard({
    dedupeKey: `ANNUAL_${f.id}:${f.announced}`, headline: f.headline, body: f.body, category: f.category, asOf,
    agencyName: f.agency, agencyUrl: f.url, docLabel: f.docLabel, attribution: `Source: ${f.agency}`,
    paragraphs: [f.body, `Why it matters: ${f.why}`, `The figures come from the ${f.agency}, announced ${shortDate(f.announced)}.`],
    keyPoints: f.keyPoints,
  });
}
