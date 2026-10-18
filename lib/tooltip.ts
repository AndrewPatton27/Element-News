// Hover tooltips for icon buttons. On the web the browser shows the title attribute when the
// pointer rests on the button; phones have no hover, so nothing is added there.
import { Platform } from 'react-native';

export function tip(text: string): Record<string, string> {
  return Platform.OS === 'web' ? { title: text } : {};
}
