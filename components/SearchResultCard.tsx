// One result tile for Search and Following (design Mobile-Following / Web-Following
// story cards: white, 1 px border, 20 px corners). Badge and topic, serif headline,
// the summary, an optional "Because you follow X" line, the source row (opens the
// sources sheet with links to the originals), then the small print: the AI label
// where an AI wrote the text, and the disclaimer, once. No images, no prices.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../contract/types.ts';
import { cardTime, categoryName, clampHeadline } from '../lib/format';
import { cardLabels, shareAlikeCredit } from '../lib/labels';
import { OPEN_DETAIL_HINT } from '../lib/detail';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, radius } from '../lib/theme';
import { badgeLabel } from './Card';
import { PulseIcon } from './Icons';
import { ShareAlikeLine } from './Labels';
import { SourceRow } from './SourceChip';
import { footerLabels } from './cardFooter';

export interface SearchResultCardProps {
  card: BlurbCard;
  config: AppConfig | null;
  categories: Category[];
  reason?: string | null; // Following: "Because you follow Economy"
  onOpen: (card: BlurbCard) => void; // opens the "More detail" sheet
  onShowSources: (card: BlurbCard) => void;
}

export function SearchResultCard({ card, config, categories, reason, onOpen, onShowSources }: SearchResultCardProps) {
  const p = usePalette();
  const wide = useWide();
  const labels = cardLabels(card, config);
  const small = footerLabels(labels.aiLabel, labels.disclaimer, true); // one line: "AI label · disclaimer"
  const credit = shareAlikeCredit(card, config);
  const isData = card.kind === 'data';
  const dot = isData ? p.dataInk : p.accent;

  return (
    <View
      accessibilityRole="summary"
      style={[styles.tile, wide ? styles.tileWide : styles.tileNarrow, { backgroundColor: p.surface, borderColor: p.border }]}
    >
      <View style={styles.topRow}>
        <View style={styles.badge}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={[styles.badgeText, { color: isData ? p.dataInk : p.accentInk }]}>{badgeLabel(card)}</Text>
        </View>
        <Text style={[styles.topic, { color: p.muted }]} numberOfLines={1}>
          {categoryName(card.category, categories)} · {cardTime(card)}
        </Text>
      </View>

      <Pressable
        onPress={() => onOpen(card)}
        accessibilityRole="button"
        accessibilityLabel={`${clampHeadline(card.headline)}. ${OPEN_DETAIL_HINT}`}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <Text style={[styles.headline, wide && styles.headlineWide, { color: p.ink }]}>{clampHeadline(card.headline)}</Text>
      </Pressable>

      {card.body ? (
        <Text style={[styles.body, wide && styles.bodyWide, { color: p.inkBody }]} numberOfLines={4}>
          {card.body}
        </Text>
      ) : null}

      {reason ? (
        <View style={styles.reason} accessibilityLabel={reason}>
          <PulseIcon color={p.accent} size={16} />
          <Text style={[styles.reasonText, { color: p.accentInk }]}>{reason}</Text>
        </View>
      ) : null}

      <SourceRow card={card} onShowAll={() => onShowSources(card)} wide={wide} />

      <View style={[styles.foot, { borderTopColor: p.divider }]}>
        <Pressable
          onPress={() => onOpen(card)}
          accessibilityRole="button"
          accessibilityLabel={`More detail: ${clampHeadline(card.headline)}`}
          style={styles.more}
        >
          <Text style={[styles.moreText, wide && styles.moreTextWide, { color: p.accent }]}>More detail ›</Text>
        </Pressable>
      </View>

      <View style={styles.small}>
        {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
        <Text style={[styles.smallText, { color: p.muted }]}>{small.footer}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: radius.tile, gap: 10 },
  tileNarrow: { paddingVertical: 16, paddingHorizontal: 18 },
  tileWide: { paddingVertical: 22, paddingHorizontal: 24, gap: 12 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 12 },
  topic: { flexShrink: 1, fontFamily: fonts.sans, fontSize: 12 },
  headline: { fontFamily: fonts.serif, fontSize: 21, lineHeight: 25 },
  headlineWide: { fontSize: 26, lineHeight: 30, letterSpacing: -0.26 },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  bodyWide: { fontSize: 16, lineHeight: 24 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reasonText: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 13 },
  foot: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, paddingTop: 2, marginHorizontal: -8 },
  more: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  moreTextWide: { fontSize: 15 },
  small: { gap: 2 },
  smallText: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
});
