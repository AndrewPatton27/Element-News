import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card, fact } from './helpers.ts';
import { mockFeedPage } from '../feed/feedLogic.ts';
import { tickerEmptyText } from '../numbers/tickerLogic.ts';
import { followStoryLabel, showFollowLabel } from '../feed/cardFooterLabels.ts';
import { updateMeta, updatePeriod } from '../following/followedStories.ts';
import { withoutGovernmentMisfits, isGovernmentMisfit } from '../following/followingMisfits.ts';
import { isDimmedInLatest } from '../feed/dimmed.ts';
import { trendingOrder, sortLatest } from '../feed/feedOrder.ts';
import type { BlurbCard } from '../../contract/types.ts';

// ---- I-01: a category chip on Trending / Latest filters end to end ----

test('feed pages filter by category for Trending and Latest, and the page orderings keep the filter', () => {
  const pool = [
    card({ id: 'e1', category: 'economy', sort_at: '2026-10-17T10:00:00Z' }),
    card({ id: 'm1', category: 'markets', sort_at: '2026-10-17T11:00:00Z' }),
    card({ id: 'e2', category: 'economy', sort_at: '2026-10-17T09:00:00Z' }),
    card({ id: 'w1', category: 'world', sort_at: '2026-10-17T12:00:00Z' }),
  ];
  for (const mode of ['top', 'latest'] as const) {
    const all = mockFeedPage(pool, { mode, category: null, cursor: null, limit: 50 });
    const eco = mockFeedPage(pool, { mode, category: 'economy', cursor: null, limit: 50 });
    assert.ok(all.items.some((c) => c.category !== 'economy'), 'the unfiltered feed has other topics');
    assert.deepEqual(eco.items.map((c) => c.id).sort(), ['e1', 'e2']);
    // the client re-orders each fetched page; it must never add a card from another topic
    const ordered = mode === 'top' ? trendingOrder(eco.items) : sortLatest(eco.items);
    assert.ok(ordered.every((c) => c.category === 'economy'));
    assert.equal(ordered.length, eco.items.length);
  }
});

// ---- ticker ----

test('ticker empty state is honest: blank while loading, plain words when it failed or is empty', () => {
  assert.equal(tickerEmptyText(null, null), null);
  assert.equal(tickerEmptyText([fact()], null), null);
  assert.match(tickerEmptyText(null, 'x') ?? '', /could not load/);
  assert.match(tickerEmptyText([], null) ?? '', /No numbers/);
});

// ---- G-04 labels ----

test('follow story label wording and the width that shows it', () => {
  assert.equal(followStoryLabel(false), 'Follow story');
  assert.equal(followStoryLabel(true), 'Following');
  assert.equal(showFollowLabel(479), false);
  assert.equal(showFollowLabel(480), true);
  assert.equal(showFollowLabel(Number.NaN), false);
});

// ---- period on each update ----

test('update period comes from the card: number period, fiscal period in the headline, else as-of date', () => {
  assert.equal(updatePeriod(card({ macro: [fact({ period: 'Sep 2026' })] })), 'Period Sep 2026');
  assert.equal(updatePeriod(card({ headline: 'Microsoft posts Q4 2026 revenue of $92.3 billion', macro: [] })), 'Period Q4 2026');
  assert.equal(updatePeriod(card({ headline: 'Microsoft posts fiscal 2026 revenue', macro: [] })), 'Period fiscal 2026');
  assert.equal(updatePeriod(card({ headline: 'Nelnet names a new chief', macro: [], as_of: '2026-10-19T00:00:00Z' })), 'As of Oct 19');
  assert.equal(updatePeriod(card({ headline: 'No date', macro: [], as_of: 'garbage' })), null);
  const meta = updateMeta(card({ headline: 'Microsoft posts Q4 2026 revenue', macro: [], published_at: '2026-10-19T00:00:00Z' }), new Date('2026-10-19T03:00:00Z'));
  assert.ok(meta.startsWith('Period Q4 2026 · '));
});

// ---- C16 ----

const fedreg = (headline: string, over: Partial<BlurbCard> = {}): BlurbCard =>
  card({ category: 'policy', headline, sources: [{ ...card().sources[0], name: 'Federal Register' }], follow_match: 'topic', follow_reason: 'Because you follow policy', ...over });
const nasa = card({ id: 'n', category: 'policy', headline: 'NASA picks a landing site', sources: [{ ...card().sources[0], name: 'NASA' }], follow_match: 'topic' });
const fed = card({ id: 'f', category: 'policy', headline: 'Fed holds rates', sources: [{ ...card().sources[0], name: 'Federal Reserve Board' }], follow_match: 'topic' });

test('following Government drops FAA orders and NASA items it only matched by topic', () => {
  const faa = fedreg('Airworthiness directive for Boeing aircraft', { id: 'a' });
  assert.ok(isGovernmentMisfit(faa) && isGovernmentMisfit(nasa) && !isGovernmentMisfit(fed));
  const out = withoutGovernmentMisfits([faa, nasa, fed], { topics: ['policy'], sources: [] });
  assert.deepEqual(out.map((c) => c.id), ['f']);
  // not following Government: the list is left alone
  assert.equal(withoutGovernmentMisfits([faa, nasa, fed], { topics: ['economy'], sources: [] }).length, 3);
  // the reader asked for the source, the company or the story: they stay
  assert.equal(withoutGovernmentMisfits([faa, nasa], { topics: ['policy'], sources: ['NASA', 'Federal Register'] }).length, 2);
  assert.equal(withoutGovernmentMisfits([{ ...faa, follow_match: 'ticker' }], { topics: ['policy'], sources: [] }).length, 1);
});

// ---- dimmed disliked cards ----

test('only a disliked card on Latest is dimmed', () => {
  assert.equal(isDimmedInLatest(true, 'dislike'), true);
  assert.equal(isDimmedInLatest(true, 'like'), false);
  assert.equal(isDimmedInLatest(true, undefined), false);
  assert.equal(isDimmedInLatest(false, 'dislike'), false);
});
