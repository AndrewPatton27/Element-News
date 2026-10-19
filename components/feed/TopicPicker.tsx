// Multi-select topic chips (onboarding and account), from the "Categories you
// follow" chips in the Me design: 44 px tall pills, selected = accent outline on
// the soft tint. Selected chips show a check mark as well as the accent colour,
// so the state is never colour-only.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Category } from '../../contract/types.ts';
import { toggleTopic } from '../../lib/account/accountLogic';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { LoadingState } from '../shell/States';

export function TopicChip({
  label,
  on,
  onPress,
  accessibilityLabel,
  mark = '✓ ',
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  mark?: string; // shown before the name when on (never colour-only)
}) {
  const p = usePalette();
  const wide = useWide();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      aria-checked={on}
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.chip,
        { paddingHorizontal: wide ? 16 : 14, borderColor: on ? p.accent : p.borderStrong, backgroundColor: on ? p.accentSoft : p.surface, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Text style={{ fontSize: wide ? font.body - 1 : font.chip, color: on ? p.accentInk : p.inkSoft, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }}>
        {on ? mark : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function TopicPicker({ categories, selected, onChange }: { categories: Category[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (categories.length === 0) return <LoadingState label="Loading topics…" />;
  return (
    <View style={styles.wrap} accessibilityRole="list">
      {categories.map((c) => (
        <TopicChip key={c.slug} label={c.name} on={selected.includes(c.slug)} onPress={() => onChange(toggleTopic(selected, c.slug))} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, borderRadius: radius.chip, borderWidth: 1, justifyContent: 'center' },
});
