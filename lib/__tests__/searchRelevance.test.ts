// M9c fix #3 (persona run 3): search relevance on a small pool shaped like the live one. The SQL twin is
// supabase/tests/search_v9_check.sql (20261137000200_search_v9.sql); both must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlurbCard } from '../../contract/types.ts';
import { rankSearch, searchTerms } from '../search/searchLogic.ts';
import { card, dataCard, fact, NOW } from './helpers.ts';

const none = { tickers: [] as BlurbCard['tickers'] };
const form4 = (id: string, headline: string, body: string) =>
  card({ id, headline, body, event_type: 'insider', category: 'earnings', ...none, sources: [{ ...card().sources[0], doc_label: 'Form 4' }] });
const pool: BlurbCard[] = [
  dataCard({ id: 'cpi', headline: 'Consumer prices rise 3.2% in September', body: 'The consumer price index was up 3.2% from a year earlier.', macro: [fact({ series_id: 'CPIAUCSL', label: 'CPI', value: '3.2%' })] }),
  dataCard({ id: 'gdp', headline: 'Economy grew 2.1% in the third quarter', body: 'Gross domestic product rose 2.1%.', macro: [fact({ series_id: 'GDP', label: 'GDP growth', value: '2.1%' })] }),
  dataCard({ id: 'oil', headline: 'WTI crude oil falls to $61.40 a barrel', body: 'Crude fell on weaker demand, which can lower costs at the pump.', macro: [fact({ series_id: 'DCOILWTICO', label: 'WTI crude oil', value: '$61.40' })] }),
  card({ id: 'fed', headline: 'Fed holds its benchmark rate steady', body: 'The Federal Reserve left interest rates unchanged. Banks may keep savings account yields where they are.', category: 'policy', event_type: 'fed', ...none }),
  card({ id: 'bank', headline: 'Adatum Bank quarterly profit rises on higher lending income', body: 'Net interest income grew as loan balances increased.', category: 'earnings', ...none }),
  card({ id: 'travel', headline: "Margie's Travel reports record bookings", body: 'Travel demand stayed strong this quarter.', category: 'earnings', ...none }),
  card({ id: 'coffee', headline: 'Fourth Coffee lowers annual sales outlook', body: 'The company said a slow economy kept customers away.', category: 'earnings', ...none }),
  form4('f4a', 'Tailspin Air director reports open-market purchase', 'A director bought shares at average prices of $12. Cost basis rose.'),
  form4('f4b', 'Fabrikam officer sells shares, Form 4 shows', 'The officer sold shares to cover taxes on gas and fuel stock awards. CPI mentioned in a footnote.'),
];
const ids = (q: string) => rankSearch(pool, q, () => NOW.getTime() / 3_600_000, { nowHours: NOW.getTime() / 3_600_000 }).map((c) => c.id);

test('"Beige Book" never returns a travel company (every word must match)', () => {
  assert.equal(ids('Beige Book').includes('travel'), false);
  assert.deepEqual(ids('Beige Book'), []);
});

test('"CPI" returns the CPI data card first, not an insider-trade card', () => {
  const r = ids('CPI');
  assert.equal(r[0], 'cpi');
  assert.ok(r.indexOf('f4b') === -1 || r.indexOf('f4b') > r.indexOf('cpi'));
});

test('"is the economy ok" finds macro cards before a coffee company', () => {
  assert.deepEqual(searchTerms('is the economy ok'), ['economy']);
  const r = ids('is the economy ok');
  assert.ok(r.length >= 2);
  assert.ok(['gdp', 'cpi'].includes(r[0]), r.join());
  assert.ok(r.indexOf('gdp') < r.indexOf('coffee'));
});

test('"gas prices" and "diesel fuel" find the oil card before Form 4 cards', () => {
  for (const q of ['gas prices', 'diesel fuel', 'gasoline']) {
    const r = ids(q);
    assert.equal(r[0], 'oil', `${q}: ${r.join()}`);
    for (const f of ['f4a', 'f4b']) assert.ok(r.indexOf(f) === -1 || r.indexOf(f) > 0, `${q}: ${r.join()}`);
  }
});

test('"savings account interest" ranks the Fed decision above a bank profit', () => {
  const r = ids('savings account interest');
  assert.equal(r[0], 'fed', r.join());
  assert.ok(r.indexOf('bank') === -1 || r.indexOf('bank') > 0);
});

test('a company query still finds its Form 4 cards (no demotion when a company is named)', () => {
  const r = ids('Tailspin');
  assert.equal(r[0], 'f4a');
});
