// EIA open data API v2 -> template data cards: weekly petroleum stocks, weekly natural gas storage and
// (off by default) weekly retail gasoline. Public domain (EIA copyright page); credit line names the agency.
// Inputs: API JSON text (response.data rows with period, series, value as strings). Outputs: PublishPayload | null.
// The API key goes in the URL query (EIA requires it there) and is never logged: errors print the host only.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, fmt, shortDate, toNum } from './agencyData.ts';

export interface EiaRow { period: string; series: string; value: number }

const AGENCY = 'U.S. Energy Information Administration';

/** EIA JSON -> rows with a numeric value, newest period first. Bad rows are dropped. */
export function parseEia(json: string): EiaRow[] {
  const doc = JSON.parse(json) as { response?: { data?: Record<string, unknown>[] } };
  const rows: EiaRow[] = [];
  for (const r of doc.response?.data ?? []) {
    const value = toNum(r.value);
    if (typeof r.period !== 'string' || typeof r.series !== 'string' || value === null) continue;
    rows.push({ period: r.period.slice(0, 10), series: r.series, value });
  }
  return rows.sort((a, b) => b.period.localeCompare(a.period));
}

/** Request URL for a weekly route and series ids. The key is part of the URL (EIA's rule); callers never log it. */
export function eiaUrl(route: string, seriesIds: string[], apiKey: string, length: number): string {
  const q = new URLSearchParams();
  q.set('api_key', apiKey);
  q.set('frequency', 'weekly');
  q.append('data[]', 'value');
  for (const s of seriesIds) q.append('facets[series][]', s);
  q.set('sort[0][column]', 'period');
  q.set('sort[0][direction]', 'desc');
  q.set('offset', '0');
  q.set('length', String(length));
  return `${config.agency.eia.base}${route}?${q.toString()}`;
}

const latestTwo = (rows: EiaRow[], series: string): [EiaRow, EiaRow | null] | null => {
  const r = rows.filter((x) => x.series === series);
  return r.length ? [r[0], r[1] ?? null] : null;
};
const signed = (n: number, d: number): string => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n), d)}`;
const at = (period: string): string => new Date(`${period}T12:00:00Z`).toISOString();

/** Weekly petroleum status: one card for the newest week (crude headline, gasoline and distillate in the detail). */
export function petroleumCard(rows: EiaRow[]): PublishPayload | null {
  const s = config.agency.eia.petroleum.series;
  const crude = latestTwo(rows, s.crude);
  if (!crude || !crude[1]) return null;
  const [now, prev] = crude;
  const mb = (v: number) => v / 1000;                         // thousand barrels -> million barrels
  const change = mb(now.value - prev!.value);
  const week = shortDate(now.period);
  const headline = change === 0
    ? `U.S. crude oil inventories hold at ${fmt(mb(now.value), 1)} million barrels in the week ending ${week}`
    : `U.S. crude oil inventories ${change > 0 ? 'rise' : 'fall'} ${fmt(Math.abs(change), 1)} million barrels in the week ending ${week}`;
  const body = `Commercial crude oil inventories, the oil held in U.S. storage, were ${fmt(mb(now.value), 1)} million barrels in the week ending ${week}, `
    + (change === 0 ? 'unchanged from' : `${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change), 1)} million from`) + ' the prior week, the U.S. Energy Information Administration reported.';
  const extra: string[] = [];
  for (const [label, id] of [['Motor gasoline', s.gasoline], ['Distillate fuel (diesel and heating oil)', s.distillate]] as const) {
    const g = latestTwo(rows, id);
    if (g && g[1] && g[0].period === now.period) extra.push(`${label} inventories: ${fmt(mb(g[0].value), 1)} million barrels (${signed(mb(g[0].value - g[1].value), 1)} million from the prior week)`);
  }
  return buildAgencyDataCard({
    dedupeKey: `EIA_PETROLEUM:${now.period}`, headline, body, category: 'energy', asOf: at(now.period),
    agencyName: AGENCY, agencyUrl: 'https://www.eia.gov/petroleum/supply/weekly/', docLabel: 'Weekly Petroleum Status Report',
    attribution: config.agency.eia.attribution,
    paragraphs: [
      body,
      'What this number measures: how much crude oil sits in storage tanks across the U.S., a guide to whether supply is running ahead of or behind demand.',
      'The numbers come from the U.S. Energy Information Administration.',
    ],
    keyPoints: [`Crude oil inventories: ${fmt(mb(now.value), 1)} million barrels`, `Change: ${signed(change, 1)} million barrels from the prior week`, ...extra, `Week ending: ${week}`, `Source: ${AGENCY}`],
  });
}

/** Weekly natural gas storage (Lower 48 working gas, Bcf). */
export function gasStorageCard(rows: EiaRow[]): PublishPayload | null {
  const two = latestTwo(rows, config.agency.eia.gasStorage.series);
  if (!two || !two[1]) return null;
  const [now, prev] = two;
  const change = now.value - prev!.value;
  const week = shortDate(now.period);
  const headline = change === 0
    ? `U.S. natural gas storage holds at ${fmt(now.value)} Bcf in the week ending ${week}`
    : `U.S. natural gas storage ${change > 0 ? 'rises' : 'falls'} ${fmt(Math.abs(change))} Bcf in the week ending ${week}`;
  const body = `Natural gas held in underground storage in the Lower 48 states was ${fmt(now.value)} billion cubic feet (Bcf) in the week ending ${week}, `
    + (change === 0 ? 'unchanged from' : `${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change))} Bcf from`) + ' the prior week, the U.S. Energy Information Administration reported.';
  return buildAgencyDataCard({
    dedupeKey: `EIA_GAS_STORAGE:${now.period}`, headline, body, category: 'energy', asOf: at(now.period),
    agencyName: AGENCY, agencyUrl: 'https://www.eia.gov/naturalgas/weekly/', docLabel: 'Weekly Natural Gas Storage Report',
    attribution: config.agency.eia.attribution,
    paragraphs: [
      body,
      'What this number measures: how much natural gas utilities and producers have stored for winter heating and power use.',
      'The numbers come from the U.S. Energy Information Administration.',
    ],
    keyPoints: [`Working gas in storage: ${fmt(now.value)} Bcf`, `Change: ${signed(change, 0)} Bcf from the prior week`, `Week ending: ${week}`, `Source: ${AGENCY}`],
  });
}

/** Weekly retail regular gasoline price (off by default: FRED GASREGW carries the same EIA number). */
export function gasolineCard(rows: EiaRow[]): PublishPayload | null {
  const two = latestTwo(rows, config.agency.eia.gasoline.series);
  if (!two || !two[1]) return null;
  const [now, prev] = two;
  const change = now.value - prev!.value;
  const week = shortDate(now.period);
  const headline = change === 0 ? `U.S. regular gas price holds at $${fmt(now.value, 2)} a gallon in the week of ${week}`
    : `U.S. regular gas price ${change > 0 ? 'rises' : 'falls'} to $${fmt(now.value, 2)} a gallon in the week of ${week}`;
  const body = `The average U.S. retail price of regular gasoline was $${fmt(now.value, 2)} a gallon in the week of ${week}, `
    + (change === 0 ? 'unchanged from' : `${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change) * 100, 0)} cents from`) + ' the prior week, the U.S. Energy Information Administration reported.';
  return buildAgencyDataCard({
    dedupeKey: `EIA_GASOLINE:${now.period}`, headline, body, category: 'energy', asOf: at(now.period),
    agencyName: AGENCY, agencyUrl: 'https://www.eia.gov/petroleum/gasdiesel/', docLabel: 'Gasoline and Diesel Fuel Update',
    attribution: config.agency.eia.attribution,
    paragraphs: [body, 'What this number measures: what drivers pay per gallon across the U.S.', 'The numbers come from the U.S. Energy Information Administration.'],
    keyPoints: [`Regular gasoline: $${fmt(now.value, 2)} a gallon`, `Change: ${signed(change, 2)} dollars from the prior week`, `Week of: ${week}`, `Source: ${AGENCY}`],
  });
}

/**
 * Weekly refinery use and crude supply (EIA Weekly Petroleum Status Report, supply side): refinery utilization is the
 * headline; crude production, crude imports and total product supplied (a measure of demand) go in the detail.
 * `rows` holds the rows of both requests (weekly supply estimates + weekly inputs and utilization).
 */
export function supplyCard(rows: EiaRow[]): PublishPayload | null {
  const s = config.agency.eia.supply.series;
  const util = latestTwo(rows, s.utilization);
  if (!util || !util[1]) return null;
  const [now, prev] = util;
  const change = now.value - prev!.value;
  const week = shortDate(now.period);
  const headline = change === 0
    ? `U.S. refineries hold at ${fmt(now.value, 1)}% of capacity in the week ending ${week}`
    : `U.S. refineries run at ${fmt(now.value, 1)}% of capacity in the week ending ${week}, ${change > 0 ? 'up' : 'down'} from ${fmt(prev!.value, 1)}%`;
  const bpd = (v: number) => `${fmt(v / 1000, 1)} million barrels a day`;
  const same = (id: string) => { const r = latestTwo(rows, id); return r && r[0].period === now.period ? r : null; };
  const prod = same(s.production), imp = same(s.imports), sup = same(s.productSupplied);
  const lines: string[] = [];
  if (prod) lines.push(`U.S. crude oil production: ${bpd(prod[0].value)}`);
  if (imp) lines.push(`Crude oil imports: ${bpd(imp[0].value)}`);
  if (sup) lines.push(`Total petroleum products supplied (a measure of demand): ${bpd(sup[0].value)}`);
  const body = `U.S. refineries ran at ${fmt(now.value, 1)}% of their operable capacity in the week ending ${week}, `
    + (change === 0 ? 'unchanged from' : `${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change), 1)} points from`) + ' the prior week, the U.S. Energy Information Administration reported.'
    + (prod ? ` Crude oil production was ${bpd(prod[0].value)}.` : '');
  return buildAgencyDataCard({
    dedupeKey: `EIA_SUPPLY:${now.period}`, headline, body, category: 'energy', asOf: at(now.period),
    agencyName: AGENCY, agencyUrl: 'https://www.eia.gov/petroleum/supply/weekly/', docLabel: 'Weekly Petroleum Status Report',
    attribution: config.agency.eia.attribution,
    paragraphs: [
      body,
      'What this number measures: how much of the refineries\' processing capacity is in use. A high rate means refiners are running close to flat out turning crude oil into gasoline, diesel and other fuels.',
      'The numbers come from the U.S. Energy Information Administration.',
    ],
    keyPoints: [`Refinery utilization: ${fmt(now.value, 1)}%`, `Change: ${signed(change, 1)} points from the prior week`, ...lines, `Week ending: ${week}`, `Source: ${AGENCY}`],
  });
}
