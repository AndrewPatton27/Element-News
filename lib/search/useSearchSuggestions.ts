// Loads "Suggested for you" for the empty Search screen (rules in lib/search/suggestions.ts).
// One request per reader (signed in: For you; signed out or if For you fails: Trending), then the
// list is filtered again whenever what the reader has seen, hidden or followed changes. Failures
// show nothing: suggestions are optional and must never break Search.

import { useEffect, useMemo, useState } from 'react';
import type { BlurbCard } from '../../contract/types.ts';
import { useAppData } from '../shared/appData';
import { useAccount } from '../account/accountContext';
import { readSeen } from '../feed/forYouGate.ts';
import { defaultStore } from '../storage/storage';
import { SUGGESTION_FETCH, guestOrder, pickSuggestions, seenIdsOf } from './suggestions.ts';

const store = defaultStore();

export function useSearchSuggestions(active: boolean): { items: BlurbCard[]; loaded: boolean } {
  const { api } = useAppData();
  const acct = useAccount();
  const uid = acct.user?.id ?? null;
  const [loaded, setLoaded] = useState<{ uid: string | null; cards: BlurbCard[]; personal: boolean } | null>(null);
  const need = active && (loaded === null || loaded.uid !== uid);

  useEffect(() => {
    if (!need) return;
    let alive = true;
    void (async () => {
      let cards: BlurbCard[] = [];
      let personal = false;
      if (uid) {
        try {
          cards = (await acct.account.feedForYou(null, SUGGESTION_FETCH)).items;
          personal = true;
        } catch {
          cards = [];
        }
      }
      if (!personal) {
        try {
          cards = (await api.feed({ mode: 'top', limit: SUGGESTION_FETCH })).items;
        } catch {
          cards = [];
        }
      }
      if (alive) setLoaded({ uid, cards: Array.isArray(cards) ? cards : [], personal });
    })();
    return () => {
      alive = false;
    };
  }, [need, uid, api, acct.account]);

  const prefs = acct.viewPrefs;
  const local = acct.localPrefs;
  const reactions = acct.reactions;
  const items = useMemo(() => {
    if (!loaded || loaded.uid !== uid) return [];
    const ordered = loaded.personal ? loaded.cards : guestOrder(loaded.cards, local);
    return pickSuggestions(ordered, {
      seenIds: seenIdsOf(readSeen(store), reactions),
      hiddenTopics: prefs?.hidden ?? [],
      hiddenSources: prefs?.hiddenSources ?? [],
    });
  }, [loaded, uid, local, reactions, prefs]);

  return { items, loaded: loaded !== null && loaded.uid === uid };
}
