// The one place that defines how a news card looks (Drew, 2026-11-11: "one card template,
// all the info is put into the template"). Every screen that shows a story builds it from
// this file, so a change to the headline, meta line, body, small print or tile frame is
// made here once.
//
//   CardTemplate  - the whole card for lists: Search results, the Following feed, followed
//                   stories and the Brief rows. The story is passed in as props (meta,
//                   headline, body, reason, small print, bottom bar); nothing else is drawn.
//   The parts     - CardMeta, CardHeadline, CardBody, CardReason, CardMoreDetail,
//                   CardPublisher, CardReadButton, CardSmallPrint, CardSurface. The swipe-feed
//                   Card keeps its own frame (paging, tight / compact / tablet modes) but is
//                   built from the same parts, so summary prose, summary bullets, data and
//                   link-out cards all use the same headline, meta, body and small print.
//
// Variants: 'tile' (white bordered tile: Search, Following, followed stories), 'row' and
// 'rowRanked' (borderless list row of the Brief; ranked has the big number), 'feed' (the
// swipe card; it passes its own computed type sizes).

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { BlurbCard } from '../../../contract/types.ts';
import { clampHeadline } from '../../../lib/shared/format';
import { usePalette } from '../../../lib/theme/useTheme';
import { fonts, radius } from '../../../lib/theme/theme';
import { linkProps } from '../../../lib/shared/openUrl';
import { ExternalIcon, PulseIcon } from '../../shell/Icons';
import { CardBar, type BarSize } from '../CardBar';
import { Takeaways } from '../Takeaways';

export type CardVariant = 'tile' | 'row' | 'rowRanked' | 'feed';

export interface TypeStep { size: number; line: number; track: number }

// Type scale per variant, phone and wide. Edit sizes here. The 'feed' card computes its
// headline and body sizes from the screen (Card.tsx), so only its meta size lives here.
export const CARD_TYPE = {
  tile: {
    headline: { size: 21, line: 25, track: 0 },
    headlineWide: { size: 26, line: 30, track: -0.26 },
    body: { size: 15, line: 22 },
    bodyWide: { size: 16, line: 24 },
    meta: 12,
    metaWide: 13,
    rank: { size: 24, line: 26, minWidth: 20 },
    rankWide: { size: 34, line: 34, minWidth: 28 },
  },
  row: {
    headline: { size: 18, line: 23, track: 0 },
    headlineWide: { size: 22, line: 27, track: 0 },
    body: { size: 14, line: 20 },
    bodyWide: { size: 17, line: 25 },
    meta: 12,
    metaWide: 13,
    rank: { size: 24, line: 26, minWidth: 20 },
    rankWide: { size: 34, line: 34, minWidth: 28 },
  },
  rowRanked: {
    headline: { size: 19, line: 23, track: 0 },
    headlineWide: { size: 28, line: 32, track: -0.4 },
    body: { size: 14, line: 20 },
    bodyWide: { size: 17, line: 25 },
    meta: 12,
    metaWide: 13,
    rank: { size: 24, line: 26, minWidth: 20 },
    rankWide: { size: 34, line: 34, minWidth: 28 },
  },
  feed: {
    headline: { size: 28, line: 31, track: -0.56 },
    headlineWide: { size: 48, line: 51, track: -1.2 },
    body: { size: 17, line: 25 },
    bodyWide: { size: 21, line: 32 },
    meta: 13,
    metaWide: 14,
    rank: { size: 24, line: 26, minWidth: 20 },
    rankWide: { size: 34, line: 34, minWidth: 28 },
  },
} as const;

// ---- frame -------------------------------------------------------------------------

export function CardSurface({ wide, children, style, ...rest }: {
  wide?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityRole?: 'summary';
}) {
  const p = usePalette();
  return (
    <View {...rest} style={[styles.tile, wide ? styles.tileWide : styles.tileNarrow, { backgroundColor: p.surface, borderColor: p.border }, style]}>
      {children}
    </View>
  );
}

// ---- meta line ---------------------------------------------------------------------
// 'inline'  dot, badge, then the category (Search, Following)
// 'split'   dot and badge on the left, the category on the right (followed stories)
// 'plain'   one muted string, "badge · category" (Brief rows)
// 'feed'    pill badge with an icon, then the category line in the accent colour; `right`
//           holds the "⋯" button (swipe card)

export interface MetaPill { text: string; bg: string; fg: string; Icon: ((props: { color: string; size?: number }) => ReactNode) | null }

export function CardMeta({ layout = 'inline', variant = 'tile', wide, dot, badge, badgeColor, text, pill, right, testID }: {
  layout?: 'inline' | 'split' | 'plain' | 'feed';
  variant?: CardVariant;
  wide?: boolean;
  dot?: string;
  badge?: string;
  badgeColor?: string;
  text?: string;
  pill?: MetaPill;
  right?: ReactNode;
  testID?: string;
}) {
  const p = usePalette();
  const t = CARD_TYPE[layout === 'feed' ? 'feed' : variant];
  const size = wide ? t.metaWide : t.meta;
  if (layout === 'plain') {
    const line = [badge, text].filter(Boolean).join(' · ');
    return line ? <Text testID={testID} style={[styles.metaPlain, { fontSize: size, color: p.muted }]}>{line}</Text> : null;
  }
  if (layout === 'feed') {
    return (
      <View style={styles.metaFeed}>
        {pill && pill.text ? (
          <View style={[styles.pill, { backgroundColor: pill.bg }]}>
            {pill.Icon ? <pill.Icon color={pill.fg} size={14} /> : null}
            <Text style={[styles.pillText, { color: pill.fg }]}>{pill.text}</Text>
          </View>
        ) : null}
        <Text testID={testID} numberOfLines={1} style={[styles.metaFeedText, { fontSize: size, color: p.accentInk }]}>{text}</Text>
        {right}
      </View>
    );
  }
  const badgeEl = (
    <View style={styles.badge}>
      {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
      {badge ? <Text style={[styles.badgeText, { fontSize: size, color: badgeColor ?? p.accentInk }]}>{badge}</Text> : null}
    </View>
  );
  if (layout === 'split') {
    return (
      <View style={styles.metaSplit}>
        {badgeEl}
        <Text numberOfLines={1} style={[styles.metaSplitText, { fontSize: size, color: p.muted }]}>{text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.metaInline}>
      {badgeEl}
      <Text numberOfLines={1} style={[styles.metaInlineText, { fontSize: size, color: p.accentInk }]}>{text}</Text>
    </View>
  );
}

// ---- headline ----------------------------------------------------------------------

export function CardHeadline({ card, wide, variant = 'tile', onPress, label, role, text, size, lines, style, testID, heading }: {
  card: Pick<BlurbCard, 'headline'>;
  wide?: boolean;
  variant?: CardVariant;
  onPress?: () => void; // tiles: the headline opens the detail sheet
  label?: string; // accessibility label when pressable
  role?: 'button' | 'link';
  text?: string; // override (link-out: verbatim headline, 200-char cap)
  size?: TypeStep; // the swipe card computes its own
  lines?: number;
  style?: StyleProp<TextStyle>;
  testID?: string;
  heading?: boolean; // expose as a level-2 heading (the swipe card; list headlines sit inside a button)
}) {
  const p = usePalette();
  const t = CARD_TYPE[variant];
  const s = size ?? (wide ? t.headlineWide : t.headline);
  const node = (
    <Text
      testID={testID}
      numberOfLines={lines}
      {...(heading ? { accessibilityRole: 'header' as const, 'aria-level': 2 } : {})}
      style={[styles.headline, { fontSize: s.size, lineHeight: s.line, letterSpacing: s.track, color: p.ink }, style]}
    >
      {text ?? clampHeadline(card.headline)}
    </Text>
  );
  if (!onPress) return node;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role ?? 'button'}
      accessibilityLabel={label ?? card.headline}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {node}
    </Pressable>
  );
}

// ---- body: key-point bullets, or the 2-3 sentence summary --------------------------

export function CardBody({ card, wide, variant = 'tile', max, lines, size, maxWidth, bulletLines }: {
  card: BlurbCard;
  wide?: boolean;
  variant?: CardVariant;
  max?: number;
  lines?: number;
  size?: { size: number; line: number }; // the swipe card computes its own
  maxWidth?: number;
  bulletLines?: number;
}) {
  const t = CARD_TYPE[variant];
  const s = size ?? (wide ? t.bodyWide : t.body);
  return <Takeaways card={card} fontSize={s.size} lineHeight={s.line} max={max} lines={lines} maxWidth={maxWidth} bulletLines={bulletLines} />;
}

// ---- why this card is here ---------------------------------------------------------
// 'line' a muted one-liner under the meta row (swipe card); 'badge' an accent pulse and
// the text (tiles).

export function CardReason({ text, kind = 'badge', wide, testID }: { text?: string | null; kind?: 'line' | 'badge'; wide?: boolean; testID?: string }) {
  const p = usePalette();
  if (!text) return null;
  if (kind === 'line') {
    return <Text testID={testID} numberOfLines={1} style={[styles.reasonLine, wide && { fontSize: 13 }, { color: p.muted }]}>{text}</Text>;
  }
  return (
    <View style={styles.reasonBadge} accessibilityLabel={text}>
      <PulseIcon color={p.accent} size={16} />
      <Text style={[styles.reasonBadgeText, { color: p.accentInk }]}>{text}</Text>
    </View>
  );
}

// ---- "More detail ›" ---------------------------------------------------------------

export function CardMoreDetail({ onPress, label, wide, style, ...rest }: {
  onPress?: (event: any) => void;
  label: string; // accessibility label
  wide?: boolean;
  style?: StyleProp<ViewStyle>;
  [key: string]: unknown; // pointer handlers the swipe card uses to tell a tap from a swipe
}) {
  const p = usePalette();
  return (
    <Pressable {...rest} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={style ?? styles.more}>
      <Text style={[styles.moreText, wide && { fontSize: 15 }, { color: p.accentInk }]}>More detail ›</Text>
    </Pressable>
  );
}

// ---- link-out parts: publisher line and the "Read on the publisher's site" button ----

export function CardPublisher({ name }: { name?: string | null }) {
  const p = usePalette();
  return name ? <Text style={[styles.publisher, { color: p.inkSoft }]}>{name}</Text> : null;
}

export function CardReadButton({ src, cardId }: { src?: { name: string; url: string } | null; cardId: string }) {
  const p = usePalette();
  if (!src) return null;
  return (
    <Pressable
      {...linkProps(src.url, cardId)}
      accessibilityRole="link"
      accessibilityLabel={`Read on the publisher's site, ${src.name}. Opens the original.`}
      style={({ pressed }) => [styles.readBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
    >
      <Text style={[styles.readText, { color: p.onAccent }]}>Read on the publisher&apos;s site</Text>
      <ExternalIcon color={p.onAccent} />
    </Pressable>
  );
}

// ---- small print: credit and notice lines (AI notice and disclaimer are the screen's strip) ----

export function CardSmallPrint({ text }: { text?: string | null }) {
  const p = usePalette();
  if (!text) return null;
  return <Text style={[styles.small, { color: p.muted }]}>{text}</Text>;
}

// ---- the whole card for lists --------------------------------------------------------

export interface CardTemplateProps {
  card: BlurbCard;
  variant?: 'tile' | 'row' | 'rowRanked';
  wide?: boolean;
  rank?: number; // rowRanked: the big number
  meta: { layout: 'inline' | 'split' | 'plain'; dot?: string; badge?: string; badgeColor?: string; text?: string };
  onOpen?: () => void; // the headline (tile) or the meta + headline + teaser (rows) open the detail sheet
  openLabel?: string;
  headlineText?: string; // override the clamped headline
  headlineRole?: 'button' | 'link';
  related?: string | null; // "Update to: <headline>"
  teaser?: string | null; // rows: one line under the headline
  body?: 'takeaways' | 'none'; // default: takeaways on tiles, none on rows
  content?: ReactNode; // replaces the body (followed stories: the update timeline)
  reason?: string | null;
  moreLabel?: string; // set to show the quiet "More detail ›" link
  onMore?: () => void;
  footer?: ReactNode; // between the body and the small print (followed stories: Open story / Following)
  smallPrint?: ReactNode; // credit lines, the FRED notice (rule 8)
  bar: { onPress: () => void; link?: boolean; linkUrl?: string; divider?: boolean; actions: ReactNode };
}

export function CardTemplate(props: CardTemplateProps) {
  const { card, variant = 'tile', wide = false, rank, meta, onOpen, openLabel, headlineText, headlineRole, related, teaser, reason, moreLabel, onMore, footer, smallPrint, bar } = props;
  const p = usePalette();
  const t = CARD_TYPE[variant];
  const isRow = variant !== 'tile';
  const body = props.body ?? (isRow ? 'none' : 'takeaways');
  const barEl = (
    <CardBar card={card} onPress={bar.onPress} link={bar.link} linkUrl={bar.linkUrl} divider={bar.divider} size={(wide ? 'wide' : 'phone') as BarSize}>
      {bar.actions}
    </CardBar>
  );
  const metaEl = <CardMeta layout={meta.layout} variant={variant} wide={wide} dot={meta.dot} badge={meta.badge} badgeColor={meta.badgeColor} text={meta.text} />;

  if (isRow) {
    const rs = wide ? t.rankWide : t.rank;
    return (
      <View style={[styles.row, wide && styles.rowWide, { borderTopColor: p.border }]}>
        {rank !== undefined ? <Text style={[styles.rank, { fontSize: rs.size, lineHeight: rs.line, minWidth: rs.minWidth, color: p.accent }]}>{rank}</Text> : null}
        <View style={styles.rowText}>
          <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={openLabel} style={({ pressed }) => [styles.rowOpen, { opacity: pressed ? 0.7 : 1 }]}>
            {metaEl}
            <CardHeadline card={card} wide={wide} variant={variant} text={headlineText} />
            {teaser ? <Text style={[styles.teaser, { fontSize: wide ? t.bodyWide.size : t.body.size, lineHeight: wide ? t.bodyWide.line : t.body.line, maxWidth: wide ? 640 : undefined, color: p.inkSoft }]}>{teaser}</Text> : null}
          </Pressable>
          <View style={styles.rowLabels}>
            {smallPrint}
            {barEl}
          </View>
        </View>
      </View>
    );
  }

  return (
    <CardSurface accessibilityRole="summary" wide={wide}>
      {metaEl}
      <CardHeadline card={card} wide={wide} onPress={onOpen} label={openLabel} role={headlineRole} text={headlineText} />
      {related ? <Text style={[styles.related, { color: p.muted }]}>{related}</Text> : null}
      {props.content ?? (body === 'takeaways' ? <CardBody card={card} wide={wide} max={3} lines={4} /> : null)}
      <CardReason text={reason} />
      {footer}
      {moreLabel && onMore ? <CardMoreDetail onPress={onMore} label={moreLabel} wide={wide} /> : null}
      {smallPrint}
      {barEl}
    </CardSurface>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: radius.tile, gap: 10 },
  tileNarrow: { paddingTop: 16, paddingBottom: 8, paddingHorizontal: 18 },
  tileWide: { paddingTop: 22, paddingBottom: 12, paddingHorizontal: 24, gap: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontFamily: fonts.sansSemi },
  metaInline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaInlineText: { flexShrink: 1, fontFamily: fonts.sansSemi, letterSpacing: 0.2 },
  metaSplit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  metaSplitText: { flexShrink: 1, fontFamily: fonts.sans, textAlign: 'right' },
  metaPlain: { fontFamily: fonts.sans },
  metaFeed: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
  metaFeedText: { fontFamily: fonts.sansSemi, letterSpacing: 0.2, flexShrink: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  pillText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  headline: { fontFamily: fonts.serif },
  related: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  reasonLine: { flexShrink: 0, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, marginTop: -4 },
  reasonBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reasonBadgeText: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 13 },
  more: { alignSelf: 'flex-start', minHeight: 44, marginVertical: -8, justifyContent: 'center' },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  publisher: { fontFamily: fonts.sansSemi, fontSize: 15 },
  readBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 52, borderRadius: radius.md },
  readText: { fontFamily: fonts.sansSemi, fontSize: 16 },
  small: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', gap: 14, paddingVertical: 14, borderTopWidth: 1 },
  rowWide: { gap: 20, paddingVertical: 22 },
  rank: { fontFamily: fonts.serif },
  rowText: { flex: 1, gap: 6 },
  rowOpen: { gap: 4, minHeight: 44 },
  rowLabels: { gap: 2, alignSelf: 'stretch' },
  teaser: { fontFamily: fonts.sans },
});
