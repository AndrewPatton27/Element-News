// React side of lib/since/sinceFeed.ts: loads the window's cards once and applies the reader's filters (hidden topics
// and sources, muted companies and topics, opt-in lanes) exactly as the /since page always did. The feed's pill and
// the /since page both call this, so the pill's count is the page's count.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BlurbCard } from '../../contract/types.ts';
import { useAppData } from '../shared/appData';
import { useAccount } from '../account/accountContext';
import { withoutHidden } from '../account/accountLogic';
import { withoutHiddenSources } from '../sources/sourceKeys';
import { readFlags } from '../flags/flags';
import { readSignals, withoutMuted } from '../signals/signalsLogic';
import { laneVisible } from '../topics/fineTopics';
import { defaultStore } from '../storage/storage';
import { loadSinceRaw, sinceCards } from './sinceFeed';

const store = defaultStore();

export interface SinceCards {
  items: BlurbCard[];
  loading: boolean;
  done: boolean;
  error: string | null;
  reload(): void;
}

export function useSinceCards(enabled: boolean, from: number): SinceCards {
  const { api } = useAppData();
  const acct = useAccount();
  const [raw, setRaw] = useState<BlurbCard[]>([]);
  const [status, setStatus] = useState<{ loading: boolean; done: boolean; error: string | null }>({ loading: true, done: false, error: null });
  const load = useCallback(async () => {
    setStatus({ loading: true, done: false, error: null });
    try {
      setRaw(await loadSinceRaw((q) => api.feed(q), from));
      setStatus({ loading: false, done: true, error: null });
    } catch {
      setStatus({ loading: false, done: false, error: 'Could not load the stories. Check your connection and try again.' });
    }
  }, [api, from]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const items = useMemo(() => {
    const signals = readSignals(store);
    return sinceCards(raw, from, (cards) => {
      let out = withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources);
      if (readFlags().signals) out = withoutMuted(out, signals);
      if (readFlags().topics) out = out.filter((c) => laneVisible(c, 'latest', signals.optIn));
      return out;
    });
  }, [raw, hidden, hiddenSources, from]);
  return { items, loading: status.loading, done: status.done, error: status.error, reload: () => void load() };
}
