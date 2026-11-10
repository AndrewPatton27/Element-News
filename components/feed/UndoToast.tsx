// A short message with an Undo button, shown for 5 s (hiding a topic or source, following a
// topic, unfollowing a story, a like or dislike from a swipe or arrow key).
//
// placement 'top' (default): a bar near the top of the screen.
// placement 'corner' (every feed and Following toast): a small pill in the bottom-left corner,
// over the card's small print (the AI label), so it never covers the headline, the summary, the
// sources or the like / dislike buttons of the card the reader just moved to. It respects the
// safe area, is announced politely (aria-live) and keeps Undo reachable.

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { CORNER_TOAST, cornerToastBox, undoHitMargin } from '../../lib/feed/toastPlacement';

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
      <View style={[styles.cornerDock, cornerToastBox({ wide: !!wide, insetLeft: insets.left })]} pointerEvents="box-none">
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
          {/* 44 px tap target inside a 36 px pill: the extra height is handed back with negative
              margins (react-native-web ignores hitSlop). */}
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
  // Bottom-left, over the card's small print; position and sizes in lib/feed/toastPlacement.ts.
  cornerDock: { position: 'absolute', zIndex: 30, alignItems: 'flex-start' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: CORNER_TOAST.pillHeight,
    maxWidth: CORNER_TOAST.maxWidth,
    borderRadius: CORNER_TOAST.pillHeight / 2,
    paddingLeft: 12,
    paddingRight: 2,
    overflow: 'visible',
  },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 13, flexShrink: 1 },
  pillUndo: {
    minWidth: CORNER_TOAST.hitMin,
    height: CORNER_TOAST.hitMin,
    marginVertical: undoHitMargin(),
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  pillUndoText: { fontFamily: fonts.sansSemi, fontSize: 13, textDecorationLine: 'underline' },
});
