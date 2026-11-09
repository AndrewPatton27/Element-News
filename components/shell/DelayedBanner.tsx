// "Updates delayed · last updated {time}" strip, shown on every screen while
// api.feed_status() reports a delay. Text carries the meaning; the amber tint is extra.

import { StyleSheet, Text } from 'react-native';
import type { FeedStatus } from '../../lib/shared/types.ts';
import { delayedBannerText } from '../../lib/status/statusLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, space } from '../../lib/theme/theme';

export function DelayedBanner({ status }: { status: FeedStatus | null }) {
  const p = usePalette();
  const text = delayedBannerText(status);
  if (!text) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: p.surfaceMuted, color: p.warn, borderBottomColor: p.border }]}
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  banner: { fontFamily: fonts.sansSemi, textAlign: 'center', fontSize: 13, paddingVertical: 6, paddingHorizontal: space.lg, borderBottomWidth: 1 },
});
