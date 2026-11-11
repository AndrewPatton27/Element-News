// BEA NIPA data API (apps.bea.gov/api/data) -> Points for the data-card pipeline in macro.ts.
// Numbers only. The API key (BEA_API_KEY) is added by the runner and never logged; the API echoes it in its
// reply, which is parsed here and never stored or logged.
// Inputs: API JSON text for one NIPA table. Outputs: Point[] per Element series id, oldest first.
// DataValue has thousands commas and UNIT_MULT is a base-10 exponent (6 = millions): values are returned in real units.

import { config } from '../config.ts';
import type { Point } from './macro.ts';

interface BeaErr { APIErrorCode?: string; APIErrorDescription?: string }
interface BeaDoc {
  BEAAPI?: {
    Results?: {
      Data?: { SeriesCode?: string; TimePeriod?: string; DataValue?: string; UNIT_MULT?: string }[];
      Error?: BeaErr;
    };
    Error?: BeaErr;
  };
}

/** GET URL for one table. `years` = the Year parameter values; the key goes in UserID. */
export function beaTableUrl(table: string, frequency: 'M' | 'Q', years: number[], key: string): string {
  const u = new URL(config.beaData.base);
  u.searchParams.set('UserID', key);
  u.searchParams.set('method', 'GetData');
  u.searchParams.set('DataSetName', 'NIPA');
  u.searchParams.set('TableName', table);
  u.searchParams.set('Frequency', frequency);
  u.searchParams.set('Year', years.join(','));
  u.searchParams.set('ResultFormat', 'JSON');
  return u.toString();
}

/** The Year parameter for a table: this year and `yearsBack` earlier ones. */
export function beaYears(now: Date, yearsBack: number): number[] {
  const y = now.getUTCFullYear();
  return Array.from({ length: yearsBack + 1 }, (_, i) => y - yearsBack + i);
}

/** "2026M09" -> 2026-09-01, "2026Q3" -> 2026-07-01 (first day of the period, like the FRED quarterly series). Null for annual or odd values. */
export function beaPeriodDate(tp: string): string | null {
  const m = /^(\d{4})M(\d{2})$/.exec(tp);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-01`;
  const q = /^(\d{4})Q([1-4])$/.exec(tp);
  return q ? `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0')}-01` : null;
}

/** NIPA JSON -> points for the series codes in `want` (SeriesCode -> Element series id). Throws on an API error (code only, never the key). */
export function parseBeaNipa(json: string, want: Record<string, string>): Record<string, Point[]> {
  const doc = JSON.parse(json) as BeaDoc;
  const err = doc.BEAAPI?.Results?.Error ?? doc.BEAAPI?.Error;
  if (err) throw new Error(`BEA API error ${err.APIErrorCode ?? '?'}: ${(err.APIErrorDescription ?? '').replace(/[0-9A-Fa-f-]{36}/g, '[id]').slice(0, 120)}`);
  const out: Record<string, Point[]> = {};
  for (const r of doc.BEAAPI?.Results?.Data ?? []) {
    const id = want[r.SeriesCode ?? ''];
    const date = beaPeriodDate(r.TimePeriod ?? '');
    const raw = Number((r.DataValue ?? '').replace(/,/g, ''));
    const mult = Number(r.UNIT_MULT ?? '0');
    if (!id || !date || !(r.DataValue ?? '').trim() || !Number.isFinite(raw) || !Number.isFinite(mult)) continue;
    (out[id] ??= []).push({ date, value: raw * 10 ** mult });
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
