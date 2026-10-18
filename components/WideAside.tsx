// Wide web right column (design Web-Final): "Top stories · last week" (numbered list
// of 5 from api.topStories) and "Trends · 12 weeks" (a chart slideshow from
// api.numberTrends, rotating every 7 s, with prev / next and dots). Each section is
// left out when its list is empty.

import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import type { BlurbCard, Category, NumberTrend } from '../contract/types.ts';
import type { Api } from '../lib/api.ts';
import { cardTime, categoryName } from '../lib/format';
import { trendA11yLabel } from '../lib/briefLogic';
import { withToneLabel } from '../lib/numberTone';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { pickTopStories } from '../lib/diversify.ts';
import { badgeLabel } from './Card';
import { CardActionRow } from './CardActionRow';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';
import { BASELINE, CHART_H, CHART_W, chartShape, stepIndex, storiesToShow, trendColors } from './trendChart';

const ROTATE_MS = 7000;


export interface AsideData {
  loading: boolean;
  stories: BlurbCard[];
  trends: NumberTrend[];
}

function safeList<T>(f: () => Promise<T[]>): Promise<T[]> {
  return f().catch(() => []);
}

// Loads both lists once. A failure just leaves that section empty (it is extra, not core).
export function useAsideData(api: Api, enabled = true): AsideData {
  const [state, setState] = useState<AsideData>({ loading: true, stories: [], trends: [] });
  useEffect(() => {
    if (!enabled) return; // phones and narrow windows never make the two calls
    let alive = true;
    Promise.all([safeList(() => api.topStories()), safeList(() => api.numberTrends()), safeList(() => api.feed({ mode: 'top', limit: 30 }).then((page) => page.items))]).then(([top, trends, more]) => {
      // A wider candidate list lets pickTopStories choose five stories that are not related to each other.
      const seen = new Set<string>();
      const stories = [...top, ...more].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).slice(0, 25);
      if (alive) setState({ loading: false, stories, trends });
    });
    return () => {
      alive = false;
    };
  }, [api, enabled]);
  return state;
}

export function WideAside({
  data,
  categories,
  onOpenStory,
}: {
  data: AsideData;
  categories: Category[];
  onOpenStory: (card: BlurbCard) => void;
}) {
  // Tight mode: on short windows (1366x768 laptops) fewer stories, so the trend chart
  // still shows without scrolling the column.
  const { height } = useWindowDimensions();
  const count = storiesToShow(height);
  return (
    <View>
      <TopStories stories={pickTopStories(data.stories, count)} categories={categories} onOpen={onOpenStory} />
      <TrendsCard trends={data.trends} />
    </View>
  );
}

function TopStories({ stories, categories, onOpen }: { stories: BlurbCard[]; categories: Category[]; onOpen: (c: BlurbCard) => void }) {
  const p = usePalette();
  if (stories.length === 0) return null;
  return (
    <View accessibilityRole="list" accessibilityLabel="Top stories of the last week">
      <Text style={[styles.label, { color: p.muted }]}>Top stories · last week</Text>
      {stories.map((c, i) => (
        <Pressable
          key={c.id}
          onPress={() => onOpen(c)}
          accessibilityRole="button"
          accessibilityLabel={`${i + 1}. ${c.headline}. Opens more detail`}
          style={({ pressed }) => [styles.story, { borderTopColor: p.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.rank, { color: p.accent }]}>{i + 1}</Text>
          <View style={styles.storyText}>
            <Text style={[styles.meta, { color: p.muted }]}>
              {[badgeLabel(c), categoryName(c.category, categories), cardTime(c)].filter(Boolean).join(' · ')}
            </Text>
            <Text style={[styles.storyTitle, { color: p.ink }]}>{c.headline}</Text>
            <CardActionRow card={c} compact />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function TrendsCard({ trends }: { trends: NumberTrend[] }) {
  const p = usePalette();
  const [i, setI] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [held, setHeld] = useState(false); // pointer over or focus inside: do not rotate
  const box = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const el = box.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el || typeof el.addEventListener !== 'function') return;
    const on = () => setHeld(true);
    const off = () => setHeld(false);
    const evs: [string, () => void][] = [['mouseenter', on], ['mouseleave', off], ['focusin', on], ['focusout', off]];
    evs.forEach(([e, h]) => el.addEventListener(e, h));
    return () => evs.forEach(([e, h]) => el.removeEventListener(e, h));
  }, [trends.length > 0]);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(setReduced)
      .catch(() => undefined);
  }, []);
  // Restarting the timer on every change means a manual click gives a full 7 s before the next slide.
  useEffect(() => {
    if (reduced || held || trends.length < 2) return;
    const t = setInterval(() => setI((n) => stepIndex(n, 1, trends.length)), ROTATE_MS);
    return () => clearInterval(t);
  }, [reduced, held, trends.length, i]);
  if (trends.length === 0) return null;

  const s = trends[Math.min(i, trends.length - 1)];
  const shape = chartShape(s.points);
  const { delta: tone, line } = trendColors(p, s.key, s.direction);
  return (
    <View ref={box} accessibilityLabel="Number trends" style={[styles.trends, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.trendHead}>
        <View style={styles.trendTitle}>
          <Text style={[styles.label, styles.noPad, { color: p.muted }]}>Trends · 12 weeks</Text>
          <Text style={[styles.trendName, { color: p.ink }]}>{s.name}</Text>
        </View>
        {trends.length > 1 ? (
          <View style={styles.arrows}>
            <Pressable
              onPress={() => setI((n) => stepIndex(n, -1, trends.length))}
              accessibilityRole="button"
              accessibilityLabel="Previous chart"
              style={[styles.round, { borderColor: p.borderStrong, backgroundColor: p.surface }]}
            >
              <ChevronLeftIcon color={p.ink} />
            </Pressable>
            <Pressable
              onPress={() => setI((n) => stepIndex(n, 1, trends.length))}
              accessibilityRole="button"
              accessibilityLabel="Next chart"
              style={[styles.round, { borderColor: p.borderStrong, backgroundColor: p.surface }]}
            >
              <ChevronRightIcon color={p.ink} />
            </Pressable>
          </View>
        ) : null}
      </View>
      <View style={styles.valueRow} accessible accessibilityLabel={withToneLabel(trendA11yLabel(s), s.key, s.direction)}>
        <Text style={[styles.value, { color: p.ink }]}>{s.value}</Text>
        <Text style={[styles.change, { color: tone }]}>{s.change}</Text>
      </View>
      {shape ? (
        <Svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={styles.chart}
          {...({ role: 'img', 'aria-label': `Line chart of ${s.name} over the last 12 weeks, now ${s.value}` } as object)}
        >
          <Line x1={8} y1={BASELINE} x2={592} y2={BASELINE} stroke={p.border} strokeWidth={1} />
          <Line x1={8} y1={85} x2={592} y2={85} stroke={p.divider} strokeWidth={1} />
          <Path d={shape.area} fill={line} fillOpacity={0.1} />
          <Polyline points={shape.points} fill="none" stroke={line} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          <Circle cx={shape.cx} cy={shape.cy} r={5.5} fill={line} />
        </Svg>
      ) : null}
      <View style={styles.foot}>
        <Text style={[styles.source, { color: p.muted }]}>Source: {s.source}</Text>
        {trends.length > 1 ? (
          <View style={styles.dots}>
            {trends.map((t, k) => (
              <Pressable
                key={t.key}
                onPress={() => setI(k)}
                accessibilityRole="button"
                accessibilityLabel={`Show ${t.name}`}
                aria-pressed={k === i}
                style={styles.dotHit}
              >
                <View style={{ width: k === i ? 24 : 8, height: 8, borderRadius: 4, backgroundColor: k === i ? p.accent : p.borderStrong }} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', paddingBottom: 10 },
  noPad: { paddingBottom: 0 },
  story: { flexDirection: 'row', gap: 14, paddingVertical: 14, borderTopWidth: 1, minHeight: 44 },
  rank: { fontFamily: fonts.serif, fontSize: 22, lineHeight: 24, minWidth: 22 },
  storyText: { flex: 1, gap: 4 },
  meta: { fontFamily: fonts.sans, fontSize: 12 },
  storyTitle: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 23 },
  trends: { marginTop: 20, borderRadius: 20, borderWidth: 1, paddingTop: 16, paddingHorizontal: 18, paddingBottom: 8, gap: 8 },
  trendHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  trendTitle: { flex: 1, gap: 2 },
  trendName: { fontFamily: fonts.sansSemi, fontSize: 15 },
  arrows: { flexDirection: 'row', gap: 6 },
  round: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  value: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 36, letterSpacing: -0.68 },
  change: { fontFamily: fonts.sansSemi, fontSize: 13 },
  chart: { width: '100%', aspectRatio: CHART_W / CHART_H },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  source: { fontFamily: fonts.sans, fontSize: 12, flexShrink: 1 },
  dots: { flexDirection: 'row', gap: 4 },
  dotHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
