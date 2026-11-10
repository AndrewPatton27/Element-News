// One result tile for Search and the Following feed (design Mobile-Following / Web-Following story cards:
// white, 1 px border, 20 px corners), in the same shape as a feed card: badge and
// topic, serif headline, the key takeaways (or the summary), an optional "Because
// you follow X" line, a quiet "More detail" link, then the one-line bottom bar
// (source and time, opening the sources sheet with links to the originals; like,
// dislike, follow, share). The AI notice and the disclaimer are the screen's
// persistent strip (D-80). No images, no prices.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { categoryName, clampHeadline } from '../../lib/shared/format';
import { shareAlikeCredit } from '../../lib/shared/labels';
import { OPEN_DETAIL_HINT } from '../../lib/shared/detail';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, radius } from '../../lib/theme/theme';
import { badgeLabel } from '../card/Card';
import { PulseIcon } from '../shell/Icons';
import { ShareAlikeLine } from '../card/Labels';
import { CardBar } from '../card/CardBar';
import { CardActionRow } from '../card/CardActionRow';
import { Takeaways } from '../card/Takeaways';

export interface SearchResultCardProps {
  card: BlurbCard;
  config: AppConfig | null;
  categories: Category[];
  reason?: string | null; // Following: "Because you follow Economy"
  related?: string | null; // Following: "Update to: <headline>"
  onOpen: (card: BlurbCard) => void; // opens the "More detail" sheet
  onShowSources: (card: BlurbCard) => void;
}

export function SearchResultCard({ card, config, categories, reason, related, onOpen, onShowSources }: SearchResultCardProps) {
  const p = usePalette();
  const wide = useWide();
  const credit = shareAlikeCredit(card, config);
  const isData = card.kind === 'data';
  const dot = isData ? p.dataInk : p.accent;
  const badge = badgeLabel(card);

  return (
    <View
      accessibilityRole="summary"
      style={[styles.tile, wide ? styles.tileWide : styles.tileNarrow, { backgroundColor: p.surface, borderColor: p.border }]}
    >
      <View style={styles.topRow}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        {badge ? <Text style={[styles.badgeText, { color: isData ? p.dataInk : p.accentInk }]}>{badge}</Text> : null}
        <Text style={[styles.topic, { color: p.accentInk }]} numberOfLines={1}>
          {categoryName(card.category, categories)}
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

      {related ? <Text style={[styles.related, { color: p.muted }]}>{related}</Text> : null}

      <Takeaways card={card} fontSize={wide ? 16 : 15} lineHeight={wide ? 24 : 22} max={3} lines={4} />

      {reason ? (
        <View style={styles.reason} accessibilityLabel={reason}>
          <PulseIcon color={p.accent} size={16} />
          <Text style={[styles.reasonText, { color: p.accentInk }]}>{reason}</Text>
        </View>
      ) : null}

      <Pressable
        onPress={() => onOpen(card)}
        accessibilityRole="button"
        accessibilityLabel={`More detail: ${clampHeadline(card.headline)}`}
        style={styles.more}
      >
        <Text style={[styles.moreText, wide && styles.moreTextWide, { color: p.accentInk }]}>More detail ›</Text>
      </Pressable>

      {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}

      <CardBar card={card} onPress={() => onShowSources(card)} size={wide ? 'wide' : 'phone'}>
        <CardActionRow card={card} compact />
      </CardBar>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: radius.tile, gap: 10 },
  tileNarrow: { paddingTop: 16, paddingBottom: 8, paddingHorizontal: 18 },
  tileWide: { paddingTop: 22, paddingBottom: 12, paddingHorizontal: 24, gap: 12 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 12 },
  topic: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.2 },
  headline: { fontFamily: fonts.serif, fontSize: 21, lineHeight: 25 },
  headlineWide: { fontSize: 26, lineHeight: 30, letterSpacing: -0.26 },
  related: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reasonText: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 13 },
  more: { alignSelf: 'flex-start', minHeight: 44, marginVertical: -8, justifyContent: 'center' },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  moreTextWide: { fontSize: 15 },
});
