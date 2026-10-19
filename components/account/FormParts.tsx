// Small building blocks shared by the account screens (Me, Sign in, Create
// account, Onboarding, Reset password), from the design files
// docs/design/{mobile,web}/Mobile-Me, Mobile-SignIn and friends: the 52 px
// primary and outline buttons, the small uppercase section label, and a list
// row for the settings card.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, font } from '../../lib/theme/theme';

// Filled accent button, 52 px tall, 14 px corners. `danger` uses the warn colour
// (the two delete confirms).
export function PrimaryButton({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      aria-disabled={disabled || undefined}
      style={({ pressed }) => [styles.button, { backgroundColor: danger ? p.warn : p.accent, opacity: disabled ? 0.4 : pressed ? 0.85 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: p.onAccent }]}>{label}</Text>
    </Pressable>
  );
}

// White button with a strong outline (Cancel, Continue as guest, and so on).
export function OutlineButton({ label, onPress, color, border }: { label: string; onPress: () => void; color?: string; border?: string }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, { backgroundColor: p.surface, borderWidth: 1, borderColor: border ?? p.borderStrong, opacity: pressed ? 0.75 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: color ?? p.ink }]}>{label}</Text>
    </Pressable>
  );
}

// "CATEGORIES YOU FOLLOW": 12 px, semibold, wide-tracked, muted.
export function SectionLabel({ children }: { children: string }) {
  const p = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.sectionLabel, { color: p.muted }]}>
      {children.toUpperCase()}
    </Text>
  );
}

// One row of a list card: label on the left, an optional "›" on the right, a
// hairline above every row but the first. Pass `children` to show an expanded
// panel (a form) under the row.
export function ListRow({
  label,
  onPress,
  chevron,
  tone = 'normal',
  first,
  wide,
  children,
}: {
  label: string;
  onPress: () => void;
  chevron?: boolean;
  tone?: 'normal' | 'warn';
  first?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  const p = usePalette();
  const pad = wide ? 22 : 18;
  return (
    <View style={first ? undefined : { borderTopWidth: 1, borderTopColor: p.divider }}>
      <Pressable
        onPress={onPress}
        accessibilityRole={chevron ? 'link' : 'button'}
        style={({ pressed }) => [styles.row, { paddingHorizontal: pad, minHeight: wide ? 56 : 52, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text
          style={{
            flex: 1,
            color: tone === 'warn' ? p.warn : p.ink,
            fontSize: wide ? 17 : font.body,
            fontFamily: tone === 'warn' ? fonts.sansSemi : fonts.sans,
          }}
        >
          {label}
        </Text>
        {chevron ? <Text style={{ color: p.muted, fontSize: font.body }}>›</Text> : null}
      </Pressable>
      {children ? <View style={[styles.panel, { paddingHorizontal: pad }]}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 52, paddingHorizontal: 20, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: fonts.sansSemi, fontSize: font.body },
  sectionLabel: { fontFamily: fonts.sansSemi, fontSize: font.small, letterSpacing: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  panel: { paddingBottom: 16, gap: 10 },
});
