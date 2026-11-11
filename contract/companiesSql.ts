// SQL text generated from the company directory (contract/companies.ts) and the shared tagging cases
// (contract/fixtures/company_tagging_cases.json). scripts/gen-companies-sql.mjs writes it between the
// GENERATED markers of supabase/migrations/20261115000000_companies.sql and
// supabase/tests/companies_check.sql; ingest/test/companies.test.ts fails if either file drifts.
// Pure: no file or network access here.

import { COMPANIES, tickerInText, type CompanyEntry } from './companies.ts';
import { BUSINESS_WORDS } from './companyMatch.ts';
import { COMPANIES_EXTRA, type ExtraCompany } from './companiesExtra.ts';

export const SEED_BEGIN = '-- BEGIN GENERATED COMPANY SEED (scripts/gen-companies-sql.mjs; do not edit by hand)';
export const SEED_END = '-- END GENERATED COMPANY SEED';
export const CASES_BEGIN = '-- BEGIN GENERATED TAGGING CASES (scripts/gen-companies-sql.mjs; do not edit by hand)';
export const CASES_END = '-- END GENERATED TAGGING CASES';

const lit = (s: string | null | undefined) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const arr = (xs: readonly string[] | undefined) => (xs && xs.length ? `array[${xs.map(lit).join(', ')}]` : `'{}'::text[]`);

export interface SecTickerDoc { fields: string[]; data: unknown[][] }

/** ticker -> {cik, exchange} from SEC's company_tickers_exchange.json (first row per ticker wins). */
export function secLookup(doc: SecTickerDoc): Map<string, { cik: string; exchange: string | null }> {
  const f = (n: string) => doc.fields.indexOf(n);
  const [ci, ti, ei] = [f('cik'), f('ticker'), f('exchange')];
  const out = new Map<string, { cik: string; exchange: string | null }>();
  for (const row of doc.data) {
    const t = String(row[ti] ?? '').toUpperCase();
    if (t && !out.has(t)) out.set(t, { cik: String(row[ci]).padStart(10, '0'), exchange: row[ei] ? String(row[ei]) : null });
  }
  return out;
}

/** One idempotent insert for the whole directory (re-running it updates names, aliases and categories). */
export function companiesSeedSql(doc: SecTickerDoc, entries: readonly CompanyEntry[] = COMPANIES): string {
  const sec = secLookup(doc);
  const rows = entries.map((e) => {
    const s = sec.get(e.ticker) ?? null;
    return `  (${[lit(e.ticker), lit(e.name), lit(e.short), lit(s?.cik), lit(s?.exchange), lit(e.sector), lit(e.industry),
      arr(e.aliases), arr(e.context), arr(e.cues), arr(e.negatives), tickerInText(e) ? 'true' : 'false'].join(', ')})`;
  });
  return [
    SEED_BEGIN,
    '-- Business words that let an ambiguous name count (BUSINESS_WORDS in contract/companyMatch.ts).',
    'create or replace function core.company_biz_re()',
    "returns text language sql immutable set search_path = '' as $$",
    `  select '(^|[^A-Za-z0-9])' || core.company_alt(${arr(BUSINESS_WORDS)}) || '($|[^A-Za-z0-9])'`,
    '$$;',
    '',
    'insert into core.companies (ticker, name, short_name, cik, exchange, sector, industry, aliases, context_aliases, cues, negatives, ticker_in_text) values',
    rows.join(',\n'),
    'on conflict (ticker) do update set',
    '  name = excluded.name, short_name = excluded.short_name, cik = coalesce(excluded.cik, core.companies.cik),',
    '  exchange = coalesce(excluded.exchange, core.companies.exchange), sector = excluded.sector, industry = excluded.industry,',
    '  aliases = excluded.aliases, context_aliases = excluded.context_aliases, cues = excluded.cues, negatives = excluded.negatives,',
    '  ticker_in_text = excluded.ticker_in_text, updated_at = now();',
    SEED_END,
  ].join('\n');
}

export interface TaggingCase {
  name: string; headline: string; body?: string; tickers?: string[]; filing?: boolean; expect: string[]; methods?: string[];
}

/** The cases as a VALUES list for the SQL check: (name, headline, body, tickers, filing, expect, methods). */
export function taggingCasesSql(cases: readonly TaggingCase[]): string {
  const rows = cases.map((c) => `  (${[lit(c.name), lit(c.headline), lit(c.body ?? ''), arr(c.tickers), c.filing ? 'true' : 'false',
    lit(c.expect.join(',')), lit((c.methods ?? []).join(','))].join(', ')})`);
  return [CASES_BEGIN, 'insert into pg_temp.tag_cases (name, headline, body, tickers, filing, expect, methods) values', `${rows.join(',\n')};`, CASES_END].join('\n');
}

/** Replaces the text between `begin` and `end` (markers included) in `file`. Throws if a marker is missing. */
export function replaceBlock(file: string, begin: string, end: string, block: string): string {
  const i = file.indexOf(begin), j = file.indexOf(end);
  if (i < 0 || j < i) throw new Error(`markers not found: ${begin}`);
  return file.slice(0, i) + block + file.slice(j + end.length);
}

/** The text between the markers (included), or null. */
export function readBlock(file: string, begin: string, end: string): string | null {
  const i = file.indexOf(begin), j = file.indexOf(end);
  return i < 0 || j < i ? null : file.slice(i, j + end.length);
}

export const EXTRA_BEGIN = '-- BEGIN GENERATED EXTRA COMPANY SEED (scripts/gen-companies-sql.mjs; do not edit by hand)';
export const EXTRA_END = '-- END GENERATED EXTRA COMPANY SEED';

/**
 * Seed for the extended SEC watch list (contract/companiesExtra.ts): name-less directory rows (no aliases, no cues,
 * no bare ticker match), so they are found by search and tagged through filings or "NYSE: XYZ" style tickers only.
 * Idempotent: re-running updates names, categories and CIKs.
 */
export function extraCompaniesSeedSql(entries: readonly ExtraCompany[] = COMPANIES_EXTRA): string {
  const rows = entries.map((e) => `  (${[lit(e.ticker), lit(e.name), lit(e.short), lit(e.cik), lit(e.exchange), lit(e.sector), lit(e.industry)].join(', ')})`);
  return [
    EXTRA_BEGIN,
    'insert into core.companies (ticker, name, short_name, cik, exchange, sector, industry) values',
    rows.join(',\n'),
    'on conflict (ticker) do update set',
    '  name = excluded.name, short_name = excluded.short_name, cik = excluded.cik, exchange = excluded.exchange,',
    '  sector = excluded.sector, industry = excluded.industry;',
    EXTRA_END,
  ].join('\n');
}
