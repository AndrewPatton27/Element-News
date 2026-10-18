// Password input with the show/hide eye. `autoComplete` tells browser password
// managers what the field is ('current-password' to fill, 'new-password' to
// suggest and save). Bump `hideSignal` after a submit to hide the text again.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { passwordToggleLabel } from '../lib/session';
import { usePalette } from '../lib/useTheme';
import { fonts, font } from '../lib/theme';
import { EyeIcon, EyeOffIcon } from './Icons';

interface Props {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder?: string;
  onSubmitEditing?: () => void;
  hideSignal?: number;
}

export function PasswordField({ label, value, onChangeText, autoComplete, placeholder, onSubmitEditing, hideSignal }: Props) {
  const p = usePalette();
  const [visible, setVisible] = useState(false);
  useEffect(() => setVisible(false), [hideSignal]);
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: p.ink }]}>{label}</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { borderColor: p.borderStrong, backgroundColor: p.surface, color: p.ink }]}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          textContentType={autoComplete === 'new-password' ? 'newPassword' : 'password'}
          placeholder={placeholder}
          placeholderTextColor={p.muted}
          accessibilityLabel={label}
          onSubmitEditing={onSubmitEditing}
        />
        <Pressable
          onPress={() => setVisible((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={passwordToggleLabel(visible)}
          aria-pressed={visible}
          hitSlop={4}
          style={({ pressed }) => [styles.eye, { opacity: pressed ? 0.6 : 1 }]}
        >
          {visible ? <EyeOffIcon color={p.inkSoft} /> : <EyeIcon color={p.inkSoft} />}
        </Pressable>
      </View>
    </View>
  );
}

// Same look for plain text inputs (email) on these forms.
export const fieldStyles = StyleSheet.create({
  label: { fontFamily: fonts.sansSemi, fontSize: font.chip },
  // Design: 52 px tall, 14 px corners, 16 px sides.
  input: { fontFamily: fonts.sans, fontSize: 16, minHeight: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16 },
});

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: fieldStyles.label,
  row: { position: 'relative', justifyContent: 'center' },
  input: { ...fieldStyles.input, paddingRight: 52 },
  eye: { position: 'absolute', right: 4, top: 4, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
