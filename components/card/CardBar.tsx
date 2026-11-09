// The one-line bottom bar every card kind shares: the source block on the left
// (link glyph, agency or outlet, when it was published; opens the sources sheet with
// links to every original) and the card's action buttons on the right (like,
// dislike, follow, share: passed in as children, so each screen keeps its own
// reaction logic). The bar never wraps: the agency name truncates first, the
// time and the 44 px buttons never shrink. Labels: lib/shared/cardBody.ts.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard } from '../../contract/types.ts';
import { WIDE_DOC_LABEL_MAX_NAME, cardBarMeta } from '../../lib/shared/cardBody';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { tip } from '../../lib/theme/tooltip';
import { LinkIcon } from '../shell/Icons';

export type BarSize = 'phone' | 'small' | 'wide';

interface SourceProps {
  card: BlurbCard;
  onPress: () => void;
  timeLabel?: 'added';
  size?: BarSize;
  link?: boolean; // onPress opens the original page (no sources sheet on that screen)
}

// "🔗 Fed · 1 d" on phones (usual short agency names), "🔗 Fed · H.15 release · 1 d ago" on wide web.
export function BarSource({ card, onPress, timeLabel, size = 'phone', link }: SourceProps) {
  const p = usePalette();
  const m = cardBarMeta(card, { timeLabel });
  if (!m) return null;
  const wide = size === 'wide';
  const name = wide && m.docLabel && m.shortName.length <= WIDE_DOC_LABEL_MAX_NAME ? `${m.shortName} · ${m.docLabel}` : m.shortName;
  const time = wide ? m.time : m.timeShort;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={link ? 'link' : 'button'}
      accessibilityLabel={link ? m.a11yLink : m.a11y}
      {...tip(link ? 'Open the original' : m.count > 1 ? `${m.count} sources: open the list` : 'Open the source')}
      style={({ pressed }) => [styles.source, { opacity: pressed ? 0.7 : 1 }]}
    >
      <LinkIcon color={p.accentInk} size={wide ? 18 : 16} />
      <Text numberOfLines={1} style={[styles.name, wide && styles.nameWide, size === 'small' && styles.nameSmall, { color: p.ink }]}>
        {name}
      </Text>
      {time ? (
        <Text numberOfLines={1} style={[styles.time, wide && styles.timeWide, size === 'small' && styles.nameSmall, { color: p.muted }]}>
          {`· ${time}`}
        </Text>
      ) : null}
      {m.count > 1 ? (
        <Text numberOfLines={1} style={[styles.count, { color: p.accentInk, backgroundColor: p.accentSoft }]}>
          {`+${m.count - 1}`}
        </Text>
      ) : null}
    </Pressable>
  );
}

interface BarProps extends SourceProps {
  children?: ReactNode; // the action buttons
  trailing?: ReactNode; // wide feed only: the "Next" keyboard hint
  divider?: boolean; // a hairline above the bar (feed cards)
}

export function CardBar({ card, onPress, timeLabel, size = 'phone', link, children, trailing, divider = true }: BarProps) {
  const p = usePalette();
  return (
    <View style={[styles.bar, divider && { borderTopWidth: 1, borderTopColor: p.divider }, size === 'wide' && styles.barWide]}>
      <View style={styles.sourceSlot}>
        <BarSource card={card} onPress={onPress} timeLabel={timeLabel} size={size} link={link} />
      </View>
      {children ? <View style={styles.actions}>{children}</View> : null}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  // Negative margins hand the 44 px boxes' extra height back, so the bar looks slim.
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 4, marginBottom: -6, minHeight: 48, flexShrink: 0 },
  barWide: { gap: 12, paddingTop: 8, marginBottom: -4 },
  sourceSlot: { flex: 1, minWidth: 0, flexDirection: 'row' },
  source: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, maxWidth: '100%', paddingRight: 6, flexShrink: 1 },
  name: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 14 },
  nameWide: { fontSize: 15 },
  nameSmall: { fontSize: 13 },
  time: { flexShrink: 0, fontFamily: fonts.sans, fontSize: 14 },
  timeWide: { fontSize: 15 },
  count: { flexShrink: 0, fontFamily: fonts.sansSemi, fontSize: 12, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, overflow: 'hidden' },
  actions: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
});
