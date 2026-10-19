// React error boundary. A render-time exception anywhere below it is caught here
// instead of white-screening the whole app. Two variants:
//   • AppErrorBoundary — full-screen "Something went wrong" + Try again (resets).
//   • CardErrorBoundary — a tiny inline "This card could not be shown" line, so one
//     bad card never blanks the feed.
// A class component is required: componentDidCatch/getDerivedStateFromError have no
// hook equivalent.

import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { light, fonts, font } from '../../lib/theme/theme';

interface Props {
  children: ReactNode;
  // Rendered instead of the default full-screen fallback (used for the per-card line).
  fallback?: (reset: () => void) => ReactNode;
  // Bumping this key (e.g. the active card id) clears a caught error so a new child
  // gets a fresh render instead of staying stuck on the fallback.
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Keep a trace in dev; never surface the raw error to the user.
    if (process.env.NODE_ENV !== 'production') console.error('ErrorBoundary caught', error);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) this.setState({ hasError: false });
  }

  reset = (): void => this.setState({ hasError: false });

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);
    return <AppFallback onReset={this.reset} />;
  }
}

// Full-screen app-level fallback. Palette is read from `light` directly (no hooks in
// a class, and the app is light-only for now — see lib/theme.ts).
function AppFallback({ onReset }: { onReset: () => void }) {
  return (
    <View style={[styles.full, { backgroundColor: light.bg }]} accessibilityRole="alert">
      <Text style={[styles.title, { color: light.ink }]}>Something went wrong</Text>
      <Text style={[styles.text, { color: light.muted }]}>Something went wrong. The app hit an unexpected error.</Text>
      <Pressable
        onPress={onReset}
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, { backgroundColor: light.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        <Text style={[styles.buttonText, { color: light.onAccent }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

// App-level: wrap the whole tree. A caught error shows the full-screen fallback.
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

// Per-card: a tiny line in place of the card so the feed keeps working. `resetKey`
// should be the card id so a recycled list row renders the next card cleanly.
export function CardErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey?: unknown }) {
  return (
    <ErrorBoundary resetKey={resetKey} fallback={() => <CardFallback />}>
      {children}
    </ErrorBoundary>
  );
}

function CardFallback() {
  return (
    <View style={styles.cardFallback} accessibilityRole="alert">
      <Text style={[styles.cardFallbackText, { color: light.muted }]}>This card could not be shown.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontFamily: fonts.serif, fontSize: 24, textAlign: 'center' },
  text: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 22, textAlign: 'center', maxWidth: 420 },
  button: { minHeight: 48, paddingHorizontal: 24, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontFamily: fonts.sansSemi, fontSize: 16 },
  cardFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  cardFallbackText: { fontFamily: fonts.sans, fontSize: font.small, lineHeight: 17, textAlign: 'center' },
});
