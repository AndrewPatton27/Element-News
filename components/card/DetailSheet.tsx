// "More detail": opened by tapping a card. Bottom sheet on phones, centered panel
// on wide screens. Headline, key points, the in-depth paragraphs (or the card's
// summary with a note when there is none), the sources, the Wikipedia credit,
// the AI label and the disclaimer. The Modal traps focus; Escape / back closes.

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { NO_DETAIL_MESSAGE, cardDetail, detailParagraphs } from '../../lib/shared/detail';
import { cardTime, categoryName, clampHeadline } from '../../lib/shared/format';
import { cardLabels, shareAlikeCredit } from '../../lib/shared/labels';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { CloseIcon } from '../shell/Icons';
import { AiLabel, Disclaimer, ShareAlikeLine } from './Labels';
import { SourceList } from './SourceList';
import { DataFacts } from './DataCard';
import { DetailActions } from './DetailActions';

interface Props {
  card: BlurbCard | null;
  config: AppConfig | null;
  categories: Category[];
  onClose: () => void;
}

export function DetailSheet({ card, config, categories, onClose }: Props) {
  const p = usePalette();
  const wide = useWide();
  if (!card) return <Modal visible={false} transparent onRequestClose={onClose} />;

  const detail = cardDetail(card);
  const { paragraphs, fallback } = detailParagraphs(card);
  const labels = cardLabels(card, config);
  const credit = shareAlikeCredit(card, config);

  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: p.overlay }]} onPress={onClose} accessibilityLabel="Close detail" />
      <View style={wide ? styles.center : styles.dock} pointerEvents="box-none">
        <View
          style={[wide ? styles.panel : styles.sheet, { backgroundColor: p.surface }]}
          accessibilityViewIsModal
          accessibilityLabel={`More detail: ${card.headline}`}
        >
          {wide ? null : <View style={[styles.handle, { backgroundColor: p.handle }]} />}
          <View style={styles.header}>
            <Text style={[styles.meta, { color: p.muted }]}>
              {categoryName(card.category, categories)} · {cardTime(card)}
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
          <ScrollView style={wide ? undefined : styles.scroll} contentContainerStyle={styles.body}>
            <Text style={[styles.headline, { color: p.ink }]} accessibilityRole="header">
              {clampHeadline(card.headline)}
            </Text>

            {detail && detail.key_points.length ? (
              <View style={[styles.points, { backgroundColor: p.surfaceMuted }]}>
                <Text style={[styles.h3, { color: p.ink }]} accessibilityRole="header">
                  Key points
                </Text>
                {detail.key_points.map((k, i) => (
                  <View key={i} style={styles.point}>
                    <Text style={[styles.bullet, { color: p.inkSoft }]}>•</Text>
                    <Text style={[styles.pointText, { color: p.inkSoft }]}>{k}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {card.kind === 'data' ? <DataFacts card={card} config={config} /> : null}

            {paragraphs.map((t, i) => (
              <Text key={i} style={[styles.para, { color: p.inkSoft }]}>
                {t}
              </Text>
            ))}
            {fallback ? <Text style={[styles.note, { color: p.muted }]}>{NO_DETAIL_MESSAGE}</Text> : null}

            <View style={styles.sources}>
              <Text style={[styles.h3, { color: p.ink }]} accessibilityRole="header">
                Sources
              </Text>
              <SourceList card={card} config={config} plain />
            </View>

            <View style={styles.labels}>
              {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
              {labels.aiLabel ? <AiLabel text={labels.aiLabel} /> : null}
              <Disclaimer text={labels.disclaimer} />
            </View>
          </ScrollView>
          <DetailActions card={card} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
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
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 8, marginRight: -4 },
  meta: { fontFamily: fonts.sans, fontSize: 14, flexShrink: 1 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  body: { gap: 18, paddingTop: 4, paddingBottom: 28 },
  headline: { fontFamily: fonts.serif, fontSize: 28, lineHeight: 31, letterSpacing: -0.56 },
  points: { borderRadius: 18, paddingVertical: 16, paddingHorizontal: 18, gap: 8 },
  h3: { fontFamily: fonts.sansSemi, fontSize: 15 },
  point: { flexDirection: 'row', gap: 8 },
  bullet: { fontFamily: fonts.sansSemi, fontSize: 16, lineHeight: 22 },
  pointText: { flex: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
  para: { fontFamily: fonts.sans, fontSize: 17, lineHeight: 26 },
  note: { fontFamily: fonts.sansMedium, fontSize: 14, fontStyle: 'italic' },
  sources: { gap: 10 },
  scroll: { flex: 1 },
  labels: { gap: 2 },
});
