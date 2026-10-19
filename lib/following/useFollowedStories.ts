// Followed stories as a hook: every card and the Following page update at once.

import { useCallback, useEffect, useState } from 'react';
import type { BlurbCard } from '../../contract/types.ts';
import { defaultStore, onStoreChange } from '../storage/storage';
import { FOLLOWED_STORIES_KEY, isStoryFollowed, parseFollowedStories, serializeFollowedStories, toggleStory, type FollowedStory } from './followedStories';

const store = defaultStore();

export function useFollowedStories() {
  const [list, setList] = useState<FollowedStory[]>(() => parseFollowedStories(store.get(FOLLOWED_STORIES_KEY)));
  useEffect(
    () =>
      onStoreChange((k) => {
        if (k === FOLLOWED_STORIES_KEY) setList(parseFollowedStories(store.get(FOLLOWED_STORIES_KEY)));
      }),
    [],
  );
  const toggle = useCallback((id: string, card?: BlurbCard): boolean => {
    const cur = parseFollowedStories(store.get(FOLLOWED_STORIES_KEY));
    const next = toggleStory(cur, id, Date.now(), card);
    store.set(FOLLOWED_STORIES_KEY, serializeFollowedStories(next));
    return isStoryFollowed(next, id);
  }, []);
  return { stories: list, isFollowed: (id: string) => isStoryFollowed(list, id), toggle };
}
