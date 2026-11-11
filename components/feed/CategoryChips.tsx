// Category filter: "All" plus the categories from api.categories. Scrolls
// sideways on phones, wraps on the wide web layout.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Category, CategorySlug } from '../../contract/types.ts';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

interface Props {
  categories: Category[];
  selected: CategorySlug | null;
  onSelect: (slug: CategorySlug | null) => void;
  wide?: boolean;
  onEdit?: () => void; // signed in: a last chip that opens Account → Your topics
}

export function CategoryChips({ categories, selected, onSelect, wide, onEdit }: Props) {
  const p = usePalette();
  const items: { slug: CategorySlug | null; name: string }[] = [{ slug: null, name: 'All' }, ...categories];
  const chips = items.map((c) => {
    const on = c.slug === selected;
    return (
      <Pressable
        key={c.slug ?? 'all'}
        onPress={() => onSelect(c.slug)}
        accessibilityRole="tab"
        aria-selected={on}
        style={({ pressed }) => [
          styles.chip,
          { borderColor: on ? p.accent : p.borderStrong, backgroundColor: on ? p.accentSoft : p.surface, opacity: pressed ? 0.75 : 1 },
        ]}
      >
        <Text style={[styles.text, { color: on ? p.accentInk : p.inkSoft, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }]}>{c.name}</Text>
      </Pressable>
    );
  });
  if (onEdit) {
    chips.push(
      <Pressable
        key="edit"
        onPress={onEdit}
        accessibilityRole="link"
        accessibilityLabel="Edit topics"
        style={({ pressed }) => [
          styles.chip,
          { borderColor: p.borderStrong, borderStyle: 'dashed', backgroundColor: 'transparent', opacity: pressed ? 0.75 : 1 },
        ]}
      >
        <Text style={[styles.text, { color: p.accentInk, fontFamily: fonts.sansSemi }]}>Edit topics</Text>
      </Pressable>,
    );
  }
  if (wide) {
    return (
      <View style={styles.wrap} accessibilityRole="tablist">
        {chips}
      </View>
    );
  }
  return <ChipScroller>{chips}</ChipScroller>;
}

// Edge fade bands (page colour, most opaque at the very edge): the row is cut off at the screen's edge on
// phones, so a fade on the side that still has chips says "there is more" (I-03). Hidden once the end is reached.
const FADE_STEPS = [0.95, 0.7, 0.45, 0.2];

function ChipScroller({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  const [m, setM] = useState({ x: 0, w: 0, content: 0 });
  const more = m.content > m.w + 1 && m.x + m.w < m.content - 4;
  const before = m.x > 4;
  const fade = (side: 'left' | 'right') => (
    <View pointerEvents="none" testID={`chips-fade-${side}`} style={[styles.fade, side === 'left' ? styles.fadeLeft : styles.fadeRight]}>
      {FADE_STEPS.map((o) => (
        <View key={o} style={{ flex: 1, backgroundColor: p.bg, opacity: o }} />
      ))}
    </View>
  );
  return (
    <View style={styles.scroller}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        accessibilityRole="tablist"
        scrollEventThrottle={64}
        onLayout={(e) => setM((o) => ({ ...o, w: e.nativeEvent.layout.width }))}
        onContentSizeChange={(w) => setM((o) => ({ ...o, content: w }))}
        onScroll={(e) => setM((o) => ({ ...o, x: e.nativeEvent.contentOffset.x }))}
      >
        {children}
      </ScrollView>
      {before ? fade('left') : null}
      {more ? fade('right') : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, flexShrink: 0 },
  // Mobile-Final: 44 px pills (full touch target), 16 px page padding.
  row: { gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fade: { position: 'absolute', top: 0, bottom: 0, width: 28, flexDirection: 'row' },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0, flexDirection: 'row-reverse' },
  chip: { height: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, justifyContent: 'center' },
  text: { fontSize: 14 },
});

// Wide web: the vertical "Categories" list on the left (design Web-Final). Same
// choices as the chips; the active one is a tint pill. Signed in: "Edit topics" last.
export function CategoryList({ categories, selected, onSelect, onEdit }: Omit<Props, 'wide'>) {
  const p = usePalette();
  const items: { slug: CategorySlug | null; name: string }[] = [{ slug: null, name: 'All' }, ...categories];
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Categories" style={listStyles.list}>
      <Text style={[listStyles.label, { color: p.muted }]}>Categories</Text>
      {items.map((c) => {
        const on = c.slug === selected;
        return (
          <Pressable
            key={c.slug ?? 'all'}
            onPress={() => onSelect(c.slug)}
            accessibilityRole="tab"
            aria-selected={on}
            style={({ pressed }) => [listStyles.item, { backgroundColor: on ? p.accentSoft : 'transparent', opacity: pressed ? 0.75 : 1 }]}
          >
            <Text style={{ fontSize: 16, color: on ? p.accentInk : p.inkSoft, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }}>{c.name}</Text>
          </Pressable>
        );
      })}
      {onEdit ? (
        <Pressable onPress={onEdit} accessibilityRole="link" accessibilityLabel="Edit topics" style={listStyles.item}>
          <Text style={{ fontSize: 15, color: p.accentInk, fontFamily: fonts.sansSemi }}>Edit topics</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const listStyles = StyleSheet.create({
  list: { gap: 2 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 12, paddingBottom: 8 },
  item: { minHeight: 44, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center' },
});
