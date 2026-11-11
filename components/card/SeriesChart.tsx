// The small line chart of a data card: the recent history of the card's series (one line), or the 2/5/10/30-year
// Treasury lines on the daily yield-curve card. The latest reading is a dot with a ring; the line follows the
// tone of the change (green good, red bad, otherwise the brand accent), and direction is still said in words by
// the card, so colour is extra. No animation (nothing to reduce), react-native-svg only, readable at 360 px.
// The card still shows the number, the agency citation and the FRED notice around it (rule 8).
// Feed cards use a short chart; the detail sheet passes `detail` for a taller one with the low/high line.

import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import type { BlurbCard } from '../../contract/types.ts';
import { chartGeometry, chartSpec, describeChart, rangeText, spanPhrase, usableSeries } from '../../lib/history/seriesHistory';
import { useSeriesHistory } from '../../lib/history/useSeriesHistory';
import { trendColors } from './trendChart';
import { usePalette } from '../../lib/theme/useTheme';
import type { Palette } from '../../lib/theme/theme';
import { fonts } from '../../lib/theme/theme';

// The svgs are decoration: the wrapper (role img + the sentence) is what a screen reader meets (same pattern as Icons.tsx).
const DECORATIVE =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as object)
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
const CAPTION_H = 16;
const LEGEND_H = 18;

// One look per maturity: colour AND dash differ, so the lines never rely on colour alone (the legend names them).
function curveStyle(p: Palette, id: string): { color: string; dash?: string; width: number } {
  if (id === 'DGS2') return { color: p.inkSoft, dash: '2 4', width: 2 };
  if (id === 'DGS5') return { color: p.dataInk, dash: '7 4', width: 2 };
  if (id === 'DGS30') return { color: p.ink, width: 1.75 };
  return { color: p.accent, width: 2.75 };
}

export function SeriesChart({ card, height, detail }: { card: BlurbCard; height: number; detail?: boolean }) {
  const p = usePalette();
  const spec = chartSpec(card);
  const state = useSeriesHistory(spec);
  const [w, setW] = useState(0);
  if (!spec || height <= 0 || state.status === 'none') return null;
  // A mini chart (short cards): just the line, no caption or legend; the sentence is still there for screen readers.
  const mini = height < 34;
  const reserved = mini ? height : height + CAPTION_H + (spec.curve ? LEGEND_H : 0) + 6;
  if (state.status === 'loading') return <View style={{ height: reserved }} />;

  const usable = usableSeries(spec, state.history);
  const main = usable.find((s) => s.id === (spec.curve ? 'DGS10' : spec.series[0])) ?? usable[0];
  const fact = (spec.curve ? card.macro.find((f) => f.series_id === 'DGS10') : card.macro[0]) ?? card.macro[0];
  const geo = chartGeometry(usable, w, height, detail ? { l: 8, r: 10, t: 10, b: 10 } : { l: 4, r: 8, t: 8, b: 6 });
  const label = describeChart(fact, spec, state.history);
  const single = !spec.curve ? trendColors(p, fact.series_id, fact.direction).line : p.accent;
  const span = spanPhrase(main.frequency, main.points[0].date, main.points[main.points.length - 1].date).replace(/^the last/, 'Last');
  const latestRaw = main.points[main.points.length - 1].value;
  const range = detail && geo && !spec.curve ? rangeText(geo.lines[0], fact.value, latestRaw) : null;

  return (
    <View style={styles.wrap} testID="series-chart">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}
        style={{ height }}
      >
        {geo ? (
          <Svg width={w} height={height} {...DECORATIVE}>
            {geo.lines.map((l) => {
              const s = spec.curve ? curveStyle(p, l.id) : { color: single, dash: undefined, width: detail ? 2.5 : 2.25 };
              const key = l.id === 'DGS10' || !spec.curve;
              return (
                <G key={l.id}>
                  {l.area ? <Path d={l.area} fill={s.color} fillOpacity={0.12} /> : null}
                  <Path d={l.d} fill="none" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" />
                  {key ? (
                    <>
                      <Circle cx={l.last.x} cy={l.last.y} r={detail ? 7 : 6} fill={s.color} fillOpacity={0.22} />
                      <Circle cx={l.last.x} cy={l.last.y} r={detail ? 3.5 : 3} fill={s.color} />
                    </>
                  ) : (
                    <Circle cx={l.last.x} cy={l.last.y} r={2.5} fill={s.color} />
                  )}
                  {detail && !spec.curve ? (
                    <>
                      <Circle cx={l.min.x} cy={l.min.y} r={3} fill={p.dataPanel} stroke={s.color} strokeWidth={1.5} />
                      <Circle cx={l.max.x} cy={l.max.y} r={3} fill={p.dataPanel} stroke={s.color} strokeWidth={1.5} />
                    </>
                  ) : null}
                </G>
              );
            })}
          </Svg>
        ) : null}
      </View>
      {mini ? null : <Text numberOfLines={1} style={[styles.caption, { color: p.inkSoft }]}>{range ? `${span} · ${range}` : span}</Text>}
      {spec.curve && !mini ? (
        <View style={styles.legend}>
          {usable.map((s) => {
            const st = curveStyle(p, s.id);
            const last = s.points[s.points.length - 1].value;
            return (
              <View key={s.id} style={styles.legendItem}>
                {/* the swatch is decoration: the words next to it name the maturity */}
                <View>
                  <Svg width={18} height={8} {...DECORATIVE}>
                    <Path d="M1 4 L17 4" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} strokeLinecap="round" />
                  </Svg>
                </View>
                <Text style={[styles.legendText, { color: p.dataInk }]}>{`${s.id.replace(/^DGS(\d+)$/, '$1Y')} ${last.toFixed(2)}%`}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 3 },
  caption: { fontFamily: fonts.sans, fontSize: 12, lineHeight: CAPTION_H },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendText: { fontFamily: fonts.sansSemi, fontSize: 12, lineHeight: 16 },
});
