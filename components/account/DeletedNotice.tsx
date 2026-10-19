// Confirmation after something was deleted: a centred dialog with one primary button back to
// the feed. Shown only after the delete succeeded and the local state is already cleared.
// Dismissible (backdrop, Android back / Escape, or the button).

import { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { DELETED_HOME, deletedContent, type DeletedKind } from '../../lib/account/deletedNotice';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { PrimaryButton } from './FormParts';

export function DeletedNotice({ kind, onClose }: { kind: DeletedKind | null; onClose: () => void }) {
  const p = usePalette();
  const last = useRef<DeletedKind>('device');
  if (kind) last.current = kind;
  const c = deletedContent(kind ?? last.current);
  const wrap = useRef<any>(null);

  // Keyboard focus lands on the dialog when it opens (web), so Tab stays inside and the reader
  // hears the title. Native ignores this.
  useEffect(() => {
    if (!kind) return;
    const t = setTimeout(() => (wrap.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => clearTimeout(t);
  }, [kind]);

  const home = () => {
    onClose();
    router.navigate(DELETED_HOME as never);
  };

  return (
    <Modal visible={kind !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: p.overlay }]} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.center} pointerEvents="box-none">
        <View
          ref={wrap}
          focusable
          tabIndex={-1}
          accessibilityViewIsModal
          accessibilityRole="alert"
          accessibilityLabel={c.label}
          style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}
        >
          <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header">
            {c.title}
          </Text>
          <Text style={[styles.body, { color: p.inkSoft }]}>{c.body}</Text>
          <PrimaryButton label={c.button} onPress={home} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: radius.tile, padding: 22, gap: 14 },
  title: { fontFamily: fonts.serif, fontSize: 24, letterSpacing: -0.2 },
  body: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
});
