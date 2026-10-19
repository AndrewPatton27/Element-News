// The Follow / Following pill (design: the pulse button on the Following cards).
// Off: outlined. On: tinted with a check, so the state is never colour-only.

import { Pressable, StyleSheet, Text } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { PulseIcon } from '../shell/Icons';

export function FollowingButton({ name, following, onPress }: { name: string; following: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: following }}
      accessibilityLabel={following ? `Stop following ${name}` : `Follow ${name}`}
      style={({ pressed }) => [
        styles.pill,
        { borderColor: p.accent, backgroundColor: following ? p.accentSoft : p.surface, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <PulseIcon color={following ? p.accentInk : p.accent} size={18} strokeWidth={2} />
      <Text style={[styles.text, { color: following ? p.accentInk : p.accent }]}>{following ? '✓ Following' : 'Follow'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1 },
  text: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
