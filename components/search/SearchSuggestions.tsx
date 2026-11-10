// "Suggested for you" at the top of the empty Search screen: up to 5 stories picked for this
// reader (lib/search/suggestions.ts). A row opens the story's "More detail" sheet; the topic
// button beside it browses that topic. Nothing is drawn while loading or when there is nothing new.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard, Category } from '../../contract/types.ts';
import { cardTime, categoryName, clampHeadline } from '../../lib/shared/format';
import { OPEN_DETAIL_HINT } from '../../lib/shared/detail';
import { suggestionMeta } from '../../lib/search/suggestions';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, radius } from '../../lib/theme/theme';

export interface SearchSuggestionsProps {
  items: BlurbCard[];
  categories: Category[];
  onOpen: (card: BlurbCard) => void;
  onPickTopic: (c: { slug: string; name: string }) => void;
}

export function SearchSuggestions({ items, categories, onOpen, onPickTopic }: SearchSuggestionsProps) {
  const p = usePalette();
  const wide = useWide();
  if (items.length === 0) return null;
  return (
    <View style={styles.section} accessibilityLabel="Suggested for you" testID="search-suggestions">
      <Text style={[styles.label, { color: p.muted }]} accessibilityRole="header" aria-level={2}>
        Suggested for you
      </Text>
      <View style={[styles.list, { borderColor: p.border, backgroundColor: p.surface }]} accessibilityRole="list">
        {items.map((c, i) => {
          const topic = categoryName(c.category, categories);
          return (
            <View key={c.id} style={[styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: p.divider }]}>
              <Pressable
                onPress={() => onOpen(c)}
                accessibilityRole="button"
                accessibilityLabel={`${clampHeadline(c.headline)}. ${OPEN_DETAIL_HINT}`}
                style={({ pressed }) => [styles.main, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.meta, { color: p.muted }]} numberOfLines={1}>
                  {suggestionMeta(topic, cardTime(c))}
                </Text>
                <Text style={[styles.headline, wide && styles.headlineWide, { color: p.ink }]} numberOfLines={2}>
                  {clampHeadline(c.headline)}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => onPickTopic({ slug: c.category, name: topic })}
                accessibilityRole="button"
                accessibilityLabel={`Browse ${topic}`}
                hitSlop={6}
                style={({ pressed }) => [styles.topic, { borderColor: p.borderStrong, opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.topicText, { color: p.accentInk }]} numberOfLines={1}>
                  {topic}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  list: { borderWidth: 1, borderRadius: radius.tile, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 },
  main: { flex: 1, minWidth: 0, gap: 3, minHeight: 44, justifyContent: 'center' },
  meta: { fontFamily: fonts.sans, fontSize: 12 },
  headline: { fontFamily: fonts.serif, fontSize: 17, lineHeight: 21 },
  headlineWide: { fontSize: 19, lineHeight: 23 },
  topic: { minHeight: 44, maxWidth: 130, paddingHorizontal: 12, borderRadius: radius.chip, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  topicText: { fontFamily: fonts.sansSemi, fontSize: 13 },
});
