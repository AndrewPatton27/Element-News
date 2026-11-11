// Census Economic Indicator Time Series API (eits) -> template data cards for retail sales and housing starts.
// DISABLED BY DEFAULT (config.agency.census.enabled = false): the API terms require a visible "not endorsed or
// certified by the Census Bureau" notice and are silent on keys and limits; Drew decides (sources doc, Q1).
// The same two numbers already reach the feed through FRED (RSAFS, HOUST).
// Response shape: JSON array of arrays, first row = column names. Cards dedupe per period (series + month), so a
// release that shows up again next month under the same link never repeats (R-37).
// Field and category names follow the Census eits docs and are UNVERIFIED against the live API (no key was used).
// Inputs: API JSON text. Outputs: CensusPoint[] and PublishPayload | null.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, fmt, MONTHS, toNum } from './agencyData.ts';

export type CensusSeries = 'retail' | 'housing';
export interface CensusPoint { time: string; value: number }   // time = YYYY-MM

const AGENCY = 'U.S. Census Bureau';

/** Request URL. The key (if any) is part of the query string and is never logged. */
export function censusUrl(series: CensusSeries, now: Date, apiKey: string | null): string {
  const c = config.agency.census;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - c.lookbackMonths, 1));
  const from = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const q = series === 'retail'
    ? `get=cell_value,error_data&time=from+${from}&category_code=44X72&data_type_code=SM&seasonally_adj=yes&for=us:*`
    : `get=cell_value,error_data&time=from+${from}&category_code=STARTS&data_type_code=TOTAL&seasonally_adj=yes&for=us:*`;
  return `${c.base}/${series === 'retail' ? 'marts' : 'resconst'}?${q}${apiKey ? `&key=${apiKey}` : ''}`;
}

/** JSON array-of-arrays -> points, oldest first. Rows with an error flag or no number are dropped. */
export function parseCensus(json: string): CensusPoint[] {
  const rows = JSON.parse(json) as string[][];
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const head = rows[0];
  const iv = head.indexOf('cell_value'), it = head.indexOf('time'), ie = head.indexOf('error_data');
  if (iv < 0 || it < 0) return [];
  const out: CensusPoint[] = [];
  for (const r of rows.slice(1)) {
    const value = toNum(r[iv]);
    if (value === null || !/^\d{4}-\d{2}$/.test(r[it] ?? '') || (ie >= 0 && /^yes$/i.test(r[ie] ?? ''))) continue;
    out.push({ time: r[it], value });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

export function censusCard(series: CensusSeries, pts: CensusPoint[]): PublishPayload | null {
  if (pts.length < 2) return null;
  const now = pts[pts.length - 1], prev = pts[pts.length - 2];
  const [y, m] = now.time.split('-').map(Number);
  const month = MONTHS[m - 1];
  const pct = (now.value / prev.value - 1) * 100;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'unchanged';
  const notice = config.agency.census.notice;
  const attribution = `${config.agency.census.attribution}. ${notice}`;
  const asOf = new Date(Date.UTC(y, m, 1)).toISOString();   // first day after the reference month
  const change = `${dir === 'unchanged' ? 'unchanged from' : `${dir} ${fmt(Math.abs(pct), 1)}% from`} the prior month`;
  const sign = `${pct >= 0 ? '+' : '-'}${fmt(Math.abs(pct), 1)}%`;
  let headline: string, body: string, url: string, doc: string, points: string[], measure: string;
  if (series === 'retail') {
    const billions = now.value / 1000;                       // eits marts values are millions of dollars
    headline = `Retail sales ${pct >= 0 ? 'rise' : 'fall'} ${fmt(Math.abs(pct), 1)}% in ${month}`;
    body = `U.S. retail and food services sales, what people spent in stores, online and at restaurants, were $${fmt(billions, 1)} billion in ${month} ${y} after seasonal adjustment, ${change}, the U.S. Census Bureau estimated.`;
    url = 'https://www.census.gov/retail/index.html'; doc = 'Advance Monthly Retail Trade';
    points = [`Retail and food services sales: $${fmt(billions, 1)} billion`, `Change: ${sign} from the prior month`, `Month: ${month} ${y}`];
    measure = 'What this number measures: consumer spending, the biggest part of the U.S. economy.';
  } else {
    headline = `Housing starts ${pct >= 0 ? 'rise to' : 'fall to'} ${fmt(now.value * 1000)} in ${month}`;
    body = `Builders began new homes at an annual rate of ${fmt(now.value * 1000)} in ${month} ${y}, ${change}, the U.S. Census Bureau estimated.`;
    url = 'https://www.census.gov/construction/nrc/index.html'; doc = 'New Residential Construction';
    points = [`Housing starts: ${fmt(now.value * 1000)} (annual rate)`, `Change: ${sign} from the prior month`, `Month: ${month} ${y}`];
    measure = 'What this number measures: how many new homes builders started, a sign of the housing market.';
  }
  return buildAgencyDataCard({
    dedupeKey: `CENSUS_${series.toUpperCase()}:${now.time}`, headline, body, category: 'economy', asOf, agencyName: AGENCY, agencyUrl: url, docLabel: doc, attribution,
    paragraphs: [body, measure, `The numbers come from the ${AGENCY}. ${notice}`],
    keyPoints: [...points, `Source: ${AGENCY}`],
  });
}
