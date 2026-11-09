// Opens an original source. When a card id is given, the registered listener is
// told (the account layer uses it to record an 'open_source' event).

import { Linking } from 'react-native';
import { isOpenableUrl } from './safeUrl';

type Listener = (cardId: string, url: string) => void;
let listener: Listener | null = null;

export function setOpenSourceListener(fn: Listener | null) {
  listener = fn;
}

export function openUrl(url: string, cardId?: string) {
  if (!isOpenableUrl(url)) return;   // only https links ever reach the OS
  if (cardId && listener) {
    try {
      listener(cardId, url);
    } catch {
      // tracking must never block opening the source
    }
  }
  Linking.openURL(url).catch(() => undefined);
}
