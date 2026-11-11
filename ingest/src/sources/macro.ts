// FRED observations (and the Treasury CSV) -> formatted MacroObservation + data cards.
// Citation strings mirror the core.macro_series seed: always the original agency, "via FRED".
// Inputs: FRED observations JSON (or Treasury CSV), stored MacroFacts (--rewrite).
// Outputs: MacroObservation rows for the Numbers panel and data-card PublishPayloads (no AI).

import type { CardDetail, CategorySlug, MacroFact } from '../../../contract/types.ts';
import { config } from '../config.ts';
import type { MacroObservation, PublishPayload } from '../types.ts';
import { AGENCY_SERIES } from './agencySeries.ts';
import { MORE_SERIES, MORE_WHY } from './moreSeries.ts';

// percent: level in %, change in points.  yoy: index level -> 12-month % change.
// usd: dollar level (scaled), change in %.  number: a count (scaled), change as a count.
type Unit = 'percent' | 'usd' | 'yoy' | 'number';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export interface SeriesInfo {
  label: string;
  noun: string;                      // used in data-card headlines
  about: string;                     // plain explainer (a definition, not a claim about this reading)
  plural?: boolean;                  // "Retail sales rise" vs "Gas price rises"
  unit: Unit;
  decimals: number;
  scale?: number;                    // FRED value x scale = real units (RSAFS is in millions of $, PAYEMS/HOUST in thousands)
  suffix?: string;                   // after a number value, e.g. " (annual rate)"
  frequency: Frequency;
  week?: 'week of' | 'week ending'; // weekly series: what the FRED date means
  category: CategorySlug;            // data-card category
  source_name: string;
  source_short: string;
  sort_order: number;
  agency: { name: string; url: string; doc_label: string };   // primary source link on a data card
  provider?: 'treasury' | 'bls' | 'bea';   // fetched from the agency's own API, not FRED (fact links to the agency page)
  derived?: string;                  // computed by Element from other series (what from, in words)
  fredId?: string;                   // derived series: the FRED series its fact links to (it has no FRED page of its own)
}

const FED = 'Board of Governors of the Federal Reserve System (US) via FRED';
const H15 = { name: 'Federal Reserve Board', url: 'https://www.federalreserve.gov/releases/h15/', doc_label: 'H.15 release' };
const BLS = 'U.S. Bureau of Labor Statistics via FRED';
const EIA = 'U.S. Energy Information Administration via FRED';
const TREASURY = 'U.S. Department of the Treasury, Fiscal Service';
const AVG_RATES = { name: TREASURY, url: 'https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/', doc_label: 'Average interest rates' };

// Never add MORTGAGE30US (Freddie Mac copyright, not public domain): see config.forbiddenSeries.
export const SERIES: Record<string, SeriesInfo> = {
  DGS2: { label: '2-yr Treasury', noun: '2-year Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 2 years', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 1, agency: H15 },
  DGS10: { label: '10-yr Treasury', noun: '10-year Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 10 years', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 2, agency: H15 },
  DFF: { label: 'Fed funds (effective)', noun: 'Effective fed funds rate', about: "the Federal Reserve's main short-term interest rate", unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 3, agency: H15 },
  CPIAUCSL: { label: 'CPI inflation (yearly)', noun: 'Consumer prices', about: 'the prices people pay for everyday goods and services', plural: true, unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy', source_name: BLS, source_short: 'BLS via FRED', sort_order: 4,
    agency: { name: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/cpi/', doc_label: 'CPI' } },
  UNRATE: { label: 'Unemployment rate', noun: 'Unemployment rate', about: "the share of people who want a job but can't find one", unit: 'percent', decimals: 1, frequency: 'monthly', category: 'economy', source_name: BLS, source_short: 'BLS via FRED', sort_order: 5,
    agency: { name: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/news.release/empsit.nr0.htm', doc_label: 'Employment Situation' } },
  DCOILWTICO: { label: 'WTI crude oil', noun: 'WTI crude oil', about: 'the main U.S. oil price, which feeds into gas prices', unit: 'usd', decimals: 2, frequency: 'daily', category: 'energy', source_name: EIA, source_short: 'EIA via FRED', sort_order: 6,
    agency: { name: 'U.S. Energy Information Administration', url: 'https://www.eia.gov/dnav/pet/hist/RWTCD.htm', doc_label: 'Spot prices' } },
  // Added 2026-10-17 (citations from each FRED series page, read by Rob the same day).
  GASREGW: { label: 'Gas price (regular)', noun: 'Average regular gas price', about: 'what drivers pay per gallon across the U.S.', unit: 'usd', decimals: 2, frequency: 'weekly', week: 'week of', category: 'energy', source_name: EIA, source_short: 'EIA via FRED', sort_order: 7,
    agency: { name: 'U.S. Energy Information Administration', url: 'https://www.eia.gov/petroleum/gasdiesel/', doc_label: 'Gasoline and Diesel Fuel Update' } },
  ICSA: { label: 'Jobless claims (weekly)', noun: 'Initial jobless claims', about: 'the number of people who newly applied for unemployment benefits', plural: true, unit: 'number', decimals: 0, frequency: 'weekly', week: 'week ending', category: 'economy',
    source_name: 'U.S. Employment and Training Administration via FRED', source_short: 'Dept. of Labor via FRED', sort_order: 8,
    agency: { name: 'U.S. Department of Labor', url: 'https://oui.doleta.gov/unemploy/claims.asp', doc_label: 'Unemployment Insurance Weekly Claims' } },
  RSAFS: { label: 'Retail sales (monthly)', noun: 'Retail sales', about: 'what people spent in stores, online and at restaurants', plural: true, unit: 'usd', decimals: 1, scale: 1e6, frequency: 'monthly', category: 'economy',
    source_name: 'U.S. Census Bureau via FRED', source_short: 'Census via FRED', sort_order: 9,
    agency: { name: 'U.S. Census Bureau', url: 'https://www.census.gov/retail/index.html', doc_label: 'Advance Monthly Retail Trade' } },
  HOUST: { label: 'Housing starts', noun: 'Housing starts', about: 'the number of new homes builders began', plural: true, unit: 'number', decimals: 2, scale: 1e3, suffix: ' (annual rate)', frequency: 'monthly', category: 'economy',
    source_name: 'U.S. Census Bureau and U.S. Department of Housing and Urban Development via FRED', source_short: 'Census via FRED', sort_order: 10,
    agency: { name: 'U.S. Census Bureau', url: 'https://www.census.gov/construction/nrc/index.html', doc_label: 'New Residential Construction' } },
  PAYEMS: { label: 'Payroll jobs', noun: 'Nonfarm payroll jobs', about: 'the total number of U.S. jobs outside farming', plural: true, unit: 'number', decimals: 1, scale: 1e3, frequency: 'monthly', category: 'economy', source_name: BLS, source_short: 'BLS via FRED', sort_order: 11,
    agency: { name: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/news.release/empsit.nr0.htm', doc_label: 'Employment Situation' } },
  A191RL1Q225SBEA: { label: 'GDP growth (annual rate)', noun: 'Real GDP growth rate', about: 'how fast the U.S. economy grew, at a yearly pace', unit: 'percent', decimals: 1, frequency: 'quarterly', category: 'economy',
    source_name: 'U.S. Bureau of Economic Analysis via FRED', source_short: 'BEA via FRED', sort_order: 12,
    agency: { name: 'U.S. Bureau of Economic Analysis', url: 'https://www.bea.gov/data/gdp/gross-domestic-product', doc_label: 'GDP' } },
  // Added 2026-11-08 (finance and rates): Federal Reserve Board H.15 series via FRED, a derived spread and
  // Treasury FiscalData series (provider 'treasury'). None of them is in the Numbers panel (in_numbers false).
  DGS3MO: { label: '3-mo Treasury', noun: '3-month Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 3 months', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 13, agency: H15 },
  DGS5: { label: '5-yr Treasury', noun: '5-year Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 5 years', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 14, agency: H15 },
  DGS30: { label: '30-yr Treasury', noun: '30-year Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 30 years, a guide for long-term loans', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 15, agency: H15 },
  EFFR: { label: 'Effective fed funds (EFFR)', noun: 'Effective federal funds rate', about: 'the rate banks pay each other for overnight loans', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 16, agency: H15 },
  DFEDTARU: { label: 'Fed rate target (upper)', noun: 'Fed target rate upper limit', about: 'the top of the range the Federal Reserve aims for with its main short-term interest rate', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 17,
    agency: { name: 'Federal Reserve Board', url: 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm', doc_label: 'Open market operations' } },
  DFEDTARL: { label: 'Fed rate target (lower)', noun: 'Fed target rate lower limit', about: 'the bottom of the range the Federal Reserve aims for with its main short-term interest rate', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 18,
    agency: { name: 'Federal Reserve Board', url: 'https://www.federalreserve.gov/monetarypolicy/openmarket.htm', doc_label: 'Open market operations' } },
  SPREAD_10Y2Y: { label: '10-yr minus 2-yr', noun: '10-year minus 2-year Treasury yield gap', about: 'the gap between long and short government borrowing rates', unit: 'percent', decimals: 2, frequency: 'daily', category: 'economy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 19, agency: H15,
    derived: 'the 10-year and 2-year Treasury yields', fredId: 'DGS10' },
  TREAS_AVG_BILLS: { label: 'Avg rate on T-bills', noun: 'Average interest rate on Treasury bills', about: 'what the government pays on its short-term borrowing, averaged over all bills outstanding', unit: 'percent', decimals: 2, frequency: 'monthly', category: 'economy', provider: 'treasury', source_name: TREASURY, source_short: 'Treasury Fiscal Service', sort_order: 20, agency: AVG_RATES },
  TREAS_AVG_NOTES: { label: 'Avg rate on T-notes', noun: 'Average interest rate on Treasury notes', about: 'what the government pays on its medium-term borrowing, averaged over all notes outstanding', unit: 'percent', decimals: 2, frequency: 'monthly', category: 'economy', provider: 'treasury', source_name: TREASURY, source_short: 'Treasury Fiscal Service', sort_order: 21, agency: AVG_RATES },
  TREAS_AVG_BONDS: { label: 'Avg rate on T-bonds', noun: 'Average interest rate on Treasury bonds', about: 'what the government pays on its long-term borrowing, averaged over all bonds outstanding', unit: 'percent', decimals: 2, frequency: 'monthly', category: 'economy', provider: 'treasury', source_name: TREASURY, source_short: 'Treasury Fiscal Service', sort_order: 22, agency: AVG_RATES },
  TREAS_DEBT: { label: 'National debt', noun: 'Total U.S. national debt', about: 'everything the federal government owes', unit: 'usd', decimals: 2, frequency: 'daily', category: 'economy', provider: 'treasury', source_name: TREASURY, source_short: 'Treasury Fiscal Service', sort_order: 23,
    agency: { name: TREASURY, url: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/', doc_label: 'Debt to the Penny' } },
  ...AGENCY_SERIES,
  ...MORE_SERIES,
};

/**
 * Hand-written "why it matters" line per series (no AI, no prediction, no advice). Each line states how the number
 * is defined or used, in plain words; it must not repeat `about` (the body already says that) and must not claim
 * what a reading will cause. Shown in the card body and in the detail sheet.
 */
export const WHY: Record<string, string> = {
  ...MORE_WHY,
  BLS_AHE: 'Wages are the biggest cost for most employers and the main income for most households, so this feeds into both prices and spending.',
  BLS_ECI: 'It counts wages and benefits together and adjusts for shifts in the mix of jobs, so it is a cleaner read on labor costs than average pay.',
  BLS_JOLTS: 'Job openings show how many positions employers want to fill, which is one way to see how tight the job market is.',
  BLS_CPI_FOOD_HOME: 'It is the grocery part of the consumer price index; restaurant meals are counted separately.',
  BLS_CPI_RENT: 'Rent is the largest piece of housing costs in the consumer price index, so it moves slowly and weighs heavily on the inflation total.',
  BLS_CPI_ELECTRICITY: 'It tracks the electricity bill households pay, which depends on fuel costs, power supply and local rates.',
  BLS_CPI_MEDICAL: 'It covers medical services, drugs and health insurance, which matter most to older households and people on fixed incomes.',
  BEA_PCE_YOY: 'The Federal Reserve aims for 2% inflation as measured by this index, not by CPI.',
  BEA_CORE_PCE_YOY: 'This is the version of the index the Federal Reserve watches most closely, because food and energy prices swing a lot.',
  BEA_PERSONAL_INCOME: 'Household income is what spending is paid from, and spending is about two thirds of the economy.',
  BEA_GDP: 'GDP is the broadest measure of the size of the U.S. economy.',
  DGS2: 'It shows borrowing costs at the short end of the Treasury market.',
  DGS3MO: "This is the shortest end of the Treasury curve, closest to the Fed's own short-term policy rate.",
  DGS5: 'It sits in the middle of the Treasury curve, between short-term and long-term borrowing costs.',
  DGS10: 'It is a widely used benchmark for long-term interest rates, including mortgage rates.',
  DGS30: 'It is the longest government benchmark, used as a reference for very long-term borrowing costs.',
  DFF: "Banks lend to each other overnight at about this rate. The Fed's target range is a separate, announced range, and this rate normally sits inside it.",
  EFFR: "Banks lend to each other overnight at about this rate, and it normally sits inside the Fed's target range.",
  DFEDTARU: 'The Fed announces its target range after each policy meeting. This is the top of that range.',
  DFEDTARL: 'The Fed announces its target range after each policy meeting. This is the bottom of that range.',
  SPREAD_10Y2Y: 'When the gap is negative, short-term yields are above long-term ones, which is called an inverted yield curve.',
  CPIAUCSL: 'It is the standard measure of inflation, which is how fast everyday prices rise.',
  UNRATE: 'It comes from a monthly government survey of households and counts only people who are looking for work.',
  DCOILWTICO: 'Oil prices feed into the cost of gasoline and other fuels.',
  GASREGW: 'The EIA surveys retail gas stations every week to get this average.',
  ICSA: 'The Labor Department reports this count every week, so it is one of the fastest signs of job losses.',
  RSAFS: 'It is one measure of consumer spending.',
  HOUST: 'It counts homes on which construction began, not homes sold.',
  PAYEMS: 'It comes from a monthly survey of employers and counts jobs, not people.',
  A191RL1Q225SBEA: 'GDP is the broadest measure of what the U.S. economy produces.',
  TREAS_AVG_BILLS: 'It averages every bill the government has outstanding, so it moves more slowly than yields on newly issued bills.',
  TREAS_AVG_NOTES: 'It averages every note the government has outstanding, so it moves more slowly than yields on newly issued notes.',
  TREAS_AVG_BONDS: 'It averages every bond the government has outstanding, so it moves more slowly than yields on newly issued bonds.',
  TREAS_DEBT: 'Treasury reports it daily as total public debt outstanding, including money the government owes its own accounts.',
  YIELDCURVE: 'Treasury yields are widely used as benchmarks for other interest rates.',
};

/** Rate series whose moves read in basis points ("+5 bp"), not "pts". Unemployment, GDP and CPI keep percentage points. */
export const BP_SERIES = new Set(['DGS2', 'DGS3MO', 'DGS5', 'DGS10', 'DGS30', 'DFF', 'EFFR', 'DFEDTARU', 'DFEDTARL', 'SPREAD_10Y2Y',
  'TREAS_AVG_BILLS', 'TREAS_AVG_NOTES', 'TREAS_AVG_BONDS']);

export interface Point { date: string; value: number }   // date YYYY-MM-DD

/** FRED series/observations JSON -> points, oldest first; "." (missing) dropped. */
export function parseFredObservations(json: string): Point[] {
  const doc = JSON.parse(json) as { observations?: { date: string; value: string }[] };
  return (doc.observations ?? [])
    .filter((o) => o.value !== '.' && o.value.trim() !== '' && Number.isFinite(Number(o.value)))
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Treasury daily par yield CSV -> points for one column ("2 Yr", "10 Yr"), oldest first. */
export function parseTreasuryCsv(csv: string, column: string): Point[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const col = header.indexOf(column);
  if (col < 0) throw new Error(`column not found: ${column}`);
  return lines.slice(1)
    .map((l) => l.split(','))
    .map((c) => {
      const [m, d, y] = c[0].split('/');
      return { date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, value: Number(c[col]) };
    })
    .filter((p) => Number.isFinite(p.value) && String(p.value) !== '')
    .sort((a, b) => a.date.localeCompare(b.date));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ym = (date: string) => date.slice(0, 7);
function minusMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const signed = (x: number, d: number) => (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x).toFixed(d);
/** A move in percentage points -> whole basis points as text: 0.05 -> "+5 bp", -0.034 -> "-3 bp", 0 -> "0 bp". */
const bpText = (pointsMove: number) => { const n = Math.round(pointsMove * 100); return `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n)} bp`; };
/** "+5 bp" / "-0.05 pts" -> the move in percentage points (0.05 / -0.05); null if unreadable. */
function changeInPoints(text: string | null): number | null {
  if (!text) return null;
  const n = parseFloat(text.replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return / bp$/.test(text) ? n / 100 : n;
}

/** 745021000000 -> "745.0B", 1275000 -> "1.28M" (decimals 2), 199000 -> "199,000", 4.331 -> "4.33". */
export function formatAmount(x: number, decimals: number): string {
  const a = Math.abs(x);
  if (a >= 1e12) return fixed(x / 1e12, decimals) + 'T';
  if (a >= 1e9) return fixed(x / 1e9, decimals) + 'B';
  if (a >= 1e6) return fixed(x / 1e6, decimals) + 'M';
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  return fixed(x, decimals);
}
/** toFixed with decimal half-up rounding (1.275 -> "1.28"; plain toFixed gives "1.27"). */
function fixed(x: number, d: number): string {
  const r = Number(`${Math.round(Number(`${x}e${d}`))}e-${d}`);
  return Number.isFinite(r) ? r.toFixed(d) : x.toFixed(d);     // exponent-form inputs (1e-7) fall back
}
const signedAmount = (x: number, d: number) => (x > 0 ? '+' : x < 0 ? '-' : '') + formatAmount(Math.abs(x), d);

function yoyAt(points: Point[], date: string): number | null {
  const cur = points.find((p) => ym(p.date) === ym(date));
  const ago = points.find((p) => ym(p.date) === minusMonths(date, 12));
  return cur && ago ? round((cur.value / ago.value - 1) * 100, 1) : null;
}

function periodLabel(s: SeriesInfo, date: string): string | null {
  const [y, m, d] = date.split('-').map(Number);
  switch (s.frequency) {
    case 'monthly': return `${MONTHS[m - 1]} ${y}`;
    case 'quarterly': return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case 'weekly': return `${s.week === 'week ending' ? 'Week ending' : 'Week of'} ${MONTHS[m - 1]} ${d}`;
    default: return null;
  }
}

/** Latest point -> formatted observation for api.upsert_macro, or null if not enough data. */
export function buildObservation(seriesId: string, points: Point[]): MacroObservation | null {
  const s = SERIES[seriesId];
  if (!s || points.length === 0) return null;
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const k = s.scale ?? 1;
  let value: number, display: string, change: number | null, changeText: string | null, move: number | null;

  if (s.unit === 'yoy') {
    const y = yoyAt(points, last.date);
    if (y === null) return null;
    const py = prev ? yoyAt(points, prev.date) : null;
    value = y;
    display = `${y.toFixed(s.decimals)}%`;
    change = py === null ? null : round(y - py, s.decimals);
    changeText = change === null ? null : `${signed(change, s.decimals)} pts`;
    move = change === null ? null : Math.abs(change);
  } else if (s.unit === 'usd') {
    value = last.value;
    display = `$${formatAmount(last.value * k, s.decimals)}`;
    change = prev ? round((last.value / prev.value - 1) * 100, 1) : null;
    changeText = change === null ? null : `${signed(change, 1)}%`;
    move = change === null ? null : Math.abs(change);
  } else if (s.unit === 'number') {
    value = last.value;
    display = formatAmount(last.value * k, s.decimals);
    change = prev ? (last.value - prev.value) * k : null;
    changeText = change === null ? null : signedAmount(change, s.decimals);
    move = prev ? round(Math.abs(last.value / prev.value - 1) * 100, 2) : null;   // % move, for the threshold
  } else {
    value = last.value;
    display = `${last.value.toFixed(s.decimals)}%`;
    change = prev ? round(last.value - prev.value, s.decimals) : null;
    const bp = BP_SERIES.has(seriesId);
    if (bp && change !== null) change = round(Math.round(change * 100) / 100, 2);   // whole basis points
    changeText = change === null ? null : bp ? bpText(change) : `${signed(change, s.decimals)} pts`;
    move = change === null ? null : Math.abs(change);
  }
  return {
    series_id: seriesId,
    obs_date: last.date,
    value,
    display_value: display,
    change_text: changeText,
    direction: change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    period_label: periodLabel(s, last.date),
    move,
  };
}

/** Observation -> the MacroFact shown on a data card (label, value, change, agency citation, FRED link). */
function toMacroFact(o: MacroObservation): MacroFact {
  const s = SERIES[o.series_id];
  return {
    series_id: o.series_id, label: s.label, value: o.display_value, change: o.change_text,
    direction: o.direction, period: o.period_label, as_of: o.obs_date,
    source_name: s.source_name, source_short: s.source_short,
    source_url: s.provider ? s.agency.url : `https://fred.stlouisfed.org/series/${s.fredId ?? o.series_id}`, sort_order: s.sort_order,
  };
}

/** Magnitude of the move in the series' threshold unit (points for rates, % for dollars and counts). */
function moveSize(o: MacroObservation): number | null {
  if (o.move !== undefined) return o.move;
  if (!o.change_text) return null;
  const m = changeInPoints(o.change_text);
  return m === null ? null : Math.abs(m);
}

/** Body = the reading sentence + the hand-written why-it-matters line (never repeats `about`). */
const withWhy = (body: string, id: string) => (WHY[id] ? `${body} ${WHY[id]}` : body);

const PRIOR: Record<Frequency, string> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter' };

/**
 * Data card for a new observation, or null if there is no change to report or the move is
 * below config.dataCardMinMove (daily and weekly series). Monthly and quarterly series get
 * one card per new period (the dedupe key is series + date). `opts.force` skips the move threshold (--rewrite).
 * Left as one function (the wording branches share many locals). Outline:
 *   1. threshold check (daily/weekly only)
 *   2. `when` / change words for the period
 *   3. headline + body: year-over-year series vs level series
 *   4. detail paragraphs and key points (previous value only for rates and percentages)
 *   5. payload with the agency as the primary source
 */
export function buildDataCard(o: MacroObservation, extra: MacroObservation[] = [], opts: { force?: boolean; targetRange?: string } = {}): PublishPayload | null {
  const s = SERIES[o.series_id];
  if (!s || o.direction === null) return null;
  if (!opts.force && (s.frequency === 'daily' || s.frequency === 'weekly')) {
    const min = config.dataCardMinMove[o.series_id] ?? 0;
    const move = moveSize(o);
    if (move === null || move < min) return null;
  }
  const [y, m, d] = o.obs_date.split('-').map(Number);
  const when = s.frequency === 'monthly' ? `in ${MONTHS_LONG[m - 1]}`
    : s.frequency === 'quarterly' ? `in ${periodLabel(s, o.obs_date)}`
    : s.frequency === 'weekly' ? `in the ${s.week ?? 'week of'} ${MONTHS[m - 1]} ${d}`
    : `on ${MONTHS[m - 1]} ${d}`;
  const prior = PRIOR[s.frequency];
  const changeWords = o.direction === 'flat'
    ? 'unchanged'
    : `${o.direction} ${o.change_text!.replace(/^[+-]/, '').replace(' pts', ' points').replace(/ bp$/, (m) => (o.change_text!.startsWith('+1 ') || o.change_text!.startsWith('-1 ') ? ' basis point' : ' basis points'))}`;
  const value = `${o.display_value}${s.suffix ?? ''}`;

  let headline: string;
  let body: string;
  if (s.unit === 'yoy') {
    headline = `${s.noun} ${o.value >= 0 ? 'up' : 'down'} ${Math.abs(o.value).toFixed(s.decimals)}% from a year earlier ${when}`;
    body = `${s.noun}, ${s.about}, rose ${o.display_value} in the 12 months through ${MONTHS_LONG[m - 1]} ${y}, ${o.direction === 'flat' ? 'the same pace as' : `${changeWords} from`} the prior month's reading.`;
    if (o.value < 0) body = `${s.noun}, ${s.about}, fell ${Math.abs(o.value).toFixed(s.decimals)}% in the 12 months through ${MONTHS_LONG[m - 1]} ${y}.`;
    body = withWhy(body, o.series_id);
  } else {
    const verb = o.direction === 'up' ? (s.plural ? 'rise to' : 'rises to')
      : o.direction === 'down' ? (s.plural ? 'fall to' : 'falls to') : 'unchanged at';
    headline = `${s.noun} ${verb} ${value}${s.frequency === 'daily' ? '' : ` ${when}`}`;
    const subject = s.plural ? s.noun : `The ${s.noun.charAt(0).toLowerCase() + s.noun.slice(1)}`;
    body = `${subject}, ${s.about}, ${s.plural ? 'were' : 'was'} ${value} ${when}, ${o.direction === 'flat' ? 'unchanged from' : `${changeWords} from`} the prior ${prior}.`;
    body = withWhy(body, o.series_id);
  }
  const at = new Date(`${o.obs_date}T00:00:00Z`).toISOString();
  // In-depth detail (D-37): the value, the change, the previous value when it follows directly
  // (rates and percentages only), what the number measures, and the agency.
  const movePts = changeInPoints(o.change_text);
  const prevValue = (s.unit === 'percent' || s.unit === 'yoy') && movePts !== null && o.direction !== 'flat'
    ? `${(parseFloat(o.display_value) - movePts).toFixed(s.decimals)}%` : null;
  const subjectLower = s.plural ? s.noun : `The ${s.noun.charAt(0).toLowerCase() + s.noun.slice(1)}`;
  const reading = s.unit === 'yoy' ? `${s.noun} rose ${o.display_value} in the 12 months through ${MONTHS_LONG[m - 1]} ${y}.` : `${subjectLower} ${s.plural ? 'were' : 'was'} ${value} ${when}.`;
  const changeSentence = o.direction === 'flat'
    ? `That is unchanged from the prior ${s.unit === 'yoy' ? 'month' : prior}.`
    : `That is ${changeWords} from the prior ${s.unit === 'yoy' ? "month's reading" : prior}${prevValue ? `, when it was ${prevValue}` : ''}.`;
  const detail: CardDetail = {
    paragraphs: [
      `${reading} ${changeSentence}`,
      `What this number measures: ${s.about}. ${WHY[o.series_id] ?? ''}`.trim(),
      s.provider ? `The number comes from the ${s.agency.name}.`
        : s.derived ? `Element worked this out from ${s.derived}, from the ${s.agency.name} through FRED.`
        : `The number comes from the ${s.agency.name}, shared through FRED.`,
    ],
    // Each bullet adds a fact the headline and body do not state: the dated reading, the previous reading, how often
    // it is published, the agency. No "Change:" or "Period:" bullets (they repeated the hero number, E-02).
    key_points: [
      `${s.label}: ${value}, ${s.frequency === 'monthly' || s.frequency === 'quarterly' ? `for ${periodLabel(s, o.obs_date)}` : `as of ${MONTHS[m - 1]} ${d}, ${y}`}`,
      ...(prevValue ? [`Previous ${s.unit === 'yoy' ? 'month' : prior}: ${prevValue}`] : []),
      ...(opts.targetRange ? [`Fed target range: ${opts.targetRange}`] : []),
      `Published ${s.frequency}`,
      `Source: ${s.agency.name}`,
    ],
  };
  return {
    dedupe_key: `${o.series_id}:${o.obs_date}`,
    kind: 'data',
    headline: headline.slice(0, config.headlineMaxChars),
    body,
    category: s.category,
    event_type: 'macro_release',
    ai_generated: false,
    tickers: [],
    macro: [toMacroFact(o), ...extra.map(toMacroFact)].slice(0, 3),
    as_of: at,
    sort_at: at,
    model: null,
    prompt_version: config.templateVersion,
    attribution: null,
    detail,
    sources: [{
      name: s.agency.name, kind: 'government', doc_label: s.agency.doc_label, url: s.agency.url,
      published_at: at, license_class: 'public_domain', attribution: null, is_primary: true,
    }],
  };
}

/**
 * Stored MacroFact (from a published data card) -> observation, so --rewrite can rebuild the card
 * text with the current template. Only values already on the card are used. Null if unknown series.
 */
export function observationFromFact(f: MacroFact): MacroObservation | null {
  if (!SERIES[f.series_id]) return null;
  const value = parseFloat(f.value.replace(/[^\d.-]/g, ''));
  // facts stored before the basis-point change say "+0.05 pts" for rates: read them as "+5 bp"
  const pts = f.change && BP_SERIES.has(f.series_id) && / pts$/.test(f.change) ? changeInPoints(f.change) : null;
  return {
    series_id: f.series_id,
    obs_date: f.as_of.slice(0, 10),
    value: Number.isFinite(value) ? value : 0,
    display_value: f.value,
    change_text: pts === null ? f.change : bpText(pts),
    direction: f.direction,
    period_label: f.period,
  };
}

/** FRED observations URL for a series (the key is added by the caller, never logged). */
export function fredUrl(seriesId: string, start: string): string {
  if ((config.forbiddenSeries as readonly string[]).includes(seriesId)) throw new Error(`${seriesId} is a forbidden series (not public domain)`);
  const u = new URL(config.feeds.fredObservations);
  u.searchParams.set('series_id', seriesId);
  u.searchParams.set('file_type', 'json');
  u.searchParams.set('observation_start', start);
  return u.toString();
}

/** Derived series: a minus b on dates both have, rounded to 4 places, oldest first. */
export function differenceSeries(a: Point[], b: Point[]): Point[] {
  const bm = new Map(b.map((p) => [p.date, p.value]));
  return a.filter((p) => bm.has(p.date)).map((p) => ({ date: p.date, value: round(p.value - bm.get(p.date)!, 4) }));
}

// ---- one daily Treasury yield-curve card (replaces one card per maturity) ---------------------------------------

/** The maturities on the curve card, short to long. Each is also a Numbers/ticker series (DGS2 is stored, not shown). */
export const CURVE_SERIES = ['DGS2', 'DGS5', 'DGS10', 'DGS30'] as const;
export const CURVE_ID = 'YIELDCURVE';

const bpPhrase = (bp: number) => (bp === 0 ? 'unchanged' : `${bp > 0 ? 'up' : 'down'} ${Math.abs(bp)} basis point${Math.abs(bp) === 1 ? '' : 's'}`);
const bpSigned = (bp: number) => `${bp > 0 ? '+' : bp < 0 ? '-' : ''}${Math.abs(bp)} bp`;

/**
 * One card for the day's Treasury yields: 2, 5, 10 and 30-year plus the 10-year minus 2-year gap, moves in basis
 * points. Returns null (card skipped this run, retried next run) unless all four series have a reading on the SAME
 * date as the 10-year, which is the reading the Numbers ticker shows: so the card and the ticker can never disagree
 * (E-02/E-03). No card when no maturity moved at least config.yieldCurve.minMovePoints (0 = a card every day with
 * a new reading; only the newest stays live, see core.supersede_series). `opts.force` skips the threshold.
 * Dedupe key `YIELDCURVE:<date>`; the supersede trigger keys on the part before the colon.
 */
export function buildYieldCurveCard(points: Partial<Record<string, Point[]>>, opts: { force?: boolean } = {}): PublishPayload | null {
  const obs: Record<string, MacroObservation> = {};
  for (const id of CURVE_SERIES) {
    const p = points[id];
    const o = p ? buildObservation(id, p) : null;
    if (!o || o.direction === null) return null;
    obs[id] = o;
  }
  const date = obs.DGS10.obs_date;
  if (CURVE_SERIES.some((id) => obs[id].obs_date !== date)) return null;
  if (!opts.force && Math.max(...CURVE_SERIES.map((id) => obs[id].move ?? 0)) < config.yieldCurve.minMovePoints) return null;

  const spreadObs = buildObservation('SPREAD_10Y2Y', differenceSeries(points.DGS10!, points.DGS2!));
  if (!spreadObs || spreadObs.obs_date !== date) return null;

  const bp: Record<string, number> = {};
  for (const id of CURVE_SERIES) bp[id] = Math.round((changeInPoints(obs[id].change_text) ?? 0) * 100);
  const all = CURVE_SERIES.map((id) => bp[id]);
  const mood = all.every((x) => x > 0) ? 'rise' : all.every((x) => x < 0) ? 'fall' : all.every((x) => x === 0) ? 'unchanged' : 'mixed';
  const headline = `Treasury yields ${mood}, 10-year at ${obs.DGS10.display_value}`;

  const [y, m, d] = date.split('-').map(Number);
  const dayLabel = `${MONTHS[m - 1]} ${d}, ${y}`;
  const gapPts = spreadObs.value;
  const gapBp = Math.round(gapPts * 100);
  const gapMove = Math.round((changeInPoints(spreadObs.change_text) ?? 0) * 100);
  const body = `The 2-year yield was ${bpPhrase(bp.DGS2)} and the 10-year ${bpPhrase(bp.DGS10)} from the prior day. ${WHY[CURVE_ID]}`;
  const gapWord = gapBp < 0 ? `${Math.abs(gapBp)} basis points below` : gapBp > 0 ? `${gapBp} basis points above` : 'level with';
  const detail: CardDetail = {
    paragraphs: [
      `On ${dayLabel}, Treasury yields were ${CURVE_SERIES.map((id) => `${SERIES[id].label.replace(/-yr Treasury/, '-year')} ${obs[id].display_value}`).join(', ')}.`,
      `The 10-year yield was ${gapWord} the 2-year yield${gapMove === 0 ? ', the same gap as the prior day' : `, ${gapMove > 0 ? 'a wider' : 'a narrower'} gap than the prior day`}. ${WHY.SPREAD_10Y2Y}`,
      'A yield is the yearly interest rate the U.S. government pays to borrow for that length of time.',
      'The yields come from the Federal Reserve Board\'s H.15 release, shared through FRED.',
    ],
    key_points: [
      ...CURVE_SERIES.map((id) => `${SERIES[id].label.replace(/-yr Treasury/, '-year')}: ${obs[id].display_value} (${bpSigned(bp[id])})`),
      `10-year minus 2-year: ${gapBp} bp (${bpSigned(gapMove)})`,
    ],
  };
  const at = new Date(`${date}T00:00:00Z`).toISOString();
  return {
    dedupe_key: `${CURVE_ID}:${date}`,
    kind: 'data',
    headline: headline.slice(0, config.headlineMaxChars),
    body,
    category: 'economy',
    event_type: 'macro_release',
    ai_generated: false,
    tickers: [],
    macro: [obs.DGS10, obs.DGS2, spreadObs].map(toMacroFact),
    as_of: at,
    sort_at: at,
    model: null,
    prompt_version: config.templateVersion,
    attribution: null,
    detail,
    sources: [{
      name: H15.name, kind: 'government', doc_label: H15.doc_label, url: H15.url,
      published_at: at, license_class: 'public_domain', attribution: null, is_primary: true,
    }],
  };
}
