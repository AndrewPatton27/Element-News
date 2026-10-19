import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function FollowPill({ topic, followed, onPress }: { topic: string; followed: boolean; onPress: () => void }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      focusable
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={followed ? `Following ${topic}, double tap to unfollow` : `Follow ${topic}`}
      aria-pressed={followed}
      style={({ pressed }) => [
        styles.pill,
        {
          borderColor: focused ? p.accentInk : followed ? p.accent : p.borderStrong,
          borderWidth: focused ? 3 : 1,
          backgroundColor: followed ? p.accentSoft : hovered ? p.surfaceMuted : p.surface,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      <View style={[styles.icon, { borderColor: followed ? p.accentInk : p.inkSoft }]}>
        {followed ? <Text style={[styles.glyph, { color: p.accentInk }]}>✓</Text> : <Text style={[styles.glyph, { color: p.inkSoft }]}>+</Text>}
      </View>
      <Text style={[styles.label, { color: followed ? p.accentInk : p.ink }] }>{followed ? 'Following' : 'Follow'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 10, borderWidth: 1, borderRadius: 22, flexShrink: 0 },
  icon: { width: 16, height: 16, borderWidth: 1.4, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontFamily: fonts.sansSemi, fontSize: 12, lineHeight: 14 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12 },
});
