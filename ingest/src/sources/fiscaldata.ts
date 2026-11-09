// Treasury FiscalData (JSON API, no key) -> Points for the Numbers/data-card pipeline in macro.ts.
// Datasets: average interest rates on marketable securities (monthly) and debt to the penny (daily).
// All FiscalData values are strings and a missing value is the string "null"; both are handled here.
// Inputs: API JSON text. Outputs: Point[] per Element series id (TREAS_AVG_*, TREAS_DEBT), oldest first.

import { config } from '../config.ts';
import type { Point } from './macro.ts';

interface FdDoc { data?: Record<string, string>[] }

const num = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = String(v).trim();
  if (t === '' || t.toLowerCase() === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const validDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Average interest rates JSON -> points per series (Marketable Bills/Notes/Bonds only), oldest first. */
export function parseAvgRates(json: string): Record<string, Point[]> {
  const out: Record<string, Point[]> = {};
  for (const r of (JSON.parse(json) as FdDoc).data ?? []) {
    const id = config.fiscalData.avgRateSeries[r.security_desc];
    const value = num(r.avg_interest_rate_amt);
    if (!id || r.security_type_desc !== 'Marketable' || value === null || !validDate(r.record_date)) continue;
    (out[id] ??= []).push({ date: r.record_date, value });
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Debt to the penny JSON -> total public debt outstanding in dollars, oldest first. */
export function parseDebt(json: string): Point[] {
  const pts: Point[] = [];
  for (const r of (JSON.parse(json) as FdDoc).data ?? []) {
    const value = num(r.tot_pub_debt_out_amt);
    if (value !== null && validDate(r.record_date)) pts.push({ date: r.record_date, value });
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}

export const avgRatesUrl = (): string => config.fiscalData.base + config.fiscalData.avgRatesPath;
export const debtUrl = (): string => config.fiscalData.base + config.fiscalData.debtPath;
