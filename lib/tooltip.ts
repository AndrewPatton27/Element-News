// Hover tooltips for icon buttons. On the web the browser shows the title attribute when the
// pointer rests on the button. React Native Web drops an unknown `title` prop, so the attribute
// is set on the DOM element through a ref. Phones have no hover, so nothing is added there.
import { Platform } from 'react-native';

export function tip(text: string): { ref?: (node: unknown) => void } {
  if (Platform.OS !== 'web') return {};
  return {
    ref: (node: unknown) => {
      const el = node as { setAttribute?: (name: string, value: string) => void } | null;
      el?.setAttribute?.('title', text);
    },
  };
}
