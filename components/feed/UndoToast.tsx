// A short message with an Undo button, shown for a few seconds (hiding a topic, following,
// a like or dislike from a swipe or arrow key).
//
// placement 'top' (default): a bar near the top of the screen.
// placement 'corner' (the feed's like / dislike toast): a small pill in the bottom-left corner,
// over the card's small print (the AI label), so it never covers the headline, the summary, the
// sources or the like / dislike buttons of the card the reader just moved to. It respects the
// safe area, is announced politely (aria-live) and keeps Undo reachable.

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export const UNDO_MS = 5000;

export function UndoToast({
  message,
  onUndo,
  onDone,
  label,
  token,
  placement = 'top',
  wide,
}: {
  message: string | null;
  onUndo: () => void;
  onDone: () => void;
  label?: string; // what screen readers hear (defaults to the message)
  token?: number; // changes with every new toast, so the same message twice restarts the timer
  placement?: 'top' | 'corner';
  wide?: boolean;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, UNDO_MS);
    return () => clearTimeout(t);
  }, [message, token, onDone]);
  if (!message) return null;
  if (placement === 'corner') {
    return (
      <View
        style={[styles.cornerDock, wide ? styles.cornerWide : styles.cornerPhone, { left: (wide ? 32 : 30) + insets.left }]}
        pointerEvents="box-none"
      >
        <View
          testID="undo-toast"
          style={[styles.pill, { backgroundColor: p.ink }]}
          accessibilityLiveRegion="polite"
          accessibilityLabel={label ?? message}
          {...({ role: 'status', 'aria-live': 'polite' } as object)}
        >
          <Text style={[styles.pillText, { color: p.bg }]} numberOfLines={1}>
            {message}
          </Text>
          <Pressable onPress={onUndo} accessibilityRole="button" accessibilityLabel="Undo" style={styles.pillUndo}>
            <Text style={[styles.pillUndoText, { color: p.accentSoft }]}>Undo</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.dock} pointerEvents="box-none">
      <View testID="undo-toast" style={[styles.toast, { backgroundColor: p.ink }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <Text style={[styles.text, { color: p.bg }]}>{message}</Text>
        <Pressable onPress={onUndo} accessibilityRole="button" hitSlop={8} style={styles.undo}>
          <Text style={[styles.undoText, { color: p.accentSoft }]}>Undo</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, top: 104, zIndex: 30, alignItems: 'center', paddingHorizontal: 16 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    maxWidth: 480,
    width: '100%',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  text: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 },
  undo: { minHeight: 32, justifyContent: 'center' },
  undoText: { fontFamily: fonts.sansSemi, fontSize: 15, textDecorationLine: 'underline' },
  // Bottom-left, over the card footer's small print. Phones: above the centred disclaimer line
  // under the card. Wide web: in the footer row of the wide card.
  cornerDock: { position: 'absolute', zIndex: 30, alignItems: 'flex-start' },
  cornerPhone: { bottom: 64 },
  cornerWide: { bottom: 40 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, maxWidth: 180, borderRadius: 18, paddingLeft: 12, paddingRight: 2 },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 13, flexShrink: 1 },
  pillUndo: { minWidth: 48, height: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  pillUndoText: { fontFamily: fonts.sansSemi, fontSize: 13, textDecorationLine: 'underline' },
});
