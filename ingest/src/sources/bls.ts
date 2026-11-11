// BLS public data API (api.bls.gov) -> Points for the data-card pipeline in macro.ts.
// Public domain (BLS copyright page); numbers only, no page or text is downloaded.
// Inputs: API JSON text for ONE series (GET .../timeseries/data/<id>). Outputs: Point[] oldest first.
// Monthly periods M01-M12 and quarterly Q01-Q04 only; M13 / Q05 / S01.. (annual averages, half years) are dropped.

import { config } from '../config.ts';
import type { Point } from './macro.ts';

interface BlsDoc {
  status?: string;
  message?: unknown;
  Results?: { series?: { seriesID?: string; data?: { year?: string; period?: string; value?: string }[] }[] };
}

/** One-series GET URL. v1 (no key) by default; a registration key switches to v2 (500 requests/day). */
export function blsSeriesUrl(seriesId: string, key?: string | null): string {
  const url = `${config.bls.base}/${key ? 'v2' : 'v1'}/timeseries/data/${encodeURIComponent(seriesId)}`;
  return key ? `${url}?registrationkey=${encodeURIComponent(key)}` : url;
}

/** API JSON for one series -> points. Throws on a refused request (daily limit, bad series) with the API's own message (no key in it). */
export function parseBlsSeries(json: string): Point[] {
  const doc = JSON.parse(json) as BlsDoc;
  if (doc.status !== 'REQUEST_SUCCEEDED') {
    const msg = Array.isArray(doc.message) ? doc.message.map(String).join('; ') : String(doc.message ?? '');
    throw new Error(`BLS API ${doc.status ?? 'no status'}: ${msg.slice(0, 200)}`);
  }
  const pts: Point[] = [];
  for (const r of doc.Results?.series?.[0]?.data ?? []) {
    const y = /^(\d{4})$/.exec(r.year ?? '');
    const p = /^([MQ])(\d{2})$/.exec(r.period ?? '');
    const value = Number((r.value ?? '').replace(/,/g, ''));
    if (!y || !p || !(r.value ?? '').trim() || !Number.isFinite(value)) continue;
    const n = Number(p[2]);
    let month: number;
    if (p[1] === 'M') { if (n < 1 || n > 12) continue; month = n; }
    else { if (n < 1 || n > 4) continue; month = (n - 1) * 3 + 1; }
    pts.push({ date: `${y[1]}-${String(month).padStart(2, '0')}-01`, value });
  }
  return pts.sort((a, b) => a.date.localeCompare(b.date));
}
