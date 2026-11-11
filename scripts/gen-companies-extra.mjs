// Writes contract/companiesExtra.ts (the extended SEC watch list: large caps beyond the household-name directory)
// and the trimmed SEC snapshot ingest/src/fixtures/sec-company-tickers-extra.json from:
//   scripts/sec-extra-list.json   ticker -> sector/industry (hand-assigned groups)
//   SEC company_tickers_exchange.json   (read-only download, public domain; pass its path as argv[2])
// Tickers missing from the SEC file, not on NYSE/Nasdaq, or sharing a CIK with an earlier entry are dropped and listed.
// Usage: node scripts/gen-companies-extra.mjs <path-to-company_tickers_exchange.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANIES } from '../contract/companies.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const secPath = process.argv[2];
if (!secPath) { console.error('usage: node scripts/gen-companies-extra.mjs <company_tickers_exchange.json>'); process.exit(1); }
const sec = JSON.parse(readFileSync(secPath, 'utf8'));
const list = JSON.parse(readFileSync(join(root, 'scripts/sec-extra-list.json'), 'utf8'));
const f = (n) => sec.fields.indexOf(n);
const rows = new Map();
for (const r of sec.data) { const t = String(r[f('ticker')]).toUpperCase(); if (!rows.has(t)) rows.set(t, r); }

const KEEP_UPPER = new Set(['LLC', 'LP', 'PLC', 'NV', 'SA', 'AG', 'SE', 'II', 'III', 'IV', 'USA', 'US', 'REIT', 'ETF', 'AT&T', 'IBM', 'CBOE', 'CME', 'ADP', 'PPG', 'HP', 'AES', 'NRG', 'TKO', 'CBRE', 'KKR', 'APA', 'EQT', 'FIS', 'CDW', 'EPAM', 'UDR', 'ON', 'IQVIA']);
const title = (raw) => {
  const n = raw.replace(/\s+\/[A-Z]{2,5}\/?\s*$/g, '').replace(/\s*\/[A-Za-z]{0,3}\/?$/, '').trim();
  if (n !== n.toUpperCase()) return n;
  return n.toLowerCase().split(/\s+/).map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
};
const short = (name) => name.replace(/[,.]/g, '').replace(/\b(Inc|Corp|Corporation|Co|Company|Ltd|Holdings|Holding|Group|PLC|Plc|LLC|LP|NV|SA|The|Cos|Companies|International|Incorporated)\b\.?/g, ' ').replace(/\s+/g, ' ').trim() || name;

// [name, short] where SEC's spelling title-cases badly.
const OVERRIDES = {
  AOS: ['A. O. Smith Corp', 'A. O. Smith'], DHI: ['D.R. Horton, Inc.', 'D.R. Horton'], JBHT: ['J.B. Hunt Transport Services, Inc.', 'J.B. Hunt'],
  AIG: ['American International Group, Inc.', 'AIG'], IP: ['International Paper Co', 'International Paper'], AJG: ['Arthur J. Gallagher & Co.', 'Gallagher'],
  KKR: ['KKR & Co. Inc.', 'KKR'], BDX: ['Becton, Dickinson and Co', 'BD'], MKC: ['McCormick & Co Inc', 'McCormick'], GWW: ['W.W. Grainger, Inc.', 'Grainger'],
  COP: ['ConocoPhillips', 'ConocoPhillips'], EOG: ['EOG Resources Inc', 'EOG Resources'], DUK: ['Duke Energy Corp', 'Duke Energy'], ETN: ['Eaton Corp plc', 'Eaton'],
  CARR: ['Carrier Global Corp', 'Carrier'], NEM: ['Newmont Corp', 'Newmont'], BALL: ['Ball Corp', 'Ball'], CMS: ['CMS Energy Corp', 'CMS Energy'], DTE: ['DTE Energy Co', 'DTE Energy'],
  CSX: ['CSX Corp', 'CSX'], LKQ: ['LKQ Corp', 'LKQ'], NVR: ['NVR Inc', 'NVR'], KEY: ['KeyCorp', 'KeyCorp'], MTB: ['M&T Bank Corp', 'M&T Bank'], LHX: ['L3Harris Technologies, Inc.', 'L3Harris'],
  CPB: ["Campbell's Co", "Campbell's"], 'BF-B': ['Brown-Forman Corp', 'Brown-Forman'], ADP: ['Automatic Data Processing Inc', 'ADP'], AES: ['AES Corp', 'AES'], IFF: ['International Flavors & Fragrances Inc', 'IFF'],
  DOV: ['Dover Corp', 'Dover'], MTD: ['Mettler-Toledo International Inc', 'Mettler-Toledo'], DVN: ['Devon Energy Corp', 'Devon Energy'], CFG: ['Citizens Financial Group Inc', 'Citizens Financial'], AME: ['Ametek Inc', 'Ametek'],
  NWSA: ['News Corp', 'News Corp'], FOXA: ['Fox Corp', 'Fox Corporation'], EL: ['Estee Lauder Companies Inc', 'Estee Lauder'], DD: ['DuPont de Nemours, Inc.', 'DuPont'], WTW: ['Willis Towers Watson plc', 'WTW'],
  EXPD: ['Expeditors International of Washington Inc', 'Expeditors'], JCI: ['Johnson Controls International plc', 'Johnson Controls'], FIS: ['Fidelity National Information Services, Inc.', 'FIS'],
  KMB: ['Kimberly-Clark Corp', 'Kimberly-Clark'], CL: ['Colgate-Palmolive Co', 'Colgate-Palmolive'], FCX: ['Freeport-McMoRan Inc', 'Freeport-McMoRan'], MRSH: ['Marsh & McLennan Companies, Inc.', 'Marsh McLennan'],
  BEN: ['Franklin Resources Inc', 'Franklin Templeton'], HIG: ['Hartford Insurance Group, Inc.', 'The Hartford'], IT: ['Gartner Inc', 'Gartner'], LIN: ['Linde plc', 'Linde'], NEE: ['NextEra Energy Inc', 'NextEra Energy'],
  CSGP: ['CoStar Group, Inc.', 'CoStar'], HPQ: ['HP Inc', 'HP'], GLW: ['Corning Inc', 'Corning'], APP: ['AppLovin Corp', 'AppLovin'], MCK: ['McKesson Corp', 'McKesson'], KMX: ['CarMax Inc', 'CarMax'],
  ED: ['Consolidated Edison Inc', 'Con Edison'], EIX: ['Edison International', 'Edison International'], EG: ['Everest Group, Ltd.', 'Everest'], AMCR: ['Amcor plc', 'Amcor'], ACN: ['Accenture plc', 'Accenture'],
  SJM: ['J.M. Smucker Co', 'Smucker'], TROW: ['T. Rowe Price Group Inc', 'T. Rowe Price'], WRB: ['W. R. Berkley Corp', 'W. R. Berkley'], PHM: ['PulteGroup Inc', 'PulteGroup'], VLO: ['Valero Energy Corp', 'Valero'],
  VRTX: ['Vertex Pharmaceuticals Inc', 'Vertex'], SLB: ['SLB Ltd', 'SLB'], SBAC: ['SBA Communications Corp', 'SBA Communications'], PTC: ['PTC Inc.', 'PTC'], PKG: ['Packaging Corp of America', 'Packaging Corp.'],
  WEC: ['WEC Energy Group, Inc.', 'WEC Energy'], RMD: ['ResMed Inc', 'ResMed'], WMB: ['Williams Companies, Inc.', 'Williams'], TDG: ['TransDigm Group Inc', 'TransDigm'], TRV: ['Travelers Companies, Inc.', 'Travelers'],
  PNR: ['Pentair plc', 'Pentair'], STE: ['STERIS plc', 'STERIS'], TEL: ['TE Connectivity plc', 'TE Connectivity'], TT: ['Trane Technologies plc', 'Trane'], SW: ['Smurfit Westrock plc', 'Smurfit Westrock'],
  MDT: ['Medtronic plc', 'Medtronic'], PM: ['Philip Morris International Inc.', 'Philip Morris'], GEHC: ['GE HealthCare Technologies Inc.', 'GE HealthCare'], STX: ['Seagate Technology Holdings plc', 'Seagate'],
  TKO: ['TKO Group Holdings, Inc.', 'TKO'], VMC: ['Vulcan Materials Co', 'Vulcan'], };
const existing = new Set(COMPANIES.map((c) => c.ticker));
const seenCik = new Set(COMPANIES.map((c) => {
  const r = rows.get(c.ticker); return r ? String(r[f('cik')]).padStart(10, '0') : '';
}));
const out = [];
const dropped = [];
for (const [sector, industry, tickers] of list.groups) {
  for (const t of tickers.split(/\s+/)) {
    if (existing.has(t)) { dropped.push(`${t} (already in directory)`); continue; }
    const r = rows.get(t);
    if (!r) { dropped.push(`${t} (not in SEC list)`); continue; }
    const exch = String(r[f('exchange')] ?? '');
    if (!['Nasdaq', 'NYSE'].includes(exch)) { dropped.push(`${t} (exchange ${exch || 'none'})`); continue; }
    const cik = String(r[f('cik')]).padStart(10, '0');
    if (seenCik.has(cik)) { dropped.push(`${t} (CIK ${cik} already listed)`); continue; }
    seenCik.add(cik);
    const ov = OVERRIDES[t];
    const name = ov ? ov[0] : title(String(r[f('name')]));
    out.push({ ticker: t, cik, exchange: exch, name: name.slice(0, 80), short: (ov ? ov[1] : short(name)).replace(/\s*&$/, '').slice(0, 40), sector, industry });
  }
}
out.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
const body = out.map((e) => `  c(${JSON.stringify(e.ticker)}, ${JSON.stringify(e.cik)}, ${JSON.stringify(e.exchange)}, ${JSON.stringify(e.name)}, ${JSON.stringify(e.short)}, ${JSON.stringify(e.sector)}, ${JSON.stringify(e.industry)}),`).join('\n');
writeFileSync(join(root, 'contract/companiesExtra.ts'), `// Extended SEC watch list: large US-listed companies beyond the household-name directory (contract/companies.ts).
// GENERATED by scripts/gen-companies-extra.mjs from scripts/sec-extra-list.json and SEC's company_tickers_exchange.json
// (public domain): tickers, CIKs and exchanges are as SEC lists them. Do not edit by hand; edit the list and re-run.
//
// These companies get SEC 8-K cards and a core.companies row (company page, search by name or ticker), but no name
// aliases: a card is tagged to them only through its filing or an explicit ticker ("NYSE: XYZ", "$XYZ"), never by a
// name appearing in text. That keeps the false-positive risk of ~300 more names at zero. Migration:
// supabase/migrations/20261136000000_companies_extra.sql (generated from this file by scripts/gen-companies-sql.mjs).
// No prices, ever (rule 9).

import type { CompanySector } from './companies.ts';

export interface ExtraCompany {
  ticker: string;            // upper case ("BF-B")
  cik: string;               // 10 digits, as SEC lists it
  exchange: 'Nasdaq' | 'NYSE';
  name: string;
  short: string;
  sector: CompanySector;
  industry: string;
}

function c(ticker: string, cik: string, exchange: ExtraCompany['exchange'], name: string, short: string, sector: CompanySector, industry: string): ExtraCompany {
  return { ticker, cik, exchange, name, short, sector, industry };
}

export const COMPANIES_EXTRA: ExtraCompany[] = [
${body}
];
`);
const snap = { _comment: 'Rows of SEC company_tickers_exchange.json for the extended watch list (contract/companiesExtra.ts), fetched read-only; written by scripts/gen-companies-extra.mjs.', fields: sec.fields, data: out.map((e) => { const r = rows.get(e.ticker); return r; }) };
writeFileSync(join(root, 'ingest/src/fixtures/sec-company-tickers-extra.json'), JSON.stringify(snap, null, 1).replace(/\n\s+(\[|\d|")/g, ' $1').replace(/\n\s+\]/g, ' ]') + '\n');
console.log(`extra companies: ${out.length}; dropped ${dropped.length}: ${dropped.join('; ')}`);
