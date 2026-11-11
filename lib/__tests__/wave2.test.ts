// Wave 2 (M9c): flags, fine topics and lanes, signals, since window, glossary, three-question setup, card menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_OFF, parseFlagList, resolveFlags } from '../flags/flags.ts';
import { FINE_TOPICS, fineChips, fineTopicsOf, laneVisible, matchesFine } from '../topics/fineTopics.ts';
import {
  EMPTY_SIGNALS,
  MAX_SAVED,
  interestsFirst,
  isSaved,
  readSignals,
  toggleMutedTicker,
  toggleMutedTopic,
  toggleOptIn,
  toggleSaved,
  withoutMuted,
  writeSignals,
} from '../signals/signalsLogic.ts';
import { DEFAULT_WINDOW_MS, MAX_WINDOW_MS, SESSION_GAP_MS, cardsSince, sinceStart, startVisit, touchVisit } from '../since/sinceLogic.ts';
import { GLOSSARY, glossaryTermsIn, segmentText } from '../glossary/glossary.ts';
import { loadSinceRaw, sinceCards, sincePillText } from '../since/sinceFeed.ts';
import { INVEST_OPTIONS, joinNames, pickedReason, pickedTopicNames, planSetup, skipSetup } from '../onboarding/setupLogic.ts';
import { menuItems } from '../feed/cardMenu.ts';
import { memoryStore } from '../storage/storage.ts';
import { DEVICE_DATA_KEYS, clearAll } from '../storage/localPrefs.ts';
import { card, dataCard, fact } from './helpers.ts';

const lane = (over = {}) =>
  card({ id: 'l1', headline: 'SEC charges a crypto exchange over unregistered tokens', body: 'The SEC filed a complaint about Bitcoin trading.', category: 'policy', tickers: [], sources: [{ ...card().sources[0], license_class: 'public_domain' }], ...over });

test('flags: everything is off by default and in a live build the override key is ignored', () => {
  assert.deepEqual(resolveFlags({ mock: true }), ALL_OFF);
  assert.deepEqual(resolveFlags({ env: '', override: 'all', mock: false }), ALL_OFF);
  assert.equal(resolveFlags({ override: 'all', mock: true }).glossary, true);
  const some = resolveFlags({ override: ' Signals, since ,nope', mock: true });
  assert.deepEqual([some.signals, some.since, some.onboarding, some.topics, some.glossary], [true, true, false, false, false]);
  assert.equal(resolveFlags({ env: 'topics', mock: false }).topics, true); // the build-time flag works live
  assert.equal(parseFlagList('all').size, 5);
});

test('fine topics: tagged from the words, recalls never macro, series ids pin data cards', () => {
  assert.deepEqual(fineTopicsOf(card({ headline: 'Mortgage rates fall as the Fed holds', body: 'Housing starts rose.' })), ['rates', 'housing']);
  assert.deepEqual(fineTopicsOf(card({ headline: 'Jobs report: payrolls grow, unemployment steady', body: null })), ['labor']);
  assert.deepEqual(fineTopicsOf(card({ headline: 'Tariffs lift the trade deficit', body: null })), ['trade']);
  assert.ok(fineTopicsOf(card({ headline: 'Retiree 401(k) and Social Security changes', body: null })).includes('retirement'));
  assert.deepEqual(fineTopicsOf(card({ headline: 'Recall: bank branded wages cereal', body: null, category: 'safety' })), []);
  assert.ok(fineTopicsOf(dataCard({ macro: [fact({ series_id: 'UNRATE', label: 'Unemployment rate' })] })).includes('labor'));
  assert.ok(fineTopicsOf(card({ headline: 'Nvidia AI chips demand', body: null })).includes('tech-ai'));
  assert.deepEqual(fineTopicsOf(card({ headline: 'Plain earnings beat', body: 'Revenue rose.' })), []);
  assert.equal(FINE_TOPICS.length, 8);
});

test('lanes (D-121): hidden unless opted in, regulator-grade only, Trending only when macro-material', () => {
  const c = lane();
  assert.equal(laneVisible(c, 'latest', []), false);
  assert.equal(laneVisible(c, 'for_you', []), false);
  assert.equal(laneVisible(c, 'latest', ['crypto']), true);
  assert.equal(laneVisible(c, 'for_you', ['crypto']), true);
  // category policy = macro-material: Trending may show it even without the opt-in
  assert.equal(laneVisible(c, 'top', []), true);
  // not macro-material: never in Trending, even opted in
  const small = lane({ category: 'markets' });
  assert.equal(laneVisible(small, 'top', ['crypto']), false);
  assert.equal(laneVisible(small, 'latest', ['crypto']), true);
  // a link-out (not public domain / filing) never counts, even opted in
  const linkOut = lane({ category: 'markets', sources: [{ ...card().sources[0], license_class: 'link_out' }] });
  assert.equal(laneVisible(linkOut, 'latest', ['crypto']), false);
  assert.equal(matchesFine(linkOut, 'crypto'), false);
  // ordinary cards always pass
  assert.equal(laneVisible(card(), 'top', []), true);
});

test('fine chips: macro six always, lanes only when opted in', () => {
  assert.deepEqual(fineChips([]).map((c) => c.name), ['Rates', 'Housing', 'Trade', 'Labor', 'Banks', 'Retirement']);
  assert.deepEqual(fineChips(['tech-ai']).map((c) => c.name).slice(-1), ['Tech/AI']);
});

test('signals: save, mute, opt-in, depth survive a round trip; garbage reads as empty', () => {
  const store = memoryStore();
  assert.deepEqual(readSignals(store), EMPTY_SIGNALS);
  let s = toggleSaved(EMPTY_SIGNALS, card(), 1000);
  s = toggleMutedTicker(s, 'nwnd');
  s = toggleMutedTopic(s, 'rates');
  s = toggleOptIn(s, 'crypto');
  s = { ...s, depth: 'short' };
  writeSignals(store, s);
  assert.deepEqual(readSignals(store), s);
  assert.equal(isSaved(s, 'c1'), true);
  assert.equal(isSaved(toggleSaved(s, card()), 'c1'), false); // second press removes
  store.set('element.signals', '{nope');
  assert.deepEqual(readSignals(store), EMPTY_SIGNALS);
  store.set('element.signals', JSON.stringify({ mutedTopics: ['rates', 'bogus'], optIn: ['crypto', 'rates'], depth: 'huge' }));
  const r = readSignals(store);
  assert.deepEqual([r.mutedTopics, r.optIn, r.depth], [['rates'], ['crypto'], 'normal']);
});

test('signals: saved list is capped and newest first', () => {
  let s = EMPTY_SIGNALS;
  for (let i = 0; i < MAX_SAVED + 5; i++) s = toggleSaved(s, { id: `x${i}`, headline: `h${i}`, category: 'economy' }, i);
  assert.equal(s.saved.length, MAX_SAVED);
  assert.equal(s.saved[0].id, `x${MAX_SAVED + 4}`);
});

test('signals: muted company and muted topic remove cards; interests move cards first', () => {
  const a = card({ id: 'a' });
  const b = card({ id: 'b', tickers: [], headline: 'Mortgage rates and the Fed', body: null, category: 'economy' });
  const c = card({ id: 'c', tickers: [], headline: 'Plain', body: null });
  assert.deepEqual(withoutMuted([a, b, c], { mutedTickers: ['NWND'], mutedTopics: [] }).map((x) => x.id), ['b', 'c']);
  assert.deepEqual(withoutMuted([a, b, c], { mutedTickers: [], mutedTopics: ['rates'] }).map((x) => x.id), ['a', 'c']);
  assert.deepEqual(withoutMuted([a, b, c], { mutedTickers: [], mutedTopics: [] }), [a, b, c]);
  assert.deepEqual(interestsFirst([a, b, c], ['rates']).map((x) => x.id), ['b', 'a', 'c']);
  assert.deepEqual(interestsFirst([a, b, c], []).map((x) => x.id), ['a', 'b', 'c']);
});

test('since: a long gap starts a new visit, a short one keeps the old window; first visit uses 24 h', () => {
  const store = memoryStore();
  const t0 = 1_000_000_000_000;
  const v1 = startVisit(store, t0);
  assert.equal(v1.prev, null);
  assert.equal(sinceStart(v1, t0), t0 - DEFAULT_WINDOW_MS);
  touchVisit(store, t0 + 10 * 60_000);
  const v2 = startVisit(store, t0 + 20 * 60_000); // 10 min after the last touch: same session
  assert.equal(v2.prev, null);
  const v3 = startVisit(store, t0 + 20 * 60_000 + SESSION_GAP_MS + 1); // long gap: previous session becomes "last visit"
  assert.equal(v3.prev, t0 + 20 * 60_000);
  assert.equal(sinceStart({ prev: t0 - 10 * MAX_WINDOW_MS, last: t0 }, t0), t0 - MAX_WINDOW_MS); // never reaches back more than 72 h
});

test('since: only newer cards, macro first, newest first, no repeats', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 10, 11, 12 - h)).toISOString();
  const from = Date.UTC(2026, 10, 11, 12 - 10);
  const old = card({ id: 'old', published_at: t(11) });
  const corp = card({ id: 'corp', published_at: t(1) });
  const corp2 = card({ id: 'corp2', published_at: t(2) });
  const macro = card({ id: 'macro', category: 'economy', published_at: t(6) });
  const data = dataCard({ id: 'data', published_at: t(8) });
  assert.deepEqual(cardsSince([old, corp, corp2, macro, data, corp], from).map((c) => c.id), ['macro', 'data', 'corp', 'corp2']);
});

test('glossary: about 120 terms, first mention only, whole words, no network', () => {
  assert.ok(GLOSSARY.length >= 55 && GLOSSARY.length <= 125, String(GLOSSARY.length));
  for (const g of GLOSSARY) assert.ok(g.meaning.length > 30 && g.meaning.length < 260, g.term);
  const segs = segmentText('CPI rose 0.3%. Yields fell and yields rose, the yield curve flattened. CPI again.');
  const terms = segs.filter((s) => s.term).map((s) => s.term?.term);
  assert.deepEqual(terms, ['CPI', 'Treasury yield', 'Yield curve']);
  assert.equal(segs.map((s) => s.text).join(''), 'CPI rose 0.3%. Yields fell and yields rose, the yield curve flattened. CPI again.');
  assert.equal(segmentText('The second sec of the secular era').filter((s) => s.term).length, 0); // "sec" is not SEC
  assert.equal(segmentText('Matched 401(k) plans and the S&P 500').filter((s) => s.term).length, 2);
  assert.deepEqual(segmentText('plain words only').map((s) => s.text), ['plain words only']);
  assert.deepEqual(segmentText(''), []);
});

test('setup: answers become interests, opt-in lanes, depth and parent follows; lanes are never followed', () => {
  const plan = planSetup({ topics: ['rates', 'housing', 'crypto', 'earnings'], invest: 'some', depth: 'short' }, EMPTY_SIGNALS, ['economy']);
  assert.deepEqual(plan.signals.interests, ['rates', 'housing']);
  assert.deepEqual(plan.signals.optIn, ['crypto']);
  assert.equal(plan.signals.depth, 'short');
  assert.equal(plan.signals.setup, 'done');
  assert.deepEqual(plan.followTopics, ['earnings', 'personal-finance', 'markets']); // economy was already followed; no crypto parent
  assert.equal(skipSetup(EMPTY_SIGNALS).setup, 'skipped');
  assert.deepEqual(planSetup({ topics: [], invest: null, depth: 'normal' }, EMPTY_SIGNALS).followTopics, []);
});

test('card menu: the extra entries appear only with signals', () => {
  assert.deepEqual(menuItems(card(), { canHideSource: false }), ['fewer', 'hideTopic', 'report']);
  assert.deepEqual(menuItems(card(), { canHideSource: false, signals: { ticker: true, topic: true } }), ['fewer', 'save', 'muteTicker', 'muteTopic', 'hideTopic', 'report']);
  assert.deepEqual(menuItems(dataCard(), { canHideSource: false, signals: {} }), ['fewer', 'save', 'report']);
});

test('clear data on this device also forgets signals and the visit', () => {
  assert.ok(DEVICE_DATA_KEYS.includes('element.signals' as never) && DEVICE_DATA_KEYS.includes('element.visit' as never));
  const store = memoryStore();
  writeSignals(store, toggleSaved(EMPTY_SIGNALS, card()));
  startVisit(store);
  clearAll(store);
  assert.deepEqual(readSignals(store), EMPTY_SIGNALS);
  assert.equal(store.get('element.visit'), null);
});

test('setup (D-230): Rates, Labor and Trade stay visible as fine topics with a "because you picked" reason', () => {
  const plan = planSetup({ topics: ['rates', 'labor', 'trade', 'tech-ai'], invest: null, depth: 'normal' }, EMPTY_SIGNALS);
  assert.deepEqual(plan.signals.interests, ['rates', 'labor', 'trade']);
  assert.deepEqual(plan.followTopics, ['economy']); // the server only knows the category ...
  assert.deepEqual(pickedTopicNames(plan.signals), ['Rates', 'Labor', 'Trade', 'Tech/AI']); // ... the app keeps the names
  assert.equal(pickedReason(plan.signals), 'Because you picked Rates, Labor, Trade and Tech/AI in setup.');
  assert.equal(pickedReason(EMPTY_SIGNALS), null);
  assert.equal(joinNames(['Rates']), 'Rates');
  assert.equal(joinNames(['Rates', 'Labor']), 'Rates and Labor');
});

test('setup (D-230): "I am learning" is the first invest option and starts on money and economy news', () => {
  assert.equal(INVEST_OPTIONS[0].id, 'learning');
  assert.equal(INVEST_OPTIONS[0].label, 'I am learning');
  assert.deepEqual(planSetup({ topics: [], invest: 'learning', depth: 'normal' }, EMPTY_SIGNALS).followTopics, ['personal-finance', 'economy']);
});

test('since (D-231): the pill and the page share one loader and filter, so the counts match; first visit says the window', async () => {
  const now = Date.now();
  const mk = (id: string, hoursAgo: number, category = 'economy') => card({ id, category: category as never, published_at: new Date(now - hoursAgo * 3_600_000).toISOString() });
  const all = [mk('a', 1), mk('b', 2, 'tech'), mk('c', 5), mk('d', 30), mk('e', 40)];
  let calls = 0;
  const feed = async (q: { cursor: string | null }) => {
    calls++;
    return q.cursor === null ? { items: all.slice(0, 2), next_cursor: 'x' } : { items: all.slice(2), next_cursor: null };
  };
  const raw = await loadSinceRaw(feed, now - 24 * 3_600_000);
  assert.equal(calls, 2);
  const keepAll = (c: typeof raw) => c;
  assert.equal(sinceCards(raw, now - 24 * 3_600_000, keepAll).length, 3);
  assert.equal(sinceCards(raw, now - 24 * 3_600_000, (c) => c.filter((x) => x.category !== 'tech')).length, 2);
  assert.equal(sincePillText(3, null, now - 24 * 3_600_000, now), '3 new in the last 24 hours · See what changed →');
  assert.equal(sincePillText(3, now - 5 * 3_600_000, now - 5 * 3_600_000, now), '3 new since your last visit · See what changed →');
});

test('glossary (D-232): finance wording on real cards is covered, and the word row lists each term once', () => {
  const sample = [
    'The Fed held rates steady while core inflation cooled and the dot plot pointed to one rate cut.',
    'Retail sales beat the consensus estimate; the ISM survey and consumer sentiment both improved.',
    'WTI crude rose as OPEC held output; Brent also gained.',
    'The company reported EBITDA of $2 billion, lifted gross margin, and filed a Form 4 and a Schedule 13D.',
    'Credit spreads widened on junk bonds as a Chapter 11 filing and a covenant breach hit high-yield debt.',
    'Net interest margin fell at banks and the FDIC raised its assessment; Treasury auctions drew weak demand.',
  ];
  for (const t of sample) assert.ok(segmentText(t).filter((x) => x.term).length >= 3, t);
  const terms = glossaryTermsIn(['CPI rose. Core inflation cooled.', 'CPI again and the Fed.']);
  assert.deepEqual(terms.map((t) => t.term), ['CPI', 'Core inflation', 'Federal Reserve']);
  assert.ok(glossaryTermsIn(sample, 8).length <= 8);
});
