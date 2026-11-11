// Writes the generated blocks of the company migration and its SQL check from the shared sources:
//   contract/companies.ts                          -> core.companies seed in 20261115000000_companies.sql
//   contract/fixtures/company_tagging_cases.json   -> the cases in supabase/tests/companies_check.sql
// CIKs and exchanges come from ingest/src/fixtures/sec-company-tickers-watch.json (SEC company_tickers_exchange
// rows, public domain). Usage: node scripts/gen-companies-sql.mjs   (Node 23.6+ runs the .ts imports as is)
// No network. ingest/test/companies.test.ts checks the files are in sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES_BEGIN, CASES_END, SEED_BEGIN, SEED_END, companiesSeedSql, replaceBlock, taggingCasesSql } from '../contract/companiesSql.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

const sec = JSON.parse(read('ingest/src/fixtures/sec-company-tickers-watch.json'));
const cases = JSON.parse(read('contract/fixtures/company_tagging_cases.json')).cases;

const mig = 'supabase/migrations/20261115000000_companies.sql';
writeFileSync(join(root, mig), replaceBlock(read(mig), SEED_BEGIN, SEED_END, companiesSeedSql(sec)));
const check = 'supabase/tests/companies_check.sql';
writeFileSync(join(root, check), replaceBlock(read(check), CASES_BEGIN, CASES_END, taggingCasesSql(cases)));
console.log(`gen-companies-sql: wrote the seed into ${mig} and ${cases.length} cases into ${check}`);

// Extended SEC watch list (contract/companiesExtra.ts) -> supabase/migrations/20261136000000_companies_extra.sql
import { EXTRA_BEGIN, EXTRA_END, extraCompaniesSeedSql } from '../contract/companiesSql.ts';
const extraMig = 'supabase/migrations/20261136000000_companies_extra.sql';
writeFileSync(join(root, extraMig), replaceBlock(read(extraMig), EXTRA_BEGIN, EXTRA_END, extraCompaniesSeedSql()));
console.log(`gen-companies-sql: wrote the extended seed into ${extraMig}`);
