// What Search shows before there is a query (design Mobile-Search / Web-Search):
// recent searches, "Browse by category" tiles (the suggested topics), and "Try a
// company" ticker chips. A section with nothing to show is left out.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { Category } from '../contract/types.ts';
import { SUGGESTED_TICKERS } from '../lib/searchLogic';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, radius } from '../lib/theme';

// Local icon (the shared Icons file is not ours to change): a clock for recent searches.
function ClockIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7v5l3 2" />
    </Svg>
  );
}

export interface SearchIdleProps {
  recent: string[];
  topics: Category[];
  onPickRecent: (q: string) => void;
  onClearRecent: () => void;
  onPickTopic: (c: Category) => void;
  onPickTicker: (symbol: string) => void;
}

export function SearchIdle({ recent, topics, onPickRecent, onClearRecent, onPickTopic, onPickTicker }: SearchIdleProps) {
  const p = usePalette();
  const wide = useWide();

  const recentSection =
    recent.length > 0 ? (
      <View style={[styles.section, wide && styles.half]} accessibilityLabel="Recent searches">
        <View style={styles.sectionHead}>
          <Text style={[styles.label, { color: p.muted }]}>Recent</Text>
          <Pressable onPress={onClearRecent} accessibilityRole="button" accessibilityLabel="Clear recent searches" hitSlop={10}>
            <Text style={[styles.clear, { color: p.accentInk }]}>Clear</Text>
          </Pressable>
        </View>
        {recent.map((r) => (
          <Pressable
            key={r}
            onPress={() => onPickRecent(r)}
            accessibilityRole="button"
            accessibilityLabel={`Search again: ${r}`}
            style={({ pressed }) => [styles.recent, wide && styles.recentWide, { borderTopColor: p.divider, opacity: pressed ? 0.7 : 1 }]}
          >
            <ClockIcon color={p.muted} />
            <Text style={[styles.recentText, wide && styles.recentTextWide, { color: p.ink }]} numberOfLines={1}>
              {r}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  const topicSection =
    topics.length > 0 ? (
      <View style={[styles.section, wide && styles.half]} accessibilityLabel="Browse categories">
        <Text style={[styles.label, { color: p.muted }]}>Browse by category</Text>
        <View style={styles.grid}>
          {topics.map((c) => (
            <Pressable
              key={c.slug}
              onPress={() => onPickTopic(c)}
              accessibilityRole="button"
              accessibilityLabel={`Browse ${c.name}`}
              style={({ pressed }) => [styles.tile, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.75 : 1 }]}
            >
              <Text style={[styles.tileText, { color: p.ink }]} numberOfLines={2}>
                {c.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      {recentSection || topicSection ? (
        <View style={[styles.row, wide && styles.rowWide]}>
          {recentSection}
          {topicSection}
        </View>
      ) : null}

      <View style={styles.section} accessibilityLabel="Company tickers">
        <Text style={[styles.label, { color: p.muted }]}>Try a company</Text>
        <Text style={[styles.help, wide && styles.helpWide, { color: p.inkSoft }]}>Search a ticker to see its latest cards. Element shows news, not prices.</Text>
        <View style={styles.chips}>
          {SUGGESTED_TICKERS.map((t) => (
            <Pressable
              key={t}
              onPress={() => onPickTicker(t)}
              accessibilityRole="button"
              accessibilityLabel={`Search ${t}`}
              style={({ pressed }) => [styles.chip, wide && styles.chipWide, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.75 : 1 }]}
            >
              <Text style={{ color: p.ink, fontFamily: fonts.sansMedium, fontSize: wide ? 15 : 14 }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 22 },
  row: { gap: 22 },
  rowWide: { flexDirection: 'row', flexWrap: 'wrap', gap: 36, alignItems: 'flex-start' },
  section: { gap: 8 },
  half: { flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  clear: { fontFamily: fonts.sansSemi, fontSize: 13 },
  recent: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderTopWidth: 1 },
  recentWide: { minHeight: 52 },
  recentText: { flex: 1, fontFamily: fonts.sans, fontSize: 16 },
  recentTextWide: { fontSize: 17 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  // Two per row; a last odd tile stays half width.
  tile: { width: '48.5%', minHeight: 52, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, justifyContent: 'center' },
  tileText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  help: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  helpWide: { fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: radius.chip, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipWide: { paddingHorizontal: 16 },
});
