import { test } from 'node:test';
import assert from 'node:assert/strict';
import page1 from '../../contract/fixtures/feed.page1.json' with { type: 'json' };
import page2 from '../../contract/fixtures/feed.page2.json' with { type: 'json' };
import type { BlurbCard } from '../../contract/types.ts';
import { wantsWorstCase, worstCaseCards } from '../shared/mockWorst.ts';

test('worst-case cards stay inside the contract limits (realistic, not random)', () => {
  const all = [...(page1.items as unknown as BlurbCard[]), ...(page2.items as unknown as BlurbCard[])];
  const cards = worstCaseCards(all.filter((c, i) => all.findIndex((d) => d.id === c.id) === i));
  const worst = cards.filter((c) => c.id.includes('-worst-'));
  assert.equal(worst.length, 3);
  for (const c of worst) {
    assert.ok(c.headline.length <= 90, c.headline);
    assert.ok(c.macro.length <= 3);
    assert.ok(c.tickers.length <= 5);
    assert.ok(c.sources.length >= 1, 'every card keeps a source link (rule 5)');
    for (const f of c.macro) assert.ok(!/^FRED$/.test(f.source_short), 'never bare FRED (rule 8)');
  }
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'no duplicate ids');
});

test('wantsWorstCase reads only ?mock_data=worst', () => {
  assert.equal(wantsWorstCase('?mock_data=worst'), true);
  assert.equal(wantsWorstCase('?a=1&mock_data=worst'), true);
  assert.equal(wantsWorstCase('?mock_data=worstx'), false);
  assert.equal(wantsWorstCase(''), false);
  assert.equal(wantsWorstCase(null), false);
});
