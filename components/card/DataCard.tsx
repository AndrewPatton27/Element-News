// The big-number panel of a data card: label, value, change (glyph + word,
// colour is extra), period or date and the agency citation, then the FRED notice.

import { StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, MacroFact } from '../../contract/types.ts';
import { changeText, factA11yLabel } from '../../lib/shared/format';
import { factWhen } from '../../lib/numbers/numbersUpdated';
import { cardNotices } from '../../lib/shared/labels';
import { changeToneColor, withToneLabel } from '../../lib/numbers/numberTone';
import { usePalette } from '../../lib/theme/useTheme';
import type { Palette } from '../../lib/theme/theme';
import { fonts } from '../../lib/theme/theme';
import { openUrl } from './SourceChip';

// Green = generally good for households, red = generally bad, gray = no change
// or neither (see lib/numberTone.ts). The glyph and word carry the direction.
export function changeColor(p: Palette, f: Pick<MacroFact, 'series_id' | 'direction'>): string {
  return changeToneColor(p, f.series_id, f.direction);
}

export function DataFacts({ card, config, compact }: { card: BlurbCard; config: AppConfig | null; compact?: boolean }) {
  const p = usePalette();
  const notices = cardNotices(card, config);
  // One number gets the design's 64 px. Two or more sit side by side, smaller,
  // with the change on its own line, so the card still fits a phone screen.
  const multi = card.macro.length > 1;
  const valueSize = multi ? 34 : compact ? 44 : 64;
  return (
    <View style={styles.wrap}>
      <View style={[styles.panel, multi && styles.panelMulti, { backgroundColor: p.dataPanel }]}>
        {card.macro.map((f, i) => (
          <View
            key={f.series_id}
            style={[styles.fact, multi && styles.factMulti, multi && i > 0 && { borderLeftWidth: 1, borderLeftColor: p.border, paddingLeft: 14 }]}
            accessible
            accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
          >
            <Text style={[styles.label, { color: p.dataInk }]}>{f.label}</Text>
            <View style={[styles.valueRow, multi && styles.valueCol]}>
              <Text style={[styles.value, { color: p.ink, fontSize: valueSize, lineHeight: Math.round(valueSize * 1.05), letterSpacing: -valueSize * 0.02 }]}>{f.value}</Text>
              {changeText(f) ? <Text style={[styles.change, { color: changeColor(p, f) }]}>{changeText(f)}</Text> : null}
            </View>
            <Text style={[styles.cite, multi && styles.citeMulti, { color: p.inkSoft }]}>
              {factWhen(f)} · {f.source_short}
            </Text>
          </View>
        ))}
      </View>
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

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  // Feed-Data draft: cream panel, 18/20 padding, uppercase label, 64 px serif number.
  panel: { borderRadius: 18, paddingVertical: 18, paddingHorizontal: 20, gap: 10 },
  panelMulti: { flexDirection: 'row', gap: 14, paddingHorizontal: 16, paddingVertical: 16 },
  fact: { gap: 6 },
  factMulti: { flex: 1, minWidth: 0 },
  valueCol: { flexDirection: 'column', alignItems: 'flex-start' },
  citeMulti: { fontSize: 13 },
  label: { fontFamily: fonts.sansSemi, fontSize: 13, letterSpacing: 0.26, textTransform: 'uppercase' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12 },
  value: { fontFamily: fonts.serif },
  change: { fontFamily: fonts.sansSemi, fontSize: 15 },
  cite: { fontFamily: fonts.sans, fontSize: 15 },
  notice: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, fontStyle: 'italic' },
});
