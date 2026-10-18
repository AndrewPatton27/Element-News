// A short message with an Undo button, shown for a few seconds after hiding a topic.

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';

export const UNDO_MS = 5000;

export function UndoToast({ message, onUndo, onDone }: { message: string | null; onUndo: () => void; onDone: () => void }) {
  const p = usePalette();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, UNDO_MS);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <View style={styles.dock} pointerEvents="box-none">
      <View style={[styles.toast, { backgroundColor: p.ink }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
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
});
