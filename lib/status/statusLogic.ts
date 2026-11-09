// "Updates delayed · last updated 5 h ago": the line shown when api.feed_status() says the
// pipeline is behind. Pure, so node --test can run it.

import { relativeTime } from '../shared/format.ts';
import type { FeedStatus } from '../shared/types.ts';

export const STATUS_POLL_MS = 5 * 60_000;

/** The banner text, or null when nothing is delayed. A missing or bad time just drops that part. */
export function delayedBannerText(status: FeedStatus | null, now: Date = new Date()): string | null {
  if (!status || !status.delayed) return null;
  const when = status.last_updated ? relativeTime(status.last_updated, now) : '';
  return when ? `Updates delayed · last updated ${when}` : 'Updates delayed';
}
