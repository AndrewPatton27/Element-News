// The source row on a card: primary outlet and document. Tapping it opens the
// sources sheet, which links to every original page.

import { Pressable, StyleSheet, Text } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { primarySource, sourcesText } from '../../lib/shared/labels';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { LinkIcon } from '../shell/Icons';

export { openUrl } from '../../lib/shared/openUrl';

export function SourceRow({ card, onShowAll, wide }: { card: BlurbCard; onShowAll: () => void; wide?: boolean }) {
  const p = usePalette();
  const primary = primarySource(card);
  if (!primary) return null;
  const total = Math.max(card.source_count, card.sources.length);
  const title = primary.doc_label ? `${primary.name} · ${primary.doc_label}` : primary.name;
  return (
    <Pressable
      onPress={onShowAll}
      accessibilityRole="button"
      accessibilityLabel={`Sources: ${sourcesText(card)}. Opens the list with links to the originals.`}
      style={({ pressed }) => [styles.row, wide && styles.rowWide, { backgroundColor: p.surfaceMuted, opacity: pressed ? 0.75 : 1 }]}
    >
      <LinkIcon color={p.ink} />
      <Text style={[styles.title, wide && styles.titleWide, { color: p.ink }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={[styles.count, wide && styles.countWide, { color: p.muted }]}>
        {total} source{total === 1 ? '' : 's'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, borderRadius: 12 },
  rowWide: { minHeight: 48, paddingHorizontal: 16 },
  title: { flex: 1, fontFamily: fonts.sansSemi, fontSize: 15 },
  titleWide: { fontSize: 16 },
  count: { fontFamily: fonts.sans, fontSize: 13 },
  countWide: { fontSize: 14 },
});
