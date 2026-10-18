// Category filter: "All" plus the categories from api.categories. Scrolls
// sideways on phones, wraps on the wide web layout.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Category, CategorySlug } from '../contract/types.ts';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';

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
  return (
    <ScrollView
      horizontal
      style={styles.scroller}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="tablist"
    >
      {chips}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, flexShrink: 0 },
  // Mobile-Final: 44 px pills (full touch target), 16 px page padding.
  row: { gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
