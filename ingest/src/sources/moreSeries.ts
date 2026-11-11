// M9c: 16 more FRED series for the macro data-card path (macro.ts). Spread into SERIES there.
// All are US federal statistics republished by FRED; each series' FRED notes were checked on 2026-11-11 and none carries
// a "Copyright" line (docs/work/sources-fred-more.md). Cards cite the original agency by name plus "via FRED" (rule 8).
// Never add a series whose FRED notes say "Copyright" (MORTGAGE30US and MORTGAGE15US: Freddie Mac; see config.forbiddenSeries).
// Inputs: none. Outputs: MORE_SERIES (SeriesInfo), MORE_WHY (hand-written explainer lines).

import type { SeriesInfo } from './macro.ts';

const FED_NAME = 'Board of Governors of the Federal Reserve System (US) via FRED';
const BLS_NAME = 'U.S. Bureau of Labor Statistics via FRED';
const BEA_NAME = 'U.S. Bureau of Economic Analysis via FRED';
const CENSUS_NAME = 'U.S. Census Bureau via FRED';
const DOL_NAME = 'U.S. Employment and Training Administration via FRED';
const FED = 'Federal Reserve Board';
const BLS = 'U.S. Bureau of Labor Statistics';
const BEA = 'U.S. Bureau of Economic Analysis';
const CENSUS = 'U.S. Census Bureau';
const G17 = { name: FED, url: 'https://www.federalreserve.gov/releases/g17/current/', doc_label: 'G.17 Industrial Production and Capacity Utilization' };

export const MORE_SERIES: Record<string, SeriesInfo> = {
  // ---- Labor (Labor Department, BLS) ----
  CCSA: { label: 'Continued jobless claims', noun: 'Continuing jobless claims', about: 'the number of people still receiving unemployment benefits after their first week', plural: true, unit: 'number', decimals: 2, frequency: 'weekly', week: 'week ending', category: 'economy',
    source_name: DOL_NAME, source_short: 'Dept. of Labor via FRED', sort_order: 70, agency: { name: 'U.S. Department of Labor', url: 'https://oui.doleta.gov/unemploy/claims.asp', doc_label: 'Unemployment Insurance Weekly Claims' } },
  CIVPART: { label: 'Labor force participation', noun: 'Labor force participation rate', about: 'the share of adults who are working or looking for work', unit: 'percent', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BLS_NAME, source_short: 'BLS via FRED', sort_order: 71, agency: { name: BLS, url: 'https://www.bls.gov/news.release/empsit.nr0.htm', doc_label: 'Employment Situation' } },
  U6RATE: { label: 'Broad unemployment (U-6)', noun: 'Broad unemployment rate (U-6)', about: 'unemployed people plus those who gave up looking and those stuck in part-time work, as a share of the labor force', unit: 'percent', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BLS_NAME, source_short: 'BLS via FRED', sort_order: 72, agency: { name: BLS, url: 'https://www.bls.gov/news.release/empsit.t15.htm', doc_label: 'Employment Situation, alternative measures' } },
  // ---- Prices (BLS, BEA) ----
  CPILFESL: { label: 'Core CPI (yearly)', noun: 'Core consumer prices', about: 'everyday prices without food and energy, which swing a lot', plural: true, unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BLS_NAME, source_short: 'BLS via FRED', sort_order: 73, agency: { name: BLS, url: 'https://www.bls.gov/cpi/', doc_label: 'CPI' } },
  PPIFIS: { label: 'Producer prices (yearly)', noun: 'Producer prices', about: 'the prices businesses receive for what they sell, before it reaches shoppers', plural: true, unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BLS_NAME, source_short: 'BLS via FRED', sort_order: 74, agency: { name: BLS, url: 'https://www.bls.gov/ppi/', doc_label: 'Producer Price Index' } },
  PCEPI: { label: 'PCE inflation (yearly)', noun: 'PCE inflation', about: 'the yearly rise in prices households pay, the gauge the Federal Reserve uses for its 2% goal', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BEA_NAME, source_short: 'BEA via FRED', sort_order: 75, agency: { name: BEA, url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index', doc_label: 'PCE price index' } },
  PCEPILFE: { label: 'Core PCE inflation (yearly)', noun: 'Core PCE inflation', about: 'the same price gauge without food and energy, which swing a lot from month to month', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BEA_NAME, source_short: 'BEA via FRED', sort_order: 76, agency: { name: BEA, url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy', doc_label: 'Core PCE price index' } },
  PSAVERT: { label: 'Personal saving rate', noun: 'Personal saving rate', about: 'the share of after-tax income households put aside instead of spending', unit: 'percent', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: BEA_NAME, source_short: 'BEA via FRED', sort_order: 77, agency: { name: BEA, url: 'https://www.bea.gov/data/income-saving/personal-saving-rate', doc_label: 'Personal saving rate' } },
  // ---- Federal Reserve (G.17 industrial production, G.19 consumer credit, H.4.1 balance sheet, H.6 money supply) ----
  INDPRO: { label: 'Industrial production (yearly)', noun: 'Industrial production', about: 'the output of U.S. factories, mines and utilities', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: FED_NAME, source_short: 'Federal Reserve via FRED', sort_order: 78, agency: G17 },
  TCU: { label: 'Capacity utilization', noun: 'Capacity utilization', about: 'how much of U.S. factory, mine and utility capacity is in use', unit: 'percent', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: FED_NAME, source_short: 'Federal Reserve via FRED', sort_order: 79, agency: G17 },
  TOTALSL: { label: 'Consumer credit', noun: 'Consumer credit', about: 'what Americans owe on credit cards, car loans and student loans, not counting mortgages', unit: 'usd', decimals: 2, scale: 1e6, frequency: 'monthly', category: 'economy',
    source_name: FED_NAME, source_short: 'Federal Reserve via FRED', sort_order: 80, agency: { name: FED, url: 'https://www.federalreserve.gov/releases/g19/current/', doc_label: 'G.19 Consumer Credit' } },
  WALCL: { label: 'Fed balance sheet', noun: 'Federal Reserve total assets', about: 'everything the Federal Reserve holds, mostly Treasury and mortgage bonds', plural: true, unit: 'usd', decimals: 2, scale: 1e6, frequency: 'weekly', week: 'week ending', category: 'economy',
    source_name: FED_NAME, source_short: 'Federal Reserve via FRED', sort_order: 81, agency: { name: FED, url: 'https://www.federalreserve.gov/releases/h41/current/', doc_label: 'H.4.1 Factors Affecting Reserve Balances' } },
  M2SL: { label: 'Money supply M2 (yearly)', noun: 'M2 money supply', about: 'cash, checking and savings deposits and similar money held by households and businesses', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy',
    source_name: FED_NAME, source_short: 'Federal Reserve via FRED', sort_order: 82, agency: { name: FED, url: 'https://www.federalreserve.gov/releases/h6/current/', doc_label: 'H.6 Money Stock Measures' } },
  // ---- Housing and orders (Census, with HUD for permits and new home sales) ----
  PERMIT: { label: 'Building permits', noun: 'Building permits', about: 'the number of new homes cities and counties approved for construction', plural: true, unit: 'number', decimals: 2, scale: 1e3, suffix: ' (annual rate)', frequency: 'monthly', category: 'economy',
    source_name: CENSUS_NAME, source_short: 'Census via FRED', sort_order: 83, agency: { name: CENSUS, url: 'https://www.census.gov/construction/nrc/index.html', doc_label: 'New Residential Construction' } },
  HSN1F: { label: 'New home sales', noun: 'New home sales', about: 'the number of newly built single-family homes sold', plural: true, unit: 'number', decimals: 0, scale: 1e3, suffix: ' (annual rate)', frequency: 'monthly', category: 'economy',
    source_name: CENSUS_NAME, source_short: 'Census via FRED', sort_order: 84, agency: { name: CENSUS, url: 'https://www.census.gov/construction/nrs/index.html', doc_label: 'New Residential Sales' } },
  DGORDER: { label: 'Durable goods orders', noun: 'Durable goods orders', about: 'new orders for long-lasting factory goods such as machinery, cars and aircraft', plural: true, unit: 'usd', decimals: 1, scale: 1e6, frequency: 'monthly', category: 'economy',
    source_name: CENSUS_NAME, source_short: 'Census via FRED', sort_order: 85, agency: { name: CENSUS, url: 'https://www.census.gov/manufacturing/m3/index.html', doc_label: 'Manufacturers Shipments, Inventories, and Orders' } },
};

/** One hand-written line per series: how the number is defined or used. No claim about what a reading will cause. */
export const MORE_WHY: Record<string, string> = {
  CCSA: 'It counts people who filed a claim at least a week ago and are still receiving benefits, so it shows how long job seekers stay out of work.',
  CIVPART: 'It does not count people who have stopped looking, so it can fall even when the unemployment rate does not rise.',
  U6RATE: 'It is a wider measure than the headline unemployment rate and is always higher than it.',
  CPILFESL: 'Economists watch it because food and energy prices jump around, and this version shows the steadier trend.',
  PPIFIS: 'Producer prices are what businesses get paid, so they can show cost pressure before it reaches store shelves.',
  PCEPI: 'The Federal Reserve aims for 2% inflation as measured by this index, not by CPI.',
  PCEPILFE: 'This is the version of the index the Federal Reserve watches most closely, because food and energy prices swing a lot.',
  PSAVERT: 'It shows how much of their income households keep rather than spend.',
  INDPRO: 'Factories, mines and utilities are a smaller part of the economy than services, but their output swings more.',
  TCU: 'A high rate means factories have little spare room to produce more; a low rate means there is slack.',
  TOTALSL: 'It includes credit cards and auto and student loans, and leaves out home mortgages.',
  WALCL: 'The Fed buys bonds to add to this total and lets bonds mature to shrink it.',
  M2SL: 'It is a broad count of the money people and businesses hold in accounts.',
  PERMIT: 'A permit is approval to build, so permits come before housing starts.',
  HSN1F: 'It counts sales of newly built single-family homes, not resales of existing homes.',
  DGORDER: 'Durable goods are items built to last three years or more, and orders show how much new demand factories are seeing.',
};
