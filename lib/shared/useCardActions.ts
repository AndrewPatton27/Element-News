import { useCallback, useEffect, useState } from 'react';
import { Platform, Share } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { useAccount } from '../account/accountContext';
import type { Feedback } from '../account/accountLogic';
import { useFollowedStories } from '../following/useFollowedStories';
import { shareUrl } from '../../components/card/cardFooter';

export async function shareStory(card: BlurbCard): Promise<string | null> {
  const origin = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : null;
  const url = shareUrl(card.share_path, origin);
  if (!url) return 'No link to share for this card.';
  if (Platform.OS !== 'web') {
    try { await Share.share({ message: url, url, title: card.headline }); return null; }
    catch { return 'Could not open sharing.'; }
  }
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (nav && typeof nav.share === 'function') {
    try { await nav.share({ title: card.headline, url }); return null; }
    catch (e) { if ((e as { name?: string } | null)?.name === 'AbortError') return null; }
  }
  try {
    await nav?.clipboard?.writeText(url);
    return nav?.clipboard ? 'Link copied' : 'Could not copy link.';
  } catch { return 'Could not copy link.'; }
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
