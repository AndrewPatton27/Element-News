// "Where this came from": bottom sheet listing every source of a card with a
// link to the original, how the card was made, and the disclaimer.

import { useRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard } from '../../contract/types.ts';
import { disclaimerText, howMadeText, primarySource } from '../../lib/shared/labels';
import { usePalette } from '../../lib/theme/useTheme';
import { MAX_COLUMN_WIDTH } from '../../lib/api/config';
import { fonts } from '../../lib/theme/theme';
import { CloseIcon } from '../shell/Icons';
import { SourceList } from './SourceList';
import { Disclaimer } from './Labels';
import { openUrl } from './SourceChip';

export function SourcesSheet({ card: openCard, config, onClose }: { card: BlurbCard | null; config: AppConfig | null; onClose: () => void }) {
  const p = usePalette();
  // Keep the last card while the sheet slides away, so it doesn't empty out first.
  const last = useRef(openCard);
  if (openCard) last.current = openCard;
  const card = openCard ?? last.current;
  const primary = card ? primarySource(card) : null;
  return (
    <Modal visible={openCard !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: p.overlay }]} onPress={onClose} accessibilityLabel="Close sources" />
      <View style={styles.dock} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: p.surface }]} accessibilityViewIsModal accessibilityLabel="Sources">
          <View style={[styles.handle, { backgroundColor: p.handle }]} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header">
              Where this came from
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={[styles.close, { backgroundColor: p.surfaceMuted }]}
            >
              <CloseIcon color={p.ink} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {card ? <SourceList card={card} config={config} /> : null}
            {card ? (
              <View style={[styles.how, { backgroundColor: p.surfaceMuted }]}>
                <Text style={[styles.howTitle, { color: p.ink }]}>How this card was made</Text>
                <Text style={[styles.howText, { color: p.inkSoft }]}>{howMadeText(card)}</Text>
              </View>
            ) : null}
          </ScrollView>
          {primary ? (
            <Pressable
              onPress={() => openUrl(primary.url, card?.id)}
              accessibilityRole="link"
              style={({ pressed }) => [styles.primary, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={[styles.primaryText, { color: p.onAccent }]}>Open the source</Text>
            </Pressable>
          ) : null}
          <Disclaimer text={disclaimerText(config)} center />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, top: '15%', alignItems: 'center', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '100%',
    width: '100%',
    maxWidth: MAX_COLUMN_WIDTH + 40,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: 28,
    gap: 16,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: fonts.serif, fontSize: 26, letterSpacing: -0.26 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  list: { gap: 12 },
  how: { gap: 6, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14 },
  howTitle: { fontFamily: fonts.sansSemi, fontSize: 14 },
  howText: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  primary: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
