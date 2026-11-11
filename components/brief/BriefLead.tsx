// The "In 30 seconds" lead above the brief summary: three bullets, the first three stories in the
// macro-first order (Fed and government before single companies; D-119). Built from the cards,
// no AI call, so it needs no AI label. Each bullet opens the same detail sheet as the stories.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function BriefLead({ cards, onOpen, wide }: { cards: BlurbCard[]; onOpen: (card: BlurbCard) => void; wide: boolean }) {
  const p = usePalette();
  if (cards.length === 0) return null;
  return (
    <View accessibilityLabel="In 30 seconds" testID="brief-lead" style={[styles.box, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Text accessibilityRole="header" aria-level={2} style={[styles.title, { color: p.ink }]}>
        In 30 seconds
      </Text>
      {cards.map((c) => (
        <Pressable key={c.id} onPress={() => onOpen(c)} accessibilityRole="button" accessibilityLabel={`Open: ${c.headline}`} style={styles.row}>
          <Text style={[styles.dot, { color: p.accent }]}>•</Text>
          <Text style={[styles.text, wide && styles.textWide, { color: p.ink }]}>{c.headline}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 20, borderWidth: 1, paddingVertical: 14, paddingHorizontal: 18, gap: 6 },
  title: { fontFamily: fonts.sansSemi, fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: 10, minHeight: 36, paddingVertical: 4, alignItems: 'flex-start' },
  dot: { fontFamily: fonts.sansSemi, fontSize: 16, lineHeight: 22 },
  text: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15, lineHeight: 22 },
  textWide: { fontSize: 16, lineHeight: 24 },
});
