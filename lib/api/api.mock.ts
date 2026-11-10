// Mock API over the sample fixtures in contract/fixtures/. Every card there is
// fictional and its headline starts with "[SAMPLE]"; the app shows a banner too.
// Metro bundles the JSON files; this module is not loaded by the node tests.

import type { BlurbCard, Brief, FeedPage } from '../../contract/types.ts';
import type { Api } from './api.ts';
import { MOCK_DELAY_MS } from './config.ts';
import { mockFeedPage } from '../feed/feedLogic.ts';
import { rebaseCards } from '../feed/rebase.ts';
import { SAMPLE_NUMBER_TRENDS } from '../numbers/numberTrendsSample.ts';
import { createMockFeatureApi } from './api.mockFeatures.ts';
import { mockFeedStatus } from './mockStatus.ts';
import { wantsWorstCase, worstCaseCards } from '../shared/mockWorst.ts';
import { createMockCompanyApi } from '../companies/companyApi.ts';
import { isValidReport } from './report.ts';
import { parseAppConfig, parseCategories, parseFeedPage, parseMacroFacts } from '../shared/types.ts';

import page1 from '../../contract/fixtures/feed.page1.json';
import page2 from '../../contract/fixtures/feed.page2.json';
import appConfig from '../../contract/fixtures/app_config.json';
import categories from '../../contract/fixtures/categories.json';
import numbers from '../../contract/fixtures/numbers_to_know.json';

function wait<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), MOCK_DELAY_MS));
}

export function allCards(): BlurbCard[] {
  const seen = new Set<string>();
  const out: BlurbCard[] = [];
  for (const page of [page1, page2]) {
    for (const card of parseFeedPage(page).items) {
      if (!seen.has(card.id)) {
        seen.add(card.id);
        out.push(card);
      }
    }
  }
  return rebaseCards(out); // fixture dates are fixed; keep them fresh so windows never go empty
}

export function createMockApi(): Api {
  // ?mock_data=worst: stress-test cards for the layout (lib/shared/mockWorst.ts)
  const cards = wantsWorstCase() ? worstCaseCards(allCards()) : allCards();
  const trends = SAMPLE_NUMBER_TRENDS.map((t) => ({ ...t, points: [...t.points] }));
  const features = createMockFeatureApi(cards, parseMacroFacts(numbers), trends);
  const companies = createMockCompanyApi(cards);
  return {
    sample: true,
    feed: (req) =>
      wait(
        mockFeedPage(cards, {
          mode: req.mode,
          category: req.category ?? null,
          cursor: req.cursor ?? null,
          limit: req.limit ?? 20,
        }),
      ),
    categories: () => wait(parseCategories(categories)),
    numbersToKnow: () => wait(parseMacroFacts(numbers)),
    appConfig: () => wait(parseAppConfig(appConfig)),
    feedStatus: () => wait(mockFeedStatus()),
    topStories: () => wait(mockFeedPage(cards, { mode: 'top', category: null, cursor: null, limit: 30 }).items.slice(0, 5)),
    numberTrends: () => wait(trends.map((t) => ({ ...t, points: [...t.points] }))),
    search: (q, cursor, limit) => wait(features.search(q, cursor, limit)),
    relatedCards: (id, limit) => wait(features.relatedCards(id, limit)),
    card: (id) => wait(cards.find((c) => c.id.toLowerCase() === String(id).toLowerCase()) ?? null),
    reportBlurb: (id, reason) => wait(isValidReport(id, reason) && cards.some((c) => c.id === id) ? { ok: true, status: 'ok' as const } : { ok: false, status: 'invalid' as const }),
    followingFeed: (f) => wait(features.followingFeed(f)),
    dailyBrief: () => wait(features.dailyBrief()),
    weeklyBrief: () => wait(features.weeklyBrief()),
    subscribeBrief: (i) => wait(features.subscribeBrief(i)),
    confirmBrief: (t) => wait(features.confirmBrief(t)),
    updateBriefSubscription: (t, i) => wait(features.updateBriefSubscription(t, i)),
    unsubscribeBrief: (t) => wait(features.unsubscribeBrief(t)),
    mySubscriptions: () => wait(features.mySubscriptions()),
    unsubscribeMine: (k) => wait(features.unsubscribeMine(k)),
    updateMyTime: (k, h, tz) => wait(features.updateMyTime(k, h, tz)),
    companies: {
      search: (q, limit) => companies.search(q, limit).then(wait),
      cards: (t, cursor, limit) => companies.cards(t, cursor, limit).then(wait),
      directory: () => companies.directory().then(wait),
      tags: (ids) => wait(companies.tagsNow(ids)),
    },
  };
}
