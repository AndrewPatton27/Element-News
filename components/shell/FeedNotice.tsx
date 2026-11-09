// D-80: the one persistent, quiet notice under the card area on every feed-style
// screen: "AI-generated summaries may contain errors · Informational only · Not
// investment advice". In the layout flow (never floating), so it can't cover a card,
// and outside any scroll view, so it is always visible. One line on wide web, up to
// two short lines on phones. Shell renders it when a screen passes `notice`.

import { StyleSheet, Text, View } from 'react-native';
import { feedNoticeText } from '../../lib/shared/labels';
import { useAppData } from '../../lib/shared/appData';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

// Phones: the strip is this tall at most (two lines), so the feed and any toast
// placed above it can plan around it.
export const FEED_NOTICE_MAX_HEIGHT = 40;

export function FeedNotice({ wide, insetLeft = 0 }: { wide: boolean; insetLeft?: number }) {
  const p = usePalette();
  const { config } = useAppData();
  return (
    <View
      role="note"
      aria-label="Notice"
      style={[styles.strip, wide ? styles.wide : styles.narrow, !wide && insetLeft > 0 && { paddingHorizontal: insetLeft }]}
    >
      <Text numberOfLines={wide ? 1 : 2} style={[styles.text, wide && styles.textWide, { color: p.muted }]}>
        {feedNoticeText(config)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  narrow: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6, maxHeight: FEED_NOTICE_MAX_HEIGHT },
  wide: { paddingTop: 10, paddingBottom: 2 },
  text: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 15, textAlign: 'center' },
  textWide: { fontSize: 13, lineHeight: 18 },
});
