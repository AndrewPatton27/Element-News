// Loading, empty and error states, plus the full-screen configuration error.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const p = usePalette();
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <ActivityIndicator color={p.accent} />
      <Text style={[styles.text, { color: p.muted }]}>{label}</Text>
    </View>
  );
}

// The feed's first paint: the outline of a card where the first card will land, in the same
// shape as the static splash in the built index.html (a white card with a 22-24 px radius), so
// splash -> skeleton -> card reads as one surface filling in rather than three different screens.
// Still (no shimmer): it is on screen for a moment and motion would only add noise.
export function CardSkeleton({ label = 'Loading the feed…', wide }: { label?: string; wide?: boolean }) {
  const p = usePalette();
  const bar = (w: `${number}%`, h: number, extra?: object) => <View style={[{ width: w, height: h, borderRadius: h / 2, backgroundColor: p.surfaceMuted }, extra]} />;
  return (
    <View style={[styles.skelPage, wide && styles.skelPageWide]} accessibilityLiveRegion="polite" accessibilityLabel={label}>
      <View style={[styles.skelCard, wide && styles.skelCardWide, { backgroundColor: p.surface, borderColor: p.border }]}>
        {bar('28%', 24, { borderRadius: 12 })}
        <View style={styles.skelMiddle}>
          {bar('92%', wide ? 34 : 24, { borderRadius: 8 })}
          {bar('64%', wide ? 34 : 24, { borderRadius: 8 })}
          <View style={styles.skelGap} />
          {bar('86%', 12)}
          {bar('78%', 12)}
          {bar('52%', 12)}
        </View>
        <View style={[styles.skelBar, { borderTopColor: p.divider }]}>{bar('30%', 12)}</View>
      </View>
      <Text style={[styles.skelText, { color: p.muted }]}>{label}</Text>
    </View>
  );
}

// Empty: a short serif title saying what happened, one plain line on what to do, and the way out.
export function EmptyState({ title, message, actionLabel, onAction }: { title?: string; message: string; actionLabel?: string; onAction?: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.center}>
      {title ? <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header" aria-level={2}>{title}</Text> : null}
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
      style={({ pressed }) => [styles.button, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}
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
  skelPage: { flex: 1, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14, gap: 10 },
  skelPageWide: { paddingHorizontal: 0, paddingTop: 0 },
  skelCard: { flex: 1, maxHeight: 560, borderWidth: 1, borderRadius: 24, padding: 20, gap: 16 },
  skelCardWide: { maxHeight: 640, paddingTop: 40, paddingHorizontal: 44 },
  skelMiddle: { flex: 1, justifyContent: 'center', gap: 10 },
  skelGap: { height: 10 },
  skelBar: { borderTopWidth: 1, paddingTop: 16, paddingBottom: 6 },
  skelText: { fontFamily: fonts.sans, fontSize: 13, textAlign: 'center' },
  button: { minHeight: 48, paddingHorizontal: 24, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
