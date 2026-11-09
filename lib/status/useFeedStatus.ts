// Polls api.feedStatus() (every 5 min). Failures are ignored: no news about freshness
// means no banner, never an error screen.

import { useEffect, useState } from 'react';
import type { Api } from '../api/api.ts';
import type { FeedStatus } from '../shared/types.ts';
import { STATUS_POLL_MS } from './statusLogic.ts';

export function useFeedStatus(api: Api): FeedStatus | null {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .feedStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);
  return status;
}
