// Mock `feed_status`: fresh by default; the web build can force the delayed state with
// `?mock_delayed=1` in the address (used by the demo and the Playwright smoke test).

import type { FeedStatus } from '../shared/types.ts';

const HOUR = 3_600_000;

export function mockFeedStatus(search: string | null = readSearch(), now: number = Date.now()): FeedStatus {
  const delayed = /[?&]mock_delayed=1(&|$)/.test(search ?? '');
  return { delayed, last_updated: new Date(now - (delayed ? 5 * HOUR : 12 * 60_000)).toISOString() };
}

function readSearch(): string | null {
  const loc = (globalThis as { location?: { search?: string } }).location;
  return typeof loc?.search === 'string' ? loc.search : null;
}
