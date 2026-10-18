// Loading, empty and error states, plus the full-screen configuration error.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const p = usePalette();
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <ActivityIndicator color={p.accent} />
      <Text style={[styles.text, { color: p.muted }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.center}>
      <Text style={[styles.text, { color: p.muted }]}>{message}</Text>
      {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

export function ErrorState({ title = 'Could not load the feed', message, onRetry }: { title?: string; message: string; onRetry: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.center} accessibilityRole="alert">
      <Text style={[styles.title, { color: p.ink }]}>{title}</Text>
      <Text style={[styles.text, { color: p.muted }]}>{message}</Text>
      <Button label="Try again" onPress={onRetry} />
    </View>
  );
}

// Shown instead of the app when the build is misconfigured, so a deployed site
// never falls back to sample cards without anyone noticing.
export function ConfigErrorScreen({ error }: { error: string }) {
  const p = usePalette();
  return (
    <View style={[styles.full, { backgroundColor: p.bg }]} accessibilityRole="alert">
      <Text style={[styles.title, { color: p.up }]}>App configuration error</Text>
      <Text style={[styles.text, { color: p.ink }]}>{error}</Text>
      <Text style={[styles.text, { color: p.muted }]}>Set the EXPO_PUBLIC_* values in .env and rebuild.</Text>
    </View>
  );
}

export function Button({ label, onPress }: { label: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
    >
      <Text style={[styles.buttonText, { color: p.onAccent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  full: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontFamily: fonts.serif, fontSize: 24, textAlign: 'center' },
  text: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 22, textAlign: 'center', maxWidth: 420 },
  button: { minHeight: 48, paddingHorizontal: 24, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
