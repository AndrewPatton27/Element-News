import { useCallback, useEffect, useState } from 'react';
import { Platform, Share } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { useAccount } from '../account/accountContext';
import type { Feedback } from '../account/accountLogic';
import { useFollowedStories } from '../following/useFollowedStories';
import { browserShareDeps, shareLink } from '../share/shareFlow';
import { shareUrl } from '../../components/card/cardFooter';

export async function shareStory(card: BlurbCard): Promise<string | null> {
  const origin = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : null;
  const url = shareUrl(card.share_path, origin);
  if (!url) return 'No link to share for this card.';
  if (Platform.OS !== 'web') {
    try { await Share.share({ message: url, url, title: card.headline }); return null; }
    catch { return 'Could not open sharing.'; }
  }
  return shareLink(card.headline, url, browserShareDeps());
}

export function useCardActions(card: BlurbCard) {
  const account = useAccount();
  const followed = useFollowedStories();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  const reaction = account.reactions[card.id];
  const react = useCallback((pressed: Feedback) => account.react(card, pressed), [account.react, card]);
  const toggleFollow = useCallback(() => {
    const active = followed.toggle(card.id, card);
    setToast(active ? 'Following this story' : 'Stopped following this story');
  }, [followed.toggle, card]);
  const share = useCallback(async () => setToast(await shareStory(card)), [card]);
  return { reaction, react, following: followed.isFollowed(card.id), toggleFollow, share, toast, setToast };
}
