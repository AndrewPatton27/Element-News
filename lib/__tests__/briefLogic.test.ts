import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  briefCards,
  briefDateLabel,
  briefFooter,
  briefIsEmpty,
  briefRowLabels,
  briefView,
  dayLabelLong,
  dayLabelShort,
  generatedLine,
  headlineLabel,
  sectionTitle,
  teaser,
  toBriefData,
  trendA11yLabel,
  weekRangeLabel,
  windowText,
} from '../brief/briefLogic.ts';
import { withoutHidden } from '../account/accountLogic.ts';
import { withoutHiddenSources } from '../sources/sourceKeys.ts';
import { card, config, dataCard, fact, NOW } from './helpers.ts';

const brief = (over = {}) =>
  toBriefData({
    generated_at: '2026-10-17T13:00:00Z',
    window_hours: 24,
    headline_cards: [card({ id: 'a' }), dataCard({ id: 'b' })],
    sections: [
      { category: 'earnings', label: 'earnings', cards: [card({ id: 'a' }), card({ id: 'c', category: 'earnings' })] },
      { category: 'safety', label: 'Recalls & Safety', cards: [card({ id: 'd', category: 'safety' })] },
    ],
    numbers: [fact()],
    ...over,
  });

test('briefView: a headline card is not repeated in a section and sections keep their order', () => {
  const v = briefView(brief(), []);
  assert.deepEqual(v.headlines.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(v.sections.map((s) => [s.category, s.cards.map((c) => c.id)]), [['earnings', ['c']], ['safety', ['d']]]);
});

test('briefView: hidden topics and hidden sources leave every list, and empty sections go', () => {
  const onlyTopic = briefView(brief(), [], (c) => withoutHidden(c, ['safety']));
  assert.deepEqual(onlyTopic.sections.map((s) => s.category), ['earnings']);
  // the sample cards' source is the SEC (key 'sec'); the data card's key is 'fred'
  const noSec = briefView(brief(), [], (c) => withoutHiddenSources(c, ['sec']));
  assert.deepEqual(noSec.headlines.map((c) => c.id), ['b']); // the data card's source key is 'fred'
  assert.deepEqual(noSec.sections, []);
});

test('briefView: cards of a kind the app cannot draw are skipped', () => {
  const v = briefView(brief({ headline_cards: [card({ id: 'x', kind: 'link_out' as never }), card({ id: 'y' })] }), [], undefined, (c) => c.kind !== 'link_out');
  assert.deepEqual(v.headlines.map((c) => c.id), ['y']);
});

test('briefIsEmpty: an empty brief (RPC missing) is empty; numbers or movers alone are not', () => {
  const empty = toBriefData({ generated_at: new Date(0).toISOString(), window_hours: 24, headline_cards: [], sections: [], numbers: [] });
  assert.equal(briefIsEmpty(briefView(empty, [])), true);
  assert.equal(briefIsEmpty(briefView({ ...empty, numbers: [fact()] }, [])), false);
  const mover = { key: 'k', name: 'n', value: '1', change: '▲ 1', direction: 'up' as const, source: 's', points: [1, 2] };
  assert.equal(briefIsEmpty(briefView({ ...empty, movers: [mover] }, [])), false);
});

test('toBriefData: movers default to an empty list', () => {
  assert.deepEqual(toBriefData({ generated_at: 'x', window_hours: 24, headline_cards: [], sections: [], numbers: [] }).movers, []);
});

test('sectionTitle: a real server label wins; a slug label falls back to the category name', () => {
  assert.equal(sectionTitle({ category: 'safety', label: 'Recalls & Safety' }, []), 'Recalls & Safety');
  assert.equal(sectionTitle({ category: 'earnings', label: 'earnings' }, []), 'Earnings');
  assert.equal(sectionTitle({ category: 'policy', label: '' }, [{ slug: 'policy', name: 'Government' } as never]), 'Government');
});

test('generatedLine: "Generated 5 h ago · last 24 h"; unknown time shows only the window', () => {
  assert.equal(generatedLine({ generated_at: '2026-10-17T13:00:00Z', window_hours: 24 }, NOW), 'Generated 5 h ago · last 24 h');
  assert.equal(generatedLine({ generated_at: '2026-10-17T17:59:30Z', window_hours: 48 }, NOW), 'Generated just now · last 48 h');
  assert.equal(generatedLine({ generated_at: new Date(0).toISOString(), window_hours: 168 }, NOW), 'Last 168 h');
  assert.equal(generatedLine({ generated_at: 'bad', window_hours: 24 }, NOW), 'Last 24 h');
});

test('headlineLabel: weekly and a widened daily window say so', () => {
  assert.equal(headlineLabel('daily', 24), 'Today in a minute');
  assert.equal(headlineLabel('daily', 48), 'Top stories · last 2 days');
  assert.equal(headlineLabel('weekly', 168), 'Top stories · last week');
});

test('windowText: bad hours fall back to 24', () => {
  assert.equal(windowText(168), 'last 168 h');
  assert.equal(windowText(0), 'last 24 h');
  assert.equal(windowText(Number.NaN), 'last 24 h');
});

test('date labels', () => {
  const sat = new Date('2026-10-17T12:00:00Z'); // a Saturday
  assert.equal(dayLabelLong(sat, true), 'Saturday, October 17');
  assert.equal(dayLabelShort(sat, true), 'Sat, Oct 17');
  assert.equal(weekRangeLabel(new Date('2026-10-18T12:00:00Z'), 168, true), 'October 12 – 18');
  assert.equal(weekRangeLabel(new Date('2026-10-04T12:00:00Z'), 168, true), 'September 28 – October 4');
});

test('briefDateLabel: uses the brief time, else now', () => {
  assert.equal(briefDateLabel('daily', { generated_at: '2026-10-17T13:00:00Z', window_hours: 24 }, NOW, true), 'Saturday, October 17');
  assert.equal(briefDateLabel('weekly', { generated_at: '2026-10-18T13:00:00Z', window_hours: 168 }, NOW, true), 'October 12 – 18');
  assert.equal(briefDateLabel('daily', null, NOW, true), 'Saturday, October 17');
  assert.equal(briefDateLabel('daily', { generated_at: new Date(0).toISOString(), window_hours: 24 }, NOW, true), 'Saturday, October 17');
});

test('teaser: first sentence, capped, empty for no body', () => {
  assert.equal(teaser('Yearly inflation slowed. Housing led the rise.'), 'Yearly inflation slowed.');
  assert.equal(teaser('No end punctuation here'), 'No end punctuation here');
  assert.equal(teaser(null), '');
  assert.equal(teaser('   '), '');
  assert.ok(teaser('word '.repeat(60), 40).length <= 40);
  assert.equal(teaser('Costs rose 3.1% last month. More.'), 'Costs rose 3.1% last month.');
});

test('briefFooter: only when no row carries labels (numbers-only brief), and it is the disclaimer', () => {
  assert.equal(briefFooter([card()], config()), null);
  assert.equal(briefFooter([], config()), 'Informational only · Not investment advice');
  assert.equal(briefFooter([], null), 'Informational only · Not investment advice');
});

test('briefRowLabels: AI card gets a source link, the AI label and the disclaimer once', () => {
  const r = briefRowLabels(card(), config());
  assert.deepEqual(r.source, { label: 'SEC · Form 8-K', url: 'https://www.sec.gov/Archives/edgar/data/1/0001.htm', count: 1 });
  assert.equal(r.line, 'AI-generated summary · may contain errors · Informational only · Not investment advice');
  assert.equal(r.line.split('Informational only').length - 1, 1);
  assert.equal(r.credit, null);
});

test('briefRowLabels: template and data cards carry no AI label; data cards from FRED add the notice', () => {
  const tpl = briefRowLabels(card({ ai: { generated: false, label: null } }), config());
  assert.equal(tpl.line, 'Informational only · Not investment advice');
  const d = briefRowLabels(dataCard({ sources: [{ ...card().sources[0], name: 'FRED', doc_label: null }] }), config());
  assert.equal(d.line, 'Informational only · Not investment advice · FRED notice text');
  assert.equal(d.source?.label, 'FRED');
});

test('briefRowLabels: falls back to built-in wording without config; counts extra sources', () => {
  const r = briefRowLabels(card({ source_count: 3 }), null);
  assert.equal(r.line, 'AI-generated summary · may contain errors · Informational only · Not investment advice');
  assert.equal(r.source?.count, 3);
});

test('briefRowLabels: a non-https source gives no link, a Wikipedia card gets its credit', () => {
  const src = card().sources[0];
  assert.equal(briefRowLabels(card({ sources: [{ ...src, url: 'http://example.com/x' }] }), config()).source, null);
  const wiki = briefRowLabels(
    card({ sources: [{ ...src, name: 'Wikipedia', doc_label: null, url: 'https://en.wikipedia.org/wiki/X', license_class: 'cc_by_sa' as never }] }),
    config(),
  );
  assert.ok(wiki.credit && wiki.credit.articleUrl === 'https://en.wikipedia.org/wiki/X');
});

test('briefCards lists headlines then section cards', () => {
  assert.deepEqual(briefCards(briefView(brief(), [])).map((c) => c.id), ['a', 'b', 'c', 'd']);
});

test('trendA11yLabel names the direction in words and cites the agency', () => {
  assert.equal(
    trendA11yLabel({ name: '10-year Treasury yield', value: '5.10%', change: '▼ 0.09 this week', direction: 'down', source: 'U.S. Treasury' }),
    '10-year Treasury yield 5.10%, down, 0.09 this week. Source: U.S. Treasury',
  );
  assert.equal(
    trendA11yLabel({ name: 'Unemployment', value: '4.2%', change: '', direction: 'flat', source: 'BLS' }),
    'Unemployment 4.2%, unchanged. Source: BLS',
  );
});
