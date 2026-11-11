// Small-chart logic for data cards: the history of a macro series (api.macro_history), which series a card charts,
// the chart geometry and the screen-reader sentence. Pure: no React, no network.
// A card keeps naming the agency and carrying the FRED notice (rule 8); the chart only shows the shape of the numbers.

import type { BlurbCard, MacroFact } from '../../contract/types.ts';

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export interface HistoryPoint { date: string; value: number }          // date YYYY-MM-DD
export interface SeriesHistory { frequency: Frequency; points: HistoryPoint[] }   // oldest first
export type MacroHistory = Record<string, SeriesHistory>;

/** What api.macro_history returns at most per series (the SQL caps it too). */
export const MAX_POINTS = 120;
/** One request asks for at most this many series (the SQL caps it too). */
export const MAX_SERIES_PER_CALL = 6;
/** Fewer points than this is not a chart. */
export const MIN_POINTS = 3;

const FREQUENCIES: readonly string[] = ['daily', 'weekly', 'monthly', 'quarterly'];
const SERIES_ID = /^[A-Z0-9_]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** api.macro_history answer -> clean history. Bad series or points are dropped, never thrown on (the chart is extra). */
export function parseMacroHistory(x: unknown): MacroHistory {
  const out: MacroHistory = {};
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return out;
  for (const [id, raw] of Object.entries(x as Record<string, unknown>)) {
    if (!SERIES_ID.test(id) || typeof raw !== 'object' || raw === null) continue;
    const r = raw as { frequency?: unknown; points?: unknown };
    if (typeof r.frequency !== 'string' || !FREQUENCIES.includes(r.frequency) || !Array.isArray(r.points)) continue;
    const seen = new Set<string>();
    const points: HistoryPoint[] = [];
    for (const p of r.points.slice(0, MAX_POINTS)) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || !DATE.test(p[0]) || Number.isNaN(dayMs(p[0]))) continue;
      const v = typeof p[1] === 'number' ? p[1] : typeof p[1] === 'string' ? Number(p[1]) : NaN;
      if (!Number.isFinite(v) || seen.has(p[0])) continue;
      seen.add(p[0]);
      points.push({ date: p[0], value: v });
    }
    points.sort((a, b) => (a.date < b.date ? -1 : 1));
    out[id] = { frequency: r.frequency as Frequency, points };
  }
  return out;
}

// ---- which series a card charts ----------------------------------------------------------------------------------

export const CURVE_SERIES = ['DGS2', 'DGS5', 'DGS10', 'DGS30'] as const;
export interface ChartSpec { series: string[]; curve: boolean }

/** The daily yield-curve card (2- and 10-year facts) charts all four maturities; any other data card charts its first number. */
export function chartSpec(card: Pick<BlurbCard, 'kind' | 'macro'>): ChartSpec | null {
  if (card.kind !== 'data' || !card.macro?.length) return null;
  const ids = card.macro.map((f) => f.series_id);
  if (ids.includes('DGS10') && ids.includes('DGS2')) return { series: [...CURVE_SERIES], curve: true };
  return { series: [ids[0]], curve: false };
}

/** The histories the card can really chart (enough points), in spec order. */
export function usableSeries(spec: ChartSpec, history: MacroHistory): { id: string; frequency: Frequency; points: HistoryPoint[] }[] {
  return spec.series.flatMap((id) => (history[id] && history[id].points.length >= MIN_POINTS ? [{ id, ...history[id] }] : []));
}

// ---- geometry ------------------------------------------------------------------------------------------------------

export interface ChartLine {
  id: string;
  d: string;                         // polyline path
  area: string | null;               // closed path under the line (single-series charts)
  last: { x: number; y: number };
  min: { x: number; y: number; value: number; date: string };
  max: { x: number; y: number; value: number; date: string };
}
export interface ChartGeometry { lines: ChartLine[]; yMin: number; yMax: number; firstDate: string; lastDate: string }
export interface Pad { l: number; r: number; t: number; b: number }

const f1 = (n: number) => n.toFixed(1);

/** Lines on one shared scale (x by date, so a weekend gap is a gap). null when nothing can be drawn. */
export function chartGeometry(series: { id: string; points: HistoryPoint[] }[], w: number, h: number, pad: Pad = { l: 4, r: 6, t: 6, b: 6 }): ChartGeometry | null {
  const drawn = series.filter((s) => s.points.length >= 2);
  if (drawn.length === 0 || !(w > 0) || !(h > 0)) return null;
  const all = drawn.flatMap((s) => s.points);
  const t0 = Math.min(...all.map((p) => dayMs(p.date)));
  const t1 = Math.max(...all.map((p) => dayMs(p.date)));
  let lo = Math.min(...all.map((p) => p.value));
  let hi = Math.max(...all.map((p) => p.value));
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const margin = (hi - lo) * 0.08;
  lo -= margin; hi += margin;
  const iw = Math.max(1, w - pad.l - pad.r), ih = Math.max(1, h - pad.t - pad.b);
  const x = (d: string) => pad.l + (t1 === t0 ? 0 : ((dayMs(d) - t0) / (t1 - t0)) * iw);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
  const lines = drawn.map((s): ChartLine => {
    const pts = s.points.map((p) => [x(p.date), y(p.value)] as const);
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${f1(p[0])} ${f1(p[1])}`).join(' ');
    const last = pts[pts.length - 1];
    const bottom = pad.t + ih;
    const lowest = s.points.reduce((a, p) => (p.value < a.value ? p : a));
    const highest = s.points.reduce((a, p) => (p.value > a.value ? p : a));
    return {
      id: s.id,
      d,
      area: drawn.length === 1 ? `${d} L${f1(last[0])} ${f1(bottom)} L${f1(pts[0][0])} ${f1(bottom)} Z` : null,
      last: { x: last[0], y: last[1] },
      min: { x: x(lowest.date), y: y(lowest.value), value: lowest.value, date: lowest.date },
      max: { x: x(highest.date), y: y(highest.value), value: highest.value, date: highest.date },
    };
  });
  return { lines, yMin: lo, yMax: hi, firstDate: new Date(t0).toISOString().slice(0, 10), lastDate: new Date(t1).toISOString().slice(0, 10) };
}

// ---- words ----------------------------------------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "+6 bp" -> "6 basis points", "+0.06 pts" -> "0.06 points", "-0.8%" -> "0.8%". null when there is nothing to say. */
export function spokenChange(change: string | null): string | null {
  if (!change) return null;
  const c = change.trim().replace(/^[+\-−]\s*/, '');
  if (!/\d/.test(c)) return null;
  const bp = /^(\d+(?:\.\d+)?)\s*bp$/i.exec(c);
  if (bp) return plural(Number(bp[1]), 'basis point');
  return c.replace(/\s*pts?$/i, ' points').replace(/\b1 points\b/, '1 point');
}

/** "the last 60 days", "the last 12 months": the span the chart covers, in the unit readers know the series by. */
export function spanPhrase(frequency: Frequency, firstDate: string, lastDate: string): string {
  const days = Math.max(1, Math.round((dayMs(lastDate) - dayMs(firstDate)) / 86_400_000));
  if (frequency === 'weekly') return `the last ${plural(Math.max(1, Math.round(days / 7)), 'week')}`;
  if (frequency === 'monthly' || frequency === 'quarterly') {
    const months = Math.max(1, Math.round(days / 30.4));
    return months >= 24 ? `the last ${Math.round(months / 12)} years` : `the last ${plural(months, 'month')}`;
  }
  return `the last ${plural(days, 'day')}`;
}

/** "Tuesday" when the prior reading is within a week, else "Oct 9"; weekly and monthly series say "the prior week" / "the prior month". */
export function sincePhrase(frequency: Frequency, prevDate: string, lastDate: string): string {
  if (frequency === 'weekly') return 'the prior week';
  if (frequency === 'monthly') return 'the prior month';
  if (frequency === 'quarterly') return 'the prior quarter';
  const gap = (dayMs(lastDate) - dayMs(prevDate)) / 86_400_000;
  const d = new Date(dayMs(prevDate));
  return gap <= 6 ? WEEKDAYS[d.getUTCDay()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Screen-reader sentence: "10-yr Treasury, 4.84%, up 3 basis points since Tuesday; chart of the last 60 days". */
export function describeChart(fact: Pick<MacroFact, 'label' | 'value' | 'change' | 'direction'>, spec: ChartSpec, history: MacroHistory): string {
  const usable = usableSeries(spec, history);
  if (usable.length === 0) return '';
  const main = usable.find((s) => s.id === (spec.curve ? 'DGS10' : spec.series[0])) ?? usable[0];
  const first = main.points[0].date, last = main.points[main.points.length - 1].date;
  const prev = main.points[main.points.length - 2].date;
  const spoken = spokenChange(fact.change);
  const move = fact.direction === 'flat' ? 'unchanged' : fact.direction && spoken ? `${fact.direction} ${spoken}` : '';
  const since = move ? ` since ${sincePhrase(main.frequency, prev, last)}` : '';
  const chart = `chart of ${spanPhrase(main.frequency, first, last)}`;
  if (spec.curve) {
    const levels = usable.map((s) => `${s.id.replace(/^DGS(\d+)$/, '$1-year')} ${s.points[s.points.length - 1].value.toFixed(2)}%`).join(', ');
    return `Treasury yields, ${levels}${move ? `; the 10-year ${move}${since}` : ''}; ${chart}, one line per maturity`;
  }
  return `${fact.label}, ${fact.value}${move ? `, ${move}${since}` : ''}; ${chart}`;
}

/**
 * Formats a raw history value in the units the card shows. The card's display string ("$61.40", "212,000", "2.9%")
 * and the latest raw value give the scale, so a series stored in thousands still reads right. null when the display
 * string has no number to copy the format from.
 */
export function formatLike(display: string, latestRaw: number, raw: number): string | null {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(display);
  if (!m || !Number.isFinite(latestRaw) || (latestRaw === 0 && raw !== 0)) return null;
  const shown = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(shown)) return null;
  const factor = latestRaw === 0 ? 1 : shown / latestRaw;
  const decimals = (m[0].split('.')[1] ?? '').length;
  let text = (raw * factor).toFixed(decimals);
  if (m[0].includes(',')) text = Number(text).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return display.slice(0, m.index) + text + display.slice(m.index + m[0].length);
}

/** "Low 3.71% (Sep 4), high 4.12% (Oct 9)": the detail sheet's range line (also read by screen readers). null when not formattable. */
export function rangeText(line: ChartLine, display: string, latestRaw: number): string | null {
  const lo = formatLike(display, latestRaw, line.min.value), hi = formatLike(display, latestRaw, line.max.value);
  if (!lo || !hi) return null;
  const when = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  return `Low ${lo} (${when(line.min.date)}), high ${hi} (${when(line.max.date)})`;
}
