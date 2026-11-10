// The big-number panel of a data card: label, value, change (glyph + word,
// colour is extra), period or date and the agency citation, then the FRED notice.
// When every number shares one date and agency (two Treasury yields from the same release),
// the citation is said once, full width, under the numbers: less repetition, and on short
// phones the change and the citation both fit without scrolling (rule 8 keeps the agency).

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

export function DataFacts({ card, config, compact, dense }: { card: BlurbCard; config: AppConfig | null; compact?: boolean; dense?: boolean }) {
  const p = usePalette();
  const notices = cardNotices(card, config);
  // One number gets the design's 64 px. Two short ones sit side by side, smaller, with the change
  // on its own line. Three numbers, or any long value ("10,284.57"), become rows (label and
  // citation left, value and change right), so a number never breaks across lines (break-ui).
  const multi = card.macro.length > 1;
  const rows = card.macro.length > 2 || (multi && card.macro.some((f) => f.value.length > 7));
  const valueSize = rows ? (compact ? 22 : 26) : multi ? (compact ? 26 : dense ? 30 : 34) : compact ? 44 : 64;
  const cites = card.macro.map((f) => `${factWhen(f)} · ${f.source_short}`);
  const sharedCite = multi && cites.every((c) => c === cites[0]) ? cites[0] : null;
  const valueStyle = [styles.value, { color: p.ink, fontSize: valueSize, lineHeight: Math.round(valueSize * 1.05), letterSpacing: -valueSize * 0.02 }];
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={[styles.panel, multi && styles.panelCol, dense && styles.panelDense, compact && styles.panelCompact, rows && styles.panelRows, { backgroundColor: p.dataPanel }]}>
        {rows ? (
          card.macro.map((f, i) => (
            <View
              key={f.series_id}
              style={[styles.factLine, i > 0 && { borderTopWidth: 1, borderTopColor: p.border }]}
              accessible
              accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
            >
              <View style={styles.factLeft}>
                <Text numberOfLines={2} style={[styles.label, styles.labelRow, { color: p.dataInk }]}>{f.label}</Text>
                {sharedCite ? null : <Text numberOfLines={2} style={[styles.cite, styles.citeMulti, { color: p.inkSoft }]}>{cites[i]}</Text>}
              </View>
              <View style={styles.factRight}>
                <Text numberOfLines={1} style={valueStyle}>{f.value}</Text>
                {changeText(f) ? <Text numberOfLines={1} style={[styles.change, styles.changeCompact, { color: changeColor(p, f) }]}>{changeText(f)}</Text> : null}
              </View>
            </View>
          ))
        ) : (
        <View style={multi ? styles.factsRow : styles.factsSingle}>
        {card.macro.map((f, i) => (
          <View
            key={f.series_id}
            style={[styles.fact, multi && styles.factMulti, multi && i > 0 && { borderLeftWidth: 1, borderLeftColor: p.border, paddingLeft: 14 }]}
            accessible
            accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
          >
            <Text numberOfLines={2} style={[styles.label, { color: p.dataInk }]}>{f.label}</Text>
            <View style={[styles.valueRow, multi && styles.valueCol]}>
              <Text numberOfLines={1} style={valueStyle}>{f.value}</Text>
              {changeText(f) ? <Text style={[styles.change, compact && styles.changeCompact, { color: changeColor(p, f) }]}>{changeText(f)}</Text> : null}
            </View>
            {sharedCite ? null : (
              <Text style={[styles.cite, multi && styles.citeMulti, { color: p.inkSoft }]}>
                {cites[i]}
              </Text>
            )}
          </View>
        ))}
        </View>
        )}
        {sharedCite ? (
          <Text numberOfLines={2} style={[styles.cite, styles.citeMulti, styles.citeShared, { color: p.inkSoft, borderTopColor: p.border }]}>
            {sharedCite}
          </Text>
        ) : null}
      </View>
      {notices.map((n) => (
        <Text
          key={n.key}
          style={[styles.notice, (compact || dense) && styles.noticeSmall, { color: p.muted }]}
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
  wrapCompact: { gap: 6 },
  // Feed-Data draft: cream panel, 18/20 padding, uppercase label, 64 px serif number.
  panel: { borderRadius: 18, paddingVertical: 18, paddingHorizontal: 20, gap: 10 },
  panelCol: { gap: 10, paddingHorizontal: 16, paddingVertical: 16 },
  panelDense: { paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  panelCompact: { paddingVertical: 8, paddingHorizontal: 12, gap: 6, borderRadius: 14 },
  factsRow: { flexDirection: 'row', gap: 14 },
  factsSingle: { gap: 10 },
  panelRows: { gap: 0, paddingVertical: 4 },
  factLine: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  factLeft: { flex: 1, minWidth: 0, gap: 2 },
  factRight: { flexShrink: 0, alignItems: 'flex-end', gap: 1 },
  labelRow: { fontSize: 12, letterSpacing: 0.2 },
  fact: { gap: 4 },
  factMulti: { flex: 1, minWidth: 0 },
  valueCol: { flexDirection: 'column', alignItems: 'flex-start' },
  citeMulti: { fontSize: 13 },
  citeShared: { borderTopWidth: 1, paddingTop: 6 },
  label: { fontFamily: fonts.sansSemi, fontSize: 13, letterSpacing: 0.26, textTransform: 'uppercase' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12 },
  value: { fontFamily: fonts.serif },
  change: { fontFamily: fonts.sansSemi, fontSize: 15 },
  changeCompact: { fontSize: 13 },
  cite: { fontFamily: fonts.sans, fontSize: 15 },
  notice: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, fontStyle: 'italic' },
  noticeSmall: { fontSize: 11, lineHeight: 14 },
});
