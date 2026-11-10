// "More detail": opened by tapping a card. Bottom sheet on phones, centered panel
// on wide screens. Topic, headline, the source line (same as the feed card's bar: agency
// and time, opening the original), key points, the in-depth paragraphs (or the card's
// summary with a note when there is none), the sources, the Wikipedia credit,
// the AI label and the disclaimer (a standalone view, so it keeps both texts itself, D-80).
// The body is DetailBody.tsx, shared with the /b/<id> share page.
// The Modal traps focus; Escape / back closes.

import { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SheetModal } from '../shell/SheetModal';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { categoryName } from '../../lib/shared/format';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { CloseIcon } from '../shell/Icons';
import { DetailActions } from './DetailActions';
import { DetailBody } from './DetailBody';

interface Props {
  card: BlurbCard | null;
  config: AppConfig | null;
  categories: Category[];
  onClose: () => void;
}

export function DetailSheet({ card: openCard, config, categories, onClose }: Props) {
  const p = usePalette();
  const wide = useWide();
  // Keep the last card while the sheet moves away, so it doesn't empty out first.
  const last = useRef(openCard);
  if (openCard) last.current = openCard;
  const card = openCard ?? last.current;
  if (!card) return null;

  return (
    <SheetModal
      open={openCard !== null}
      onClose={onClose}
      variant={wide ? 'panel' : 'sheet'}
      label={`More detail: ${card.headline}`}
      backdropLabel="Close detail"
      dockStyle={wide ? styles.center : styles.dock}
      surfaceStyle={wide ? styles.panel : styles.sheet}
      handle={!wide}
      header={
          <View style={styles.header}>
            <Text style={[styles.meta, { color: p.accentInk }]} numberOfLines={1}>
              {categoryName(card.category, categories)}
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
      }
    >
          <ScrollView style={wide ? undefined : styles.scroll} contentContainerStyle={styles.body}>
            <DetailBody card={card} config={config} />
          </ScrollView>
          <DetailActions card={card} />
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  // Mobile-Source: the sheet starts 52 px from the top; 28 px corners; 18 px between blocks.
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 52, alignItems: 'center', justifyContent: 'flex-end' },
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 32 },
  sheet: {
    height: '100%',
    width: '100%',
    maxWidth: 520,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
    paddingHorizontal: 20,
    overflow: 'hidden',
  },
  panel: { maxHeight: '90%', width: '100%', maxWidth: 680, borderRadius: 24, paddingTop: 20, paddingHorizontal: 32, paddingBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 8, marginRight: -4 },
  meta: { fontFamily: fonts.sansSemi, fontSize: 14, letterSpacing: 0.2, flexShrink: 1 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  body: { gap: 18, paddingTop: 4, paddingBottom: 28 },
  scroll: { flex: 1 },
});
