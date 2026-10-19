// The "Daily summary" / "Weekly summary" box above the stories (designs Mobile-Brief and
// Web-Brief): a small tinted badge, 3-5 plain sentences written by the AI once per day / week,
// and the standing labels underneath (rule 5). Shown only when the brief has a summary.

import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { AppConfig, BriefSummary as BriefSummaryData } from '../../contract/types.ts';
import { summaryFooter, summaryTitle, type BriefMode } from '../../lib/brief/briefLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

function SparkIcon({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </Svg>
  );
}

export function BriefSummary({ summary, mode, config, wide }: { summary: BriefSummaryData | null; mode: BriefMode; config: AppConfig | null; wide: boolean }) {
  const p = usePalette();
  if (!summary) return null;
  const title = summaryTitle(mode);
  return (
    <View accessibilityLabel={title} style={[styles.box, wide && styles.boxWide, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={[styles.badge, { backgroundColor: p.accentSoft }]}>
        <SparkIcon color={p.accentInk} />
        <Text accessibilityRole="header" style={[styles.badgeText, { color: p.accentInk }]}>
          {title}
        </Text>
      </View>
      {summary.text.split(/\n\s*\n/).filter((para) => para.trim()).map((para, i) => (
        <Text key={i} style={[styles.text, wide && styles.textWide, { color: p.inkSoft }]}>
          {para.trim()}
        </Text>
      ))}
      <Text style={[styles.label, { color: p.muted }]}>{summaryFooter(config)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 20, borderWidth: 1, paddingVertical: 16, paddingHorizontal: 18, gap: 10 },
  boxWide: { paddingVertical: 20, paddingHorizontal: 22 },
  badge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  text: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 23 },
  textWide: { fontSize: 17, lineHeight: 27, maxWidth: 720 },
  label: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
});
