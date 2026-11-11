// Treasury Monthly Treasury Statement (FiscalData mts_table_1) -> one template data card a month: the federal
// budget deficit or surplus for the newest month and the fiscal year so far.
// FiscalData is open ("offered free, without restriction"); the card names the Fiscal Service (rule 8).
// Inputs: API JSON text (values are strings). Outputs: MtsMonth | null and PublishPayload.
// Table layout (checked live 2026-11-11): one section per fiscal year, each with 12 month rows named "October".."September"
// and a "Year-to-Date" row; the newest record_date carries every section. dfct_sur_amt is positive for a DEFICIT.

import { config } from '../config.ts';
import type { PublishPayload } from '../types.ts';
import { buildAgencyDataCard, fmt, toNum } from './agencyData.ts';

export interface MtsMonth {
  recordDate: string; monthName: string; fiscalYear: number;
  receipts: number; outlays: number; deficit: number;          // dollars; deficit > 0 is a deficit, < 0 a surplus
  ytdDeficit: number | null; priorYearDeficit: number | null; // fiscal year to date; same month a year earlier
}

const AGENCY = 'U.S. Department of the Treasury, Fiscal Service';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function mtsUrl(now: Date): string {
  const m = config.agency.mts;
  const from = new Date(now.getTime() - m.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  return `${config.fiscalData.base}${m.path}?sort=-record_date,print_order_nbr&page[size]=${m.pageSize}&filter=record_date:gte:${from}`;
}

/** JSON -> the newest month, or null when the table has no usable month yet. */
export function parseMts(json: string): MtsMonth | null {
  const rows = ((JSON.parse(json) as { data?: Record<string, string>[] }).data ?? []).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.record_date ?? ''));
  if (!rows.length) return null;
  const recordDate = rows.map((r) => r.record_date).sort().at(-1)!;
  const sections = rows.filter((r) => r.record_date === recordDate).sort((a, b) => Number(a.print_order_nbr) - Number(b.print_order_nbr));
  const mm = Number(recordDate.slice(5, 7)), cy = Number(recordDate.slice(0, 4));
  const monthName = MONTH_NAMES[mm - 1];
  const months = sections.filter((r) => r.classification_desc === monthName);
  const ytd = sections.filter((r) => r.classification_desc === 'Year-to-Date');
  const cur = months.at(-1);
  if (!cur) return null;
  const receipts = toNum(cur.current_month_gross_rcpt_amt), outlays = toNum(cur.current_month_gross_outly_amt), deficit = toNum(cur.current_month_dfct_sur_amt);
  if (receipts === null || outlays === null || deficit === null) return null;
  return {
    recordDate, monthName, fiscalYear: mm >= 10 ? cy + 1 : cy,       // the fiscal year starts in October
    receipts, outlays, deficit,
    ytdDeficit: toNum(ytd.at(-1)?.current_month_dfct_sur_amt),
    priorYearDeficit: months.length > 1 ? toNum(months[0].current_month_dfct_sur_amt) : null,
  };
}

const money = (n: number): string => (Math.abs(n) >= 1e12 ? `$${fmt(Math.abs(n) / 1e12, 2)} trillion` : `$${fmt(Math.abs(n) / 1e9, 1)} billion`);
const word = (n: number): string => (n >= 0 ? 'deficit' : 'surplus');

export function mtsCard(m: MtsMonth): PublishPayload {
  const headline = `Federal government runs a ${money(m.deficit)} ${word(m.deficit)} in ${m.monthName}`;
  const year = Number(m.recordDate.slice(0, 4));
  const prior = m.priorYearDeficit !== null ? ` A year earlier it was a ${money(m.priorYearDeficit)} ${word(m.priorYearDeficit)}.` : '';
  const ytd = m.ytdDeficit !== null ? ` For fiscal year ${m.fiscalYear} so far the ${word(m.ytdDeficit)} is ${money(m.ytdDeficit)}.` : '';
  const body = `The federal government spent ${money(m.outlays)} and collected ${money(m.receipts)} in ${m.monthName} ${year}, a ${word(m.deficit)} of ${money(m.deficit)}, the Treasury's Monthly Treasury Statement shows.${prior}${ytd}`;
  const at = new Date(`${m.recordDate}T20:00:00Z`).toISOString();
  return buildAgencyDataCard({
    dedupeKey: `MTS_BUDGET:${m.recordDate}`, headline, body, category: 'economy', asOf: at,
    agencyName: AGENCY, agencyUrl: 'https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/', docLabel: 'Monthly Treasury Statement',
    attribution: config.agency.mts.attribution,
    paragraphs: [
      body,
      'What this number measures: the gap between what the federal government collects in taxes and other receipts and what it spends in a month. A deficit adds to the national debt; a surplus does not.',
      'The numbers come from the U.S. Department of the Treasury, Fiscal Service.',
    ],
    keyPoints: [
      `Receipts: ${money(m.receipts)}`, `Outlays: ${money(m.outlays)}`, `${m.deficit >= 0 ? 'Deficit' : 'Surplus'}: ${money(m.deficit)}`,
      ...(m.ytdDeficit !== null ? [`Fiscal year ${m.fiscalYear} to date: ${money(m.ytdDeficit)} ${word(m.ytdDeficit)}`] : []),
      `Month: ${m.monthName} ${year}`, `Source: ${AGENCY}`,
    ],
  });
}
