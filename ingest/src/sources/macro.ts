// FRED observations (and the Treasury CSV) -> formatted MacroObservation + data cards.
// Citation strings mirror the core.macro_series seed: always the original agency, "via FRED".
// Inputs: FRED observations JSON (or Treasury CSV), stored MacroFacts (--rewrite).
// Outputs: MacroObservation rows for the Numbers panel and data-card PublishPayloads (no AI).

import type { CardDetail, CategorySlug, MacroFact } from '../../../contract/types.ts';
import { config } from '../config.ts';
import type { MacroObservation, PublishPayload } from '../types.ts';

// percent: level in %, change in points.  yoy: index level -> 12-month % change.
// usd: dollar level (scaled), change in %.  number: a count (scaled), change as a count.
type Unit = 'percent' | 'usd' | 'yoy' | 'number';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

interface SeriesInfo {
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
}

const FED = 'Board of Governors of the Federal Reserve System (US) via FRED';
const H15 = { name: 'Federal Reserve Board', url: 'https://www.federalreserve.gov/releases/h15/', doc_label: 'H.15 release' };
const BLS = 'U.S. Bureau of Labor Statistics via FRED';
const EIA = 'U.S. Energy Information Administration via FRED';

// Never add MORTGAGE30US (Freddie Mac copyright, not public domain): see config.forbiddenSeries.
export const SERIES: Record<string, SeriesInfo> = {
  DGS2: { label: '2-yr Treasury', noun: '2-year Treasury yield', about: 'the interest rate the U.S. government pays to borrow for 2 years', unit: 'percent', decimals: 2, frequency: 'daily', category: 'markets', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 1, agency: H15 },
  DGS10: { label: '10-yr Treasury', noun: '10-year Treasury yield', about: 'a rate that many mortgage and loan rates follow', unit: 'percent', decimals: 2, frequency: 'daily', category: 'markets', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 2, agency: H15 },
  DFF: { label: 'Fed funds rate', noun: 'Effective fed funds rate', about: "the Federal Reserve's main short-term interest rate", unit: 'percent', decimals: 2, frequency: 'daily', category: 'policy', source_name: FED, source_short: 'Federal Reserve via FRED', sort_order: 3, agency: H15 },
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
};

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

/** 745021000000 -> "745.0B", 1275000 -> "1.28M" (decimals 2), 199000 -> "199,000", 4.331 -> "4.33". */
export function formatAmount(x: number, decimals: number): string {
  const a = Math.abs(x);
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
    changeText = change === null ? null : `${signed(change, s.decimals)} pts`;
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
    source_url: `https://fred.stlouisfed.org/series/${o.series_id}`, sort_order: s.sort_order,
  };
}

/** Magnitude of the move in the series' threshold unit (points for rates, % for dollars and counts). */
function moveSize(o: MacroObservation): number | null {
  if (o.move !== undefined) return o.move;
  if (!o.change_text) return null;
  return Math.abs(parseFloat(o.change_text.replace(/[^\d.+-]/g, '')));
}

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
export function buildDataCard(o: MacroObservation, extra: MacroObservation[] = [], opts: { force?: boolean } = {}): PublishPayload | null {
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
    : `${o.direction} ${o.change_text!.replace(/^[+-]/, '').replace(' pts', ' points')}`;
  const value = `${o.display_value}${s.suffix ?? ''}`;

  let headline: string;
  let body: string;
  if (s.unit === 'yoy') {
    headline = `${s.noun} ${o.value >= 0 ? 'up' : 'down'} ${Math.abs(o.value).toFixed(s.decimals)}% from a year earlier ${when}`;
    body = `${s.noun}, ${s.about}, rose ${o.display_value} in the 12 months through ${MONTHS_LONG[m - 1]} ${y}, ${o.direction === 'flat' ? 'the same pace as' : `${changeWords} from`} the prior month's reading.`;
    if (o.value < 0) body = `${s.noun}, ${s.about}, fell ${Math.abs(o.value).toFixed(s.decimals)}% in the 12 months through ${MONTHS_LONG[m - 1]} ${y}.`;
  } else {
    const verb = o.direction === 'up' ? (s.plural ? 'rise to' : 'rises to')
      : o.direction === 'down' ? (s.plural ? 'fall to' : 'falls to') : 'unchanged at';
    headline = `${s.noun} ${verb} ${value}${s.frequency === 'daily' ? '' : ` ${when}`}`;
    const subject = s.plural ? s.noun : `The ${s.noun.charAt(0).toLowerCase() + s.noun.slice(1)}`;
    body = `${subject}, ${s.about}, ${s.plural ? 'were' : 'was'} ${value} ${when}, ${o.direction === 'flat' ? 'unchanged from' : `${changeWords} from`} the prior ${prior}.`;
  }
  const at = new Date(`${o.obs_date}T00:00:00Z`).toISOString();
  // In-depth detail (D-37): the value, the change, the previous value when it follows directly
  // (rates and percentages only), what the number measures, and the agency.
  const prevValue = (s.unit === 'percent' || s.unit === 'yoy') && o.change_text && o.direction !== 'flat'
    ? `${(parseFloat(o.display_value) - parseFloat(o.change_text)).toFixed(s.decimals)}%` : null;
  const subjectLower = s.plural ? s.noun : `The ${s.noun.charAt(0).toLowerCase() + s.noun.slice(1)}`;
  const reading = s.unit === 'yoy' ? `${s.noun} rose ${o.display_value} in the 12 months through ${MONTHS_LONG[m - 1]} ${y}.` : `${subjectLower} ${s.plural ? 'were' : 'was'} ${value} ${when}.`;
  const changeSentence = o.direction === 'flat'
    ? `That is unchanged from the prior ${s.unit === 'yoy' ? 'month' : prior}.`
    : `That is ${changeWords} from the prior ${s.unit === 'yoy' ? "month's reading" : prior}${prevValue ? `, when it was ${prevValue}` : ''}.`;
  const detail: CardDetail = {
    paragraphs: [
      `${reading} ${changeSentence}`,
      `What this number measures: ${s.about}.`,
      `The number comes from the ${s.agency.name}, shared through FRED.`,
    ],
    key_points: [
      `${s.label}: ${value}`,
      o.direction === 'flat' ? `Unchanged from the prior ${prior}` : `Change: ${o.change_text} from the prior ${prior}`,
      `Period: ${o.period_label ?? `${MONTHS[m - 1]} ${d}, ${y}`}`,
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
  return {
    series_id: f.series_id,
    obs_date: f.as_of.slice(0, 10),
    value: Number.isFinite(value) ? value : 0,
    display_value: f.value,
    change_text: f.change,
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
