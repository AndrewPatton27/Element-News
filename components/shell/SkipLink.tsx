// "Skip to content": the first Tab stop on every screen (web only). Hidden until it has keyboard focus, then a
// small pill at the top left; Enter moves focus to the cards (feed) or the main region (other screens) so a keyboard
// reader does not Tab through the top bar, ticker and 19 topic chips first (lib/shared/focusMain.ts).

import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { focusMain } from '../../lib/shared/focusMain';

export function SkipLink() {
  const p = usePalette();
  const [shown, setShown] = useState(false);
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Skip to content"
      testID="skip-link"
      onPress={() => { focusMain(); }}
      // react-native-web does not turn Enter into a press on a link role: handle the key itself.
      {...({ onKeyDown: (e: { key: string; preventDefault(): void }) => { if (e.key === 'Enter') { e.preventDefault(); focusMain(); } } } as object)}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      style={[styles.link, shown ? { backgroundColor: p.accent, opacity: 1 } : styles.hidden]}
    >
      <Text style={[styles.text, { color: p.onAccent }]}>Skip to content</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { position: 'absolute', top: 8, left: 8, zIndex: 100, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, justifyContent: 'center' },
  // Off screen, not display:none, so it stays the first Tab stop.
  hidden: { opacity: 0, left: -9999 },
  text: { fontFamily: fonts.sansSemi, fontSize: 15 },
});
