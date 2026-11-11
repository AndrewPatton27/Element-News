// The feed tab (Trending, Latest, For you) the reader used last, kept in memory for this visit, so the bottom
// "Feed" tab (a plain link to /) brings them back to it instead of Trending. A fresh launch still opens Trending.
// Not stored on disk on purpose: the first screen of a new visit stays predictable.

import type { FeedTab } from './feedLogic.ts';

const TABS: readonly FeedTab[] = ['top', 'latest', 'for_you'];
let last: FeedTab = 'top';

export function lastFeedTab(): FeedTab {
  return last;
}

export function rememberFeedTab(tab: string | null | undefined): void {
  if ((TABS as readonly string[]).includes(tab ?? '')) last = tab as FeedTab;
}

/** The tab the feed opens on: the one in the link (?tab=) when valid, else the last one used this visit. */
export function startFeedTab(param: string | string[] | undefined): FeedTab {
  const v = Array.isArray(param) ? param[0] : param;
  return (TABS as readonly string[]).includes(v ?? '') ? (v as FeedTab) : last;
}

/** Test hook. */
export function resetLastFeedTab(): void {
  last = 'top';
}
