// Series definitions for the BLS and BEA direct-API sources (bls.ts, beadata.ts). Spread into SERIES in macro.ts.
// Each entry cites the original agency by name (rule 8, never FRED) and links its agency page on the data card.
// Both agencies are US federal statistical agencies; licence class public_domain (see docs/work/sources-bls-bea.md).
// None of these appears in the Numbers panel (in_numbers false in the cron migration).

import type { SeriesInfo } from './macro.ts';

const BLS = 'U.S. Bureau of Labor Statistics';
const BEA = 'U.S. Bureau of Economic Analysis';

export const AGENCY_SERIES: Record<string, SeriesInfo> = {
  BLS_AHE: { label: 'Hourly earnings (yearly)', noun: 'Average hourly earnings', about: 'what the typical private-sector worker earns per hour, before taxes', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy', provider: 'bls',
    source_name: BLS, source_short: 'BLS', sort_order: 60, agency: { name: BLS, url: 'https://www.bls.gov/news.release/empsit.nr0.htm', doc_label: 'Employment Situation' } },
  BLS_ECI: { label: 'Employment costs (yearly)', noun: 'Employer labor costs', about: 'the yearly rise in what employers pay for wages and benefits, from the Employment Cost Index', plural: true, unit: 'percent', decimals: 1, suffix: ' (yearly change)', frequency: 'quarterly', category: 'economy', provider: 'bls',
    source_name: BLS, source_short: 'BLS', sort_order: 61, agency: { name: BLS, url: 'https://www.bls.gov/eci/', doc_label: 'Employment Cost Index' } },
  BLS_JOLTS: { label: 'Job openings', noun: 'Job openings', about: 'the number of unfilled jobs that employers are trying to fill', plural: true, unit: 'number', decimals: 2, scale: 1e3, frequency: 'monthly', category: 'economy', provider: 'bls',
    source_name: BLS, source_short: 'BLS', sort_order: 62, agency: { name: BLS, url: 'https://www.bls.gov/jlt/', doc_label: 'Job Openings and Labor Turnover Survey' } },
  BEA_PCE_YOY: { label: 'PCE inflation (yearly)', noun: 'PCE inflation', about: 'the yearly rise in prices households pay, the gauge the Federal Reserve uses for its 2% goal', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy', provider: 'bea',
    source_name: BEA, source_short: 'BEA', sort_order: 63, agency: { name: BEA, url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index', doc_label: 'PCE price index' } },
  BEA_CORE_PCE_YOY: { label: 'Core PCE inflation (yearly)', noun: 'Core PCE inflation', about: 'the same price gauge without food and energy, which swing a lot from month to month', unit: 'yoy', decimals: 1, frequency: 'monthly', category: 'economy', provider: 'bea',
    source_name: BEA, source_short: 'BEA', sort_order: 64, agency: { name: BEA, url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index-excluding-food-and-energy', doc_label: 'Core PCE price index' } },
  BEA_PERSONAL_INCOME: { label: 'Personal income', noun: 'Personal income', about: 'the total income Americans receive from wages, investments and benefits, at a yearly rate', unit: 'usd', decimals: 2, suffix: ' (annual rate)', frequency: 'monthly', category: 'economy', provider: 'bea',
    source_name: BEA, source_short: 'BEA', sort_order: 65, agency: { name: BEA, url: 'https://www.bea.gov/data/income-saving/personal-income', doc_label: 'Personal income' } },
  BEA_GDP: { label: 'GDP (dollars)', noun: 'U.S. GDP', about: 'the total value of everything the U.S. economy produces, at a yearly rate', unit: 'usd', decimals: 2, suffix: ' (annual rate)', frequency: 'quarterly', category: 'economy', provider: 'bea',
    source_name: BEA, source_short: 'BEA', sort_order: 66, agency: { name: BEA, url: 'https://www.bea.gov/data/gdp/gross-domestic-product', doc_label: 'Gross domestic product' } },
};
