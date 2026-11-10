// The card body under the headline: the card's own key points as 2-4 bullets, or
// its 2-3 sentence summary when it has fewer than two key points (lib/shared/cardBody.ts
// decides; nothing is written here). Shared by the feed card and the list tiles.

import { Platform, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { cardTakeaways } from '../../lib/shared/cardBody';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

interface Props {
  card: BlurbCard;
  fontSize: number;
  lineHeight: number;
  max?: number; // bullets that fit
  lines?: number; // cap for the summary paragraph (list tiles)
  maxWidth?: number;
}

export function Takeaways({ card, fontSize, lineHeight, max, lines, maxWidth }: Props) {
  const p = usePalette();
  const body = cardTakeaways(card, max);
  if (body.kind === 'none') return null;
  if (body.kind === 'summary') {
    return (
      <Text numberOfLines={lines} style={[styles.text, { color: p.inkBody, fontSize, lineHeight, maxWidth }]}>
        {body.text}
      </Text>
    );
  }
  const dot = Math.max(5, Math.round(fontSize * 0.32));
  return (
    <View role="list" aria-label="Key points" style={[styles.list, { gap: Math.round(lineHeight * 0.4), maxWidth }]}>
      {body.points.map((point, i) => (
        <View key={i} role="listitem" style={styles.item}>
          <View style={[styles.dotBox, { height: lineHeight }]}>
            <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: p.accent }} />
          </View>
          <Text style={[styles.text, styles.itemText, { color: p.inkBody, fontSize, lineHeight }]}>{point}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {},
  item: { flexDirection: 'row', gap: 12 },
  dotBox: { justifyContent: 'center' },
  // Very long words (tickers glued together, URLs) wrap instead of running off the card.
  text: { fontFamily: fonts.sans, ...(Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as object) : {}) },
  itemText: { flex: 1, minWidth: 0 },
});
