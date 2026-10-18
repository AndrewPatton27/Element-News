// "Numbers to know" card and the weekly "Trends" card for the Brief screen.
// Numbers: label + the agency that produced it, big value, change as glyph + word (colour
// is extra). Each row opens the original series. The required notices (FRED) sit under it.
// Trends: one chart at a time with previous / next and dots (no auto-rotation here).

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import type { MacroFact, NumberTrend, RequiredNotice } from '../contract/types.ts';
import { trendA11yLabel } from '../lib/briefLogic';
import { changeText, factA11yLabel } from '../lib/format';
import { withToneLabel } from '../lib/numberTone';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { changeColor } from './DataCard';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';
import { openUrl } from './SourceChip';
import { BASELINE, CHART_H, CHART_W, chartShape, stepIndex, trendColors } from './trendChart';

export function BriefNumbers({
  facts,
  notices,
  onAll,
  wide,
  title = 'Numbers to know',
}: {
  facts: MacroFact[];
  notices: RequiredNotice[];
  onAll?: () => void;
  wide: boolean;
  title?: string;
}) {
  const p = usePalette();
  if (facts.length === 0) return null;
  return (
    <View accessibilityLabel={title} style={[styles.card, wide && styles.cardWide, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.cardHead}>
        <Text accessibilityRole="header" style={[styles.label, { color: p.muted }]}>
          {title}
        </Text>
        {onAll ? (
          <Pressable onPress={onAll} accessibilityRole="link" accessibilityLabel="See all numbers" style={styles.all}>
            <Text style={[styles.allText, { color: p.accent }]}>{wide ? 'All ›' : 'All numbers ›'}</Text>
          </Pressable>
        ) : null}
      </View>
      {facts.map((f) => {
        const change = changeText(f);
        return (
          <Pressable
            key={f.series_id}
            onPress={() => openUrl(f.source_url)}
            accessibilityRole="link"
            accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
            style={({ pressed }) => [styles.row, { borderTopColor: p.divider, opacity: pressed ? 0.75 : 1 }]}
          >
            <View style={styles.rowLeft}>
              <Text style={[styles.rowLabel, { color: p.ink }]}>{f.label}</Text>
              <Text style={[styles.rowSource, { color: p.muted }]}>{f.source_short}</Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={[styles.value, { color: p.ink }]}>{f.value}</Text>
              {change ? <Text style={[styles.change, { color: changeColor(p, f) }]}>{change}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {notices.map((n) => (
        <Text
          key={n.key}
          style={[styles.notice, { color: p.muted }]}
          onPress={n.url ? () => openUrl(n.url as string) : undefined}
          accessibilityRole={n.url ? 'link' : 'text'}
        >
          {n.text}
        </Text>
      ))}
    </View>
  );
}

export function BriefMovers({ movers, wide }: { movers: NumberTrend[]; wide: boolean }) {
  const p = usePalette();
  const [i, setI] = useState(0);
  if (movers.length === 0) return null;
  const s = movers[Math.min(i, movers.length - 1)];
  const shape = chartShape(s.points);
  const { delta: tone, line } = trendColors(p, s.key, s.direction);
  return (
    <View accessibilityLabel="Number trends" style={[styles.trends, wide && styles.cardWide, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.trendHead}>
        <View style={styles.trendTitle}>
          <Text accessibilityRole="header" style={[styles.label, { color: p.muted }]}>
            Trends · 12 weeks
          </Text>
          <Text style={[styles.trendName, { color: p.ink }]}>{s.name}</Text>
        </View>
        {movers.length > 1 ? (
          <View style={styles.arrows}>
            <Pressable onPress={() => setI((n) => stepIndex(n, -1, movers.length))} accessibilityRole="button" accessibilityLabel="Previous chart" style={styles.arrow}>
              <ChevronLeftIcon color={p.ink} />
            </Pressable>
            <Pressable onPress={() => setI((n) => stepIndex(n, 1, movers.length))} accessibilityRole="button" accessibilityLabel="Next chart" style={styles.arrow}>
              <ChevronRightIcon color={p.ink} />
            </Pressable>
          </View>
        ) : null}
      </View>
      <View style={styles.valueRow} accessible accessibilityLabel={withToneLabel(trendA11yLabel(s), s.key, s.direction)}>
        <Text style={[styles.big, { color: p.ink }]}>{s.value}</Text>
        <Text style={[styles.change, { color: tone }]}>{s.change}</Text>
      </View>
      {shape ? (
        <>
          <Svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            style={styles.chart}
            {...({ role: 'img', 'aria-label': `Line chart of ${s.name} over the last 12 weeks, now ${s.value}` } as object)}
          >
            <Line x1={8} y1={BASELINE} x2={592} y2={BASELINE} stroke={p.border} strokeWidth={1} />
            <Line x1={8} y1={85} x2={592} y2={85} stroke={p.divider} strokeWidth={1} />
            <Path d={shape.area} fill={line} fillOpacity={0.1} />
            <Polyline points={shape.points} fill="none" stroke={line} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
            <Circle cx={shape.cx} cy={shape.cy} r={7} fill={line} />
          </Svg>
          <View style={styles.axis}>
            <Text style={[styles.small, { color: p.muted }]}>12 weeks ago</Text>
            <Text style={[styles.small, { color: p.muted }]}>Now</Text>
          </View>
        </>
      ) : null}
      {movers.length > 1 ? (
        <View style={styles.dots}>
          {movers.map((t, k) => (
            <Pressable key={t.key} onPress={() => setI(k)} accessibilityRole="button" accessibilityLabel={`Show ${t.name}`} aria-pressed={k === i} style={styles.dotHit}>
              <View style={{ width: k === i ? 24 : 8, height: 8, borderRadius: 4, backgroundColor: k === i ? p.accent : p.borderStrong }} />
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={[styles.small, styles.trendSource, { color: p.muted }]}>Source: {s.source}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: 1, paddingTop: 16, paddingHorizontal: 18, paddingBottom: 6 },
  cardWide: { paddingTop: 18, paddingHorizontal: 20 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 6 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  all: { minHeight: 44, justifyContent: 'center' },
  allText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 56, paddingVertical: 6, borderTopWidth: 1 },
  rowLeft: { flex: 1, gap: 1 },
  rowLabel: { fontFamily: fonts.sansSemi, fontSize: 15 },
  rowSource: { fontFamily: fonts.sans, fontSize: 12 },
  rowRight: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 0 },
  value: { fontFamily: fonts.serif, fontSize: 20 },
  change: { fontFamily: fonts.sansSemi, fontSize: 12 },
  notice: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, paddingVertical: 8 },
  trends: { borderRadius: 20, borderWidth: 1, paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6, gap: 8 },
  trendHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  trendTitle: { flex: 1, gap: 2 },
  trendName: { fontFamily: fonts.sansSemi, fontSize: 15 },
  arrows: { flexDirection: 'row', gap: 2 },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  big: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 36, letterSpacing: -0.68 },
  chart: { width: '100%', aspectRatio: CHART_W / CHART_H },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  small: { fontFamily: fonts.sans, fontSize: 12 },
  dots: { flexDirection: 'row', justifyContent: 'center' },
  dotHit: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  trendSource: { paddingBottom: 8 },
});
