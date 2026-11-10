// Opens an original source. When a card id is given, the registered listener is
// told (the account layer uses it to record an 'open_source' event).

import { Linking, Platform } from 'react-native';
import { buildLinkProps, type LinkProps } from './linkProps';
import { isOpenableUrl } from './safeUrl';

type Listener = (cardId: string, url: string) => void;
let listener: Listener | null = null;

export function setOpenSourceListener(fn: Listener | null) {
  listener = fn;
}

function track(url: string, cardId?: string) {
  if (cardId && listener) {
    try {
      listener(cardId, url);
    } catch {
      // tracking must never block opening the source
    }
  }
}

export function openUrl(url: string, cardId?: string) {
  if (!isOpenableUrl(url)) return;   // only https links ever reach the OS
  track(url, cardId);
  Linking.openURL(url).catch(() => undefined);
}

/** Spread onto a Pressable or Text: a real <a href> on web, Linking on phones. {} for a bad URL. */
export function linkProps(url: string, cardId?: string): Partial<LinkProps> {
  return buildLinkProps(url, Platform.OS === 'web', { track: () => track(url, cardId), open: () => openUrl(url, cardId) }) ?? {};
}
