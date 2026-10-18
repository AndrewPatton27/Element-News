// What the reader follows, for the Search and Following screens (rules in
// lib/followingLogic.ts). Topics: signed in -> the account's followed topics (the
// same list For you uses); signed out -> this device. Sources and companies: this
// device. Re-reads the device list whenever the screen comes back into view, so
// a follow made on Search shows up on Following.

import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useAccount } from './accountContext';
import { withTopicState } from './accountLogic';
import { FOLLOWS_KEY, effectiveFollows, parseFollows, serializeFollows, toggleValue, type Follows } from './followingLogic';
import { userMessage } from './errors';
import { defaultStore } from './storage';

const store = defaultStore();

export interface UseFollows {
  follows: Follows;
  /** Signed in but the account's topics are still loading: topic changes wait. */
  topicsLoading: boolean;
  error: string | null;
  toggleTopic(slug: string): void;
  toggleSource(name: string): void;
  toggleTicker(symbol: string): void;
}

export function useFollows(): UseFollows {
  const acct = useAccount();
  const [local, setLocal] = useState<Follows>(() => parseFollows(store.get(FOLLOWS_KEY)));
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      setLocal(parseFollows(store.get(FOLLOWS_KEY)));
    }, []),
  );

  const signedIn = acct.user !== null;
  const prefs = acct.prefs;
  const topicsLoading = signedIn && prefs === null;
  const follows = effectiveFollows(local, signedIn && prefs ? prefs.followed : null);

  const saveLocal = (next: Follows) => {
    store.set(FOLLOWS_KEY, serializeFollows(next));
    setLocal(next);
  };

  return {
    follows,
    topicsLoading,
    error,
    toggleTopic(slug) {
      setError(null);
      if (signedIn) {
        if (!prefs) return;
        const next = withTopicState(prefs, slug, prefs.followed.includes(slug) ? 'normal' : 'follow');
        acct.savePrefs(next.followed, next.hidden).catch((e) => setError(userMessage(e)));
        return;
      }
      saveLocal({ ...local, topics: toggleValue(local.topics, slug) });
    },
    toggleSource(name) {
      setError(null);
      saveLocal({ ...local, sources: toggleValue(local.sources, name) });
    },
    toggleTicker(symbol) {
      setError(null);
      saveLocal({ ...local, tickers: toggleValue(local.tickers, symbol.toUpperCase()) });
    },
  };
}
