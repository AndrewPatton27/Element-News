// "Numbers to know": the macro numbers, each with a plain-language line, the
// change (glyph + word), the original agency, and the FRED notice.

import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppData } from '../lib/appData';
import { disclaimerText } from '../lib/labels';
import { NUMBERS_LEGEND } from '../lib/numberTone';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { Disclaimer } from '../components/Labels';
import { NumbersPanel } from '../components/NumbersPanel';
import { ChevronLeftIcon } from '../components/Icons';
import { Shell } from '../components/Shell';

export default function NumbersScreen() {
  const p = usePalette();
  const { api, config } = useAppData();
  const router = useRouter();
  // Back to wherever the reader came from; fall back to the feed on a direct load.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <Shell active="numbers" scroll>
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={10}
        style={({ pressed }) => [styles.back, { opacity: pressed ? 0.6 : 1 }]}
      >
        <ChevronLeftIcon color={p.ink} size={24} />
        <Text style={[styles.backText, { color: p.ink }]}>Back</Text>
      </Pressable>
      <View style={styles.header}>
        <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header">
          Numbers to know
        </Text>
        <Text style={[styles.sub, { color: p.muted }]}>Key numbers that shape prices, jobs and loans. Latest official readings.</Text>
        <Text style={[styles.legend, { color: p.muted }]}>{NUMBERS_LEGEND}</Text>
      </View>
      <NumbersPanel api={api} config={config} variant="full" />
      <Disclaimer text={disclaimerText(config)} center />
    </Shell>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', paddingVertical: 4, marginLeft: -6 },
  backText: { fontFamily: fonts.sans, fontSize: 15 },
  header: { gap: 4, paddingBottom: 4 },
  title: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 37, letterSpacing: -0.5 },
  sub: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  legend: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
});
