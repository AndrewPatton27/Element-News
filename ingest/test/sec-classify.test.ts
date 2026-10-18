// SEC cards: category / event_type decided by 8-K items in code (AI only a tiebreak),
// and low-value filings (only 7.01 / 8.01 / 9.01) skipped before any AI call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { fixtureFetcher } from '../src/main.ts';
import { runOnce, type Deps } from '../src/pipeline.ts';
import { buildPublishPayload, createDryRunPublisher } from '../src/publish.ts';
import {
  classifySecEntry, classifySecItems, isLowValueFiling, ITEM_CLASS, parseSec8kAtom, resolveSecClassification, secEntryToItem,
} from '../src/sources/sec.ts';
import { memoryCounter } from '../src/summarizer/chain.ts';
import { templateSummarizer } from '../src/summarizer/template.ts';
import { CATEGORY_SLUGS, validatePublish } from '../src/validate.ts';
import type { Summarizer } from '../src/types.ts';

const fx = (n: string) => readFileSync(new URL(`../src/fixtures/${n}`, import.meta.url), 'utf8');
const items = (...n: string[]) => n.map((number) => ({ number, title: `Item ${number}` }));
const cls = (...n: string[]) => { const c = classifySecItems(items(...n)); return `${c.category}/${c.event_type}`; };

// ---- Fix 1: deterministic category and event_type ---------------------------------

test('item map: each deciding item gives a fixed category / event_type', () => {
  assert.equal(cls('2.02', '9.01'), 'earnings/earnings');
  assert.equal(cls('4.02'), 'earnings/earnings', 'restatement (GoPro live card)');
  assert.equal(cls('4.01', '9.01'), 'earnings/earnings', 'auditor change');
  assert.equal(cls('5.02', '9.01'), 'markets/exec_change', 'LQR House / GBank live cards');
  assert.equal(cls('5.02', '5.07'), 'markets/exec_change', 'OpenWorld live card: director resigns + vote');
  assert.equal(cls('1.01', '9.01'), 'deals/deal');
  assert.equal(cls('2.01', '9.01'), 'deals/deal');
  assert.equal(cls('1.05'), 'tech/null', 'cyber incident: no own event weight, default');
  assert.equal(cls('1.03'), 'markets/null', 'bankruptcy');
  assert.equal(cls('3.01'), 'markets/null', 'delisting notice');
});

test('item map: priority when several deciding items appear', () => {
  assert.equal(cls('2.02', '4.02', '8.01'), 'earnings/earnings', 'GoPro fixture');
  assert.equal(cls('1.01', '5.02'), 'markets/exec_change', 'CEO employment agreement filed as 1.01 + 5.02');
  assert.equal(cls('2.01', '5.02', '3.01'), 'deals/deal', 'completed merger with board change and delisting');
  assert.equal(cls('1.03', '2.02'), 'markets/null', 'bankruptcy outranks results');
  assert.equal(classifySecItems(items('5.02', '1.01')).decided_by, '5.02');
});

test('item map: categories are contract slugs, event types are known to core.rank_event_weights', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261017000000_init.sql', import.meta.url), 'utf8');
  const seed = /insert into core\.rank_event_weights[^;]+;/.exec(sql)![0];
  const known = new Set([...seed.matchAll(/\('([a-z_]+)',\s*\d+\)/g)].map((m) => m[1]));
  assert.ok(known.has('exec_change') && known.has('default'), 'seed parsed');
  for (const [n, c] of Object.entries(ITEM_CLASS)) {
    assert.ok((CATEGORY_SLUGS as readonly string[]).includes(c.category), n);
    assert.ok(c.event_type === null || known.has(c.event_type), n);
  }
  for (const et of config.secAiEventTypes) assert.ok(known.has(et), et);
});

test('the AI choice is ignored when items decide (LQR House: AI said deals, 5.02 says markets)', () => {
  const r = resolveSecClassification(items('5.02', '9.01'), { category: 'deals', event_type: 'exec_change' });
  assert.deepEqual(r, { category: 'markets', event_type: 'exec_change', decided_by: '5.02' });
  const g = resolveSecClassification(items('4.02'), { category: 'markets', event_type: 'deal' });
  assert.deepEqual([g.category, g.event_type], ['earnings', 'earnings']);
});

test('the AI choice is the tiebreak when items do not decide, limited to slugs and known event types', () => {
  // 2.06 impairment + 8.01: no deciding item
  assert.deepEqual(resolveSecClassification(items('2.06', '8.01'), { category: 'energy', event_type: 'earnings' }),
    { category: 'energy', event_type: 'earnings', decided_by: null });
  // 2.05 layoffs / restructuring now decides: markets, 'default' rank weight (event_type null)
  assert.deepEqual(resolveSecClassification(items('2.05', '8.01'), { category: 'energy', event_type: 'earnings' }),
    { category: 'markets', event_type: null, decided_by: '2.05' });
  // AI event types outside the SEC set (fed, macro_release, made-up) become null; bad slug -> markets
  assert.deepEqual(resolveSecClassification(items('2.06'), { category: 'crypto', event_type: 'fed' }),
    { category: 'markets', event_type: null, decided_by: null });
  assert.equal(resolveSecClassification(items('2.06'), { category: 'tech', event_type: 'lawsuit' }).event_type, null);
});

test('buildPublishPayload applies the item classification to SEC cards (AI and template alike)', () => {
  const [e] = parseSec8kAtom(fx('sec-8k-item-5.02.atom.xml'));
  const it = secEntryToItem(e, null)!;
  const p = buildPublishPayload(it, { headline: 'Costco names new officer', body: null, category: 'deals', event_type: 'deal', tickers: [] },
    { aiGenerated: true, model: 'm' });
  assert.equal(p.category, 'markets');
  assert.equal(p.event_type, 'exec_change');
  assert.deepEqual(validatePublish(p).errors, []);
});

// ---- Fix 2: skip low-value filings ------------------------------------------------

test('low-value: only 7.01 / 8.01 / 9.01 is skipped; any substantive item keeps the filing', () => {
  assert.deepEqual([...config.sec8kLowValueItems], ['7.01', '8.01', '9.01']);
  assert.equal(isLowValueFiling(items('8.01', '9.01')), true, 'National Rural Utilities live card');
  assert.equal(isLowValueFiling(items('7.01')), true);
  assert.equal(isLowValueFiling(items('7.01', '8.01', '9.01')), true);
  assert.equal(isLowValueFiling(items('9.01')), true);
  assert.equal(isLowValueFiling(items('8.01', '5.07')), true, '5.07 is not a tracked item, so not substantive');
  assert.equal(isLowValueFiling(items('2.02', '7.01', '9.01')), false);
  assert.equal(isLowValueFiling(items('5.02', '8.01')), false);
  assert.equal(isLowValueFiling(items('5.07')), false, 'untracked only: not a candidate, but not "low value"');
});

test('classifySecEntry gives the skip reason', () => {
  const [e] = parseSec8kAtom(fx('sec-8k-item-2.02.atom.xml'));
  assert.deepEqual(classifySecEntry({ ...e, items: items('8.01', '9.01') }, null), { skip: 'low_value' });
  assert.deepEqual(classifySecEntry({ ...e, items: items('5.07') }, null), { skip: 'no_tracked_item' });
  assert.deepEqual(classifySecEntry({ ...e, form: '8-K/A' }, null), { skip: 'amendment' });
  assert.ok('item' in classifySecEntry(e, null));
});

// SYNTHETIC entry (fictional accession; Apple's CIK so it passes the watch list) added to the real dry-run feed.
const LOW_VALUE_ENTRY = `<entry>
<title>8-K - Apple Inc. (0000320193) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/320193/000999999926000001/0009999999-26-000001-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-08-04 &lt;b&gt;AccNo:&lt;/b&gt; 0009999999-26-000001 &lt;b&gt;Size:&lt;/b&gt; 90 KB&lt;br&gt;Item 8.01: Other Events&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
<updated>2026-08-04T18:00:00-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
<id>urn:tag:sec.gov,2008:accession-number=0009999999-26-000001</id>
</entry>
</feed>`;

test('pipeline: off-list, low-value and routine 5.02 filings are skipped before any AI call; items decide the category', async () => {
  const base = fixtureFetcher();
  const requested: string[] = [];
  const aiSaw: string[] = [];
  const ai: Summarizer = {
    name: 'gemini', usesAi: true,
    async summarize(i) {
      aiSaw.push(i.item.url);
      // deliberately "wrong" category: the 8-K items must override it. The figure comes from the EX-99.1 exhibit.
      return { headline: `${i.item.company} reports a new filing`, body: 'The company reported revenue of $102.5 billion for the quarter.', category: 'deals', event_type: null, tickers: i.item.tickers.map((t) => t.symbol), everyday_relevance: 4 };
    },
  };
  const dry = createDryRunPublisher();
  const lines: string[] = [];
  const deps: Deps = {
    fetchText: async (url, kind, ttl) => {
      requested.push(url);
      if (url === config.feeds.sec8k) return fx('sec-8k-feed.atom.xml').replace('</feed>', LOW_VALUE_ENTRY);
      return base(url, kind, ttl);
    },
    publisher: dry.publisher, providers: [ai, templateSummarizer], counter: memoryCounter(), fredApiKey: null,
    now: new Date('2026-08-05T12:00:00Z'), log: (s) => lines.push(s),
  };
  const s = await runOnce(deps, { only: ['sec'] });
  assert.equal(s.skipped, 2, lines.join('\n'));          // low_value (synthetic Apple 8.01) + routine_5.02 (Costco)
  assert.equal(s.published, 1);                          // REAL Apple 2.02 from the per-company list
  assert.equal(s.ai, 1);
  assert.ok(lines.some((l) => l === 'skip low_value (items 8.01, 9.01): Apple Inc. 8-K'), lines.join('\n'));
  assert.ok(lines.includes('skip routine_5.02: Costco Wholesale Corp 8-K'));
  assert.ok(lines.some((l) => /4 filings \(feed \+ watch list\), 2 card candidates \(not candidates: not_watched 1, low_value 1\)/.test(l)), lines.join('\n'));
  assert.equal(aiSaw.length, 1);
  assert.ok(!aiSaw.some((u) => u.includes('9999999') || u.includes('/909832/') || u.includes('/1500435/')), 'no AI call for skipped filings');
  assert.ok(!requested.some((u) => u.includes('/000999999926000001/') || u.includes('/1500435/')), 'no page fetch for off-list or low-value filings');
  const [c] = dry.cards;
  assert.equal(`${c.category}/${c.event_type}`, 'earnings/earnings');
  assert.ok(lines.some((l) => l.includes('category deals -> earnings (8-K items)')));
});
