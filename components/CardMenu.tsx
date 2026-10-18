// The card's "⋯" options (everyone; signed out the choice is kept on this device): hide this
// card's topic or source. A small sheet
// with large tap targets; Escape / back / tapping outside closes it.

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard, Category } from '../contract/types.ts';
import { categoryName } from '../lib/format';
import { cardSourceKey, sourceName } from '../lib/sourceKeys';
import { usePalette } from '../lib/useTheme';
import { fonts, radius, font } from '../lib/theme';

interface Props {
  card: BlurbCard | null;
  categories: Category[];
  onHideTopic: (card: BlurbCard) => void;
  /** When the server supports hidden sources and the card's source can be switched off. */
  onHideSource?: (card: BlurbCard, key: string) => void;
  onClose: () => void;
}

export function CardMenu({ card, categories, onHideTopic, onClose, onHideSource }: Props) {
  const p = usePalette();
  const topic = card ? categoryName(card.category, categories) : '';
  const sourceKey = card && onHideSource ? cardSourceKey(card) : null;
  return (
    <Modal visible={card !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: p.overlay }]} onPress={onClose} accessibilityLabel="Close options" />
      <View style={styles.center} pointerEvents="box-none">
        <View style={[styles.menu, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityViewIsModal accessibilityLabel="Card options">
          <Pressable
            onPress={() => card && onHideTopic(card)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.item, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.itemText, { color: p.ink }]}>Hide {topic} topics</Text>
            <Text style={[styles.hint, { color: p.muted }]}>You won’t see {topic} cards. Change it any time in Account.</Text>
          </Pressable>
          {sourceKey && card && onHideSource ? (
            <Pressable
              onPress={() => onHideSource(card, sourceKey)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.item, styles.divided, { borderTopColor: p.divider, opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.itemText, { color: p.ink }]}>Hide cards from {sourceName(sourceKey)}</Text>
              <Text style={[styles.hint, { color: p.muted }]}>Turn it back on any time in Account → Sources.</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={({ pressed }) => [styles.item, styles.cancel, { borderTopColor: p.divider, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.cancelText, { color: p.accentInk }]}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  menu: { width: '100%', maxWidth: 360, borderRadius: radius.tile, borderWidth: 1, overflow: 'hidden' },
  item: { minHeight: 52, paddingVertical: 14, paddingHorizontal: 20, gap: 4, justifyContent: 'center' },
  itemText: { fontFamily: fonts.sansSemi, fontSize: font.body },
  hint: { fontFamily: fonts.sans, fontSize: font.meta, lineHeight: 18 },
  divided: { borderTopWidth: 1 },
  cancel: { borderTopWidth: 1, alignItems: 'center' },
  cancelText: { fontFamily: fonts.sansSemi, fontSize: font.body },
});
