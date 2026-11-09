// Root layout: loads the fonts, picks the API (sample fixtures or Supabase),
// shows a full-screen error if the build is misconfigured, and provides shared
// data to every screen. The five tabs (Feed, Brief, Search, Following, Me) plus
// Numbers and About are peers (tab-like), not modals. On the first visit the quick
// tour (components/Tutorial.tsx) is drawn over whichever screen opened.

import { lazy, Suspense } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Per-weight imports so the web build ships only these 4 font files, not all 22.
import { Newsreader_600SemiBold } from '@expo-google-fonts/newsreader/600SemiBold';
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular';
import { InstrumentSans_500Medium } from '@expo-google-fonts/instrument-sans/500Medium';
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold';
import { getApi } from '../lib/api/api';
import { AppDataProvider } from '../lib/shared/appData';
import { AccountProvider } from '../lib/account/accountContext';
import { light, paletteFor } from '../lib/theme/theme';
import { ConfigErrorScreen } from '../components/shell/States';
import { AppErrorBoundary, ErrorBoundary } from '../components/shell/ErrorBoundary';
import { installChunkReload, type WindowLike } from '../lib/shared/crashReport';
const TutorialGate = lazy(() => import('../components/tutorial/Tutorial').then((module) => ({ default: module.TutorialGate })));

// Web: a screen file from an older deploy that fails to load outside React also reloads once
// (lib/shared/crashReport.ts explains the stale-chunk crash).
if (Platform.OS === 'web' && typeof window !== 'undefined') installChunkReload(window as unknown as WindowLike);
const noTour = () => null;

export default function RootLayout() {
  const scheme = useColorScheme();
  const p = paletteFor(scheme);
  const result = getApi();
  // If a font fails to load the app still renders with the system font.
  useFonts({
    Newsreader_600SemiBold,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
  });

  // Render immediately with system fallbacks; Expo swaps to these bundled fonts when ready.

  return (
    <SafeAreaProvider>
      <StatusBar style={p === light ? 'dark' : 'light'} />
      {result.ok ? (
        <AppErrorBoundary>
          <AppDataProvider api={result.api}>
            <AccountProvider account={result.account}>
              <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: p.bg } }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="brief" />
                <Stack.Screen name="search" />
                <Stack.Screen name="following" />
                <Stack.Screen name="numbers" />
                <Stack.Screen name="about" />
                <Stack.Screen name="account" />
                <Stack.Screen name="signin" />
                <Stack.Screen name="onboarding" />
                <Stack.Screen name="reset-password" />
                <Stack.Screen name="tutorial" />
              </Stack>
              {/* First-run tour over every screen, once per device (also at /tutorial). */}
              {/* Its own boundary: if the tour cannot load, the app still works without it. */}
              <ErrorBoundary where="tutorial" fallback={noTour}><Suspense fallback={null}><TutorialGate /></Suspense></ErrorBoundary>
            </AccountProvider>
          </AppDataProvider>
        </AppErrorBoundary>
      ) : (
        <ConfigErrorScreen error={result.error} />
      )}
    </SafeAreaProvider>
  );
}
