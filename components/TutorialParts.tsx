// The four example panels of the tour (designs Mobile-Tutorial*.dc.html and
// Web-Tutorial*.dc.html). Everything here is a practice illustration. Only the
// practice card's buttons (source, like, dislike, share) are tappable, and they
// only reach the practice handlers, which save nothing. Other decorative pieces
// are hidden from screen readers (the legend under each panel says it).

import { useState, type ReactNode } from 'react';
import { tip } from '../lib/tooltip';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Palette } from '../lib/theme';
import { fonts } from '../lib/theme';
import type { PracticeReaction } from '../lib/tutorialLogic';
import {
  PRACTICE_SAMPLE,
  SAMPLE_CATEGORIES,
  SAMPLE_TICKER,
  TUTORIAL_AI_LABEL,
  TUTORIAL_MOTION,
  type KeyTile,
  type LegendItem,
  type RecapRow,
} from '../lib/tutorialSteps';
import {
  BriefIcon,
  ChevronUpIcon,
  LinkIcon,
  PulseIcon,
  SearchIcon,
  ShareIcon,
  SparkleIcon,
  ThumbDownIcon,
  ThumbUpIcon,
} from './Icons';

const WARN_SOFT = '#F8EDE6';

export function Badge({ n, p, style }: { n: number; p: Palette; style?: object }) {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" style={[styles.badge, { backgroundColor: p.accent }, style]}>
      <Text style={[styles.badgeText, { color: p.onAccent }]}>{n}</Text>
    </View>
  );
}

function ExampleHead({ p, caption, sparkle }: { p: Palette; caption?: string; sparkle?: boolean }) {
  return (
    <View style={styles.rowBetween}>
      <View style={[styles.example, { backgroundColor: p.accentSoft }]}>
        {sparkle ? <SparkleIcon color={p.accentInk} size={14} /> : null}
        <Text style={[styles.exampleText, { color: p.accentInk }]}>Example</Text>
      </View>
      {caption ? <Text style={[styles.small, { color: p.muted }]}>{caption}</Text> : null}
    </View>
  );
}

// Step 1: the practice card. `swayX` / `swayRotate` drive the design's elsway loop
// (0 with reduced motion). The buttons are real Pressables, but they only call the
// practice handlers (components/TutorialPractice.tsx), which save nothing.
type AnimNum = Animated.AnimatedInterpolation<number> | Animated.Value | number;
type AnimStr = Animated.AnimatedInterpolation<string> | string;

export function PracticeCard(props: {
  p: Palette;
  web: boolean;
  title: string;
  lead?: string;
  caption?: string;
  swayX: AnimNum;
  swayRotate: AnimStr;
  likeOpacity: AnimNum;
  dislikeOpacity: AnimNum;
  reaction: PracticeReaction | null;
  onLike: () => void;
  onDislike: () => void;
  onShare: () => void;
  onSource: () => void;
}) {
  const { p, web, reaction } = props;
  const liked = reaction === 'like';
  const disliked = reaction === 'dislike';
  // Practice only: the Follow button toggles its look and saves nothing.
  const [followed, setFollowed] = useState(false);
  return (
    <Animated.View
      style={[
        styles.card,
        web && styles.cardWeb,
        {
          backgroundColor: p.surface,
          borderColor: p.border,
          transform: [{ translateX: props.swayX as number }, { rotate: props.swayRotate as string }],
        },
      ]}
    >
      <ExampleHead p={p} caption={props.caption} sparkle />
      <View>
        <Badge n={1} p={p} style={styles.badgeTopRight} />
        <Text role="heading" aria-level={1} style={[web ? styles.h1Web : styles.h1, { color: p.ink }]}>
          {props.title}
        </Text>
        {props.lead ? <Text style={[web ? styles.leadWeb : styles.lead, { color: p.inkSoft }]}>{props.lead}</Text> : null}
      </View>
      <View>
        <Badge n={2} p={p} style={[styles.badgeTopRight, { zIndex: 1 }]} />
        <Pressable
          onPress={props.onSource}
          accessibilityRole="button"
          accessibilityLabel="Practice source. On real cards this opens where the story came from."
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.sourceRow,
            { backgroundColor: pressed ? p.accentSoft : p.surfaceMuted, borderColor: pressed || hovered ? p.accent : p.borderStrong },
          ]}
        >
          <LinkIcon color={p.ink} size={18} />
          <Text style={[styles.sourceName, { color: p.ink }]}>{PRACTICE_SAMPLE.source}</Text>
          <Text style={[styles.small, { color: p.muted }]}>{PRACTICE_SAMPLE.sourceCount}</Text>
        </Pressable>
      </View>
      <View style={styles.rowBetween}>
        <Pressable
          onPress={props.onDislike}
          accessibilityRole="button"
          accessibilityLabel="Practice dislike"
          accessibilityState={{ selected: disliked }}
          hitSlop={6}
          style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.94 : 1 }] })}
        >
          <Animated.View
            style={[
              styles.pill,
              { borderColor: p.warn, backgroundColor: disliked ? p.warn : WARN_SOFT, opacity: disliked ? 1 : props.dislikeOpacity, transform: [{ rotate: '-4deg' }] },
            ]}
          >
            <ThumbDownIcon color={disliked ? p.onAccent : p.warn} size={18} />
            <Text style={[styles.pillText, { color: disliked ? p.onAccent : p.warn }]}>DISLIKE</Text>
          </Animated.View>
        </Pressable>
        <Pressable
          onPress={props.onLike}
          accessibilityRole="button"
          accessibilityLabel="Practice like"
          accessibilityState={{ selected: liked }}
          hitSlop={6}
          style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.94 : 1 }] })}
        >
          <Animated.View
            style={[
              styles.pill,
              { borderColor: p.accent, backgroundColor: liked ? p.accent : p.accentSoft, opacity: liked ? 1 : props.likeOpacity, transform: [{ rotate: '4deg' }] },
            ]}
          >
            <Text style={[styles.pillText, { color: liked ? p.onAccent : p.accentInk }]}>LIKE</Text>
            <ThumbUpIcon color={liked ? p.onAccent : p.accentInk} size={18} />
          </Animated.View>
        </Pressable>
      </View>
      <View style={[styles.cardFoot, { borderTopColor: p.divider }]}>
        <View style={styles.aiWrap}>
          <Text style={[styles.ai, { color: p.muted }]}>{TUTORIAL_AI_LABEL}</Text>
          <Badge n={3} p={p} style={styles.badgeAi} />
        </View>
        <View style={styles.footIcons}>
          {web ? (
            <>
              <IconButton p={p} label="Practice dislike" active={disliked} activeBg={WARN_SOFT} onPress={props.onDislike}>
                <ThumbDownIcon color={p.warn} size={22} />
              </IconButton>
              <IconButton p={p} label="Practice like" active={liked} activeBg={p.accentSoft} onPress={props.onLike}>
                <ThumbUpIcon color={p.accent} size={22} />
              </IconButton>
            </>
          ) : null}
          <IconButton p={p} label="Practice follow. On real cards this follows the story." active={followed} activeBg={p.accentSoft} onPress={() => setFollowed((v) => !v)}>
            <PulseIcon color={followed ? p.accent : p.ink} size={22} />
          </IconButton>
          <IconButton p={p} label="Practice share. On real cards this opens Share." onPress={props.onShare}>
            <ShareIcon color={p.ink} size={22} />
          </IconButton>
        </View>
      </View>
    </Animated.View>
  );
}

function IconButton(props: { p: Palette; label: string; active?: boolean; activeBg?: string; onPress: () => void; children: ReactNode }) {
  const { p, active } = props;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      {...tip(props.label.split('.')[0])}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.iconBox,
        { backgroundColor: active ? (props.activeBg ?? p.accentSoft) : pressed || hovered ? p.surfaceMuted : 'transparent', transform: [{ scale: pressed ? 0.9 : 1 }] },
      ]}
    >
      {props.children}
    </Pressable>
  );
}

export function Legend({ p, items, web }: { p: Palette; items: LegendItem[]; web: boolean }) {
  if (items.length === 0) return null;
  return (
    <View role="list" style={styles.legend}>
      {items.map((it, i) => (
        <View role="listitem" key={it.label} style={styles.legendRow}>
          <Badge n={i + 1} p={p} style={styles.legendBadge} />
          <Text style={[web ? styles.legendTextWeb : styles.legendText, { color: p.ink }]}>
            <Text style={{ fontFamily: fonts.sansSemi }}>{it.label}</Text> {it.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function Tiles({ p, tiles, web, nudge }: { p: Palette; tiles: KeyTile[]; web: boolean; nudge?: AnimNum }) {
  return (
    <View style={styles.tiles} aria-label={web ? 'How to react and move' : 'Swipe gestures'}>
      {tiles.map((t) => {
        const next = t.tone === 'next';
        const color = t.tone === 'warn' ? p.warn : next ? p.accentInk : p.accent;
        // Phones: the ← / → arrows nudge outwards (design .elnl / .elnr).
        const dir = t.key === '←' ? -1 : t.key === '→' ? 1 : 0;
        const nudgeX = dir !== 0 && nudge !== undefined && typeof nudge !== 'number' ? Animated.multiply(nudge, dir) : 0;
        return (
          <View
            key={t.title}
            style={[
              styles.tile,
              { backgroundColor: next ? p.accentSoft : p.surface, borderColor: next ? p.accent : p.border },
            ]}
          >
            <View aria-hidden importantForAccessibility="no-hide-descendants" style={web ? [styles.kbd, { borderColor: next ? p.accent : p.borderStrong, backgroundColor: next ? p.surface : p.surfaceMuted }] : undefined}>
              {t.key === 'thumbs-up' ? (
                <ThumbUpIcon color={color} size={20} />
              ) : t.key === 'thumbs-down' ? (
                <ThumbDownIcon color={color} size={20} />
              ) : (
                <Animated.Text style={[styles.kbdText, { color, transform: [{ translateX: nudgeX as number }] }]}>{t.key}</Animated.Text>
              )}
            </View>
            <Text style={[styles.tileTitle, { color: next ? p.accentInk : p.ink }]}>{t.title}</Text>
            <Text style={[styles.tileHint, { color: next ? p.accentInk : p.muted }]}>{t.hint}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Step 2: the top of the feed (numbers strip + categories). `marquee` is a linear
// 0→1 loop (design elscroll); the track moves by half its measured width, so the
// doubled list wraps seamlessly. 0 = still (reduced motion).
export function FeedTopPanel({ p, web, caption, note, marquee }: { p: Palette; web: boolean; caption?: string; note?: string; marquee: Animated.Value | number }) {
  const tone = (t: 'up' | 'down' | 'flat') => (t === 'up' ? p.up : t === 'down' ? p.down : p.flat);
  const items = SAMPLE_TICKER.concat(SAMPLE_TICKER);
  const gap = web ? TUTORIAL_MOTION.marquee.gapWeb : TUTORIAL_MOTION.marquee.gapMobile;
  const [trackW, setTrackW] = useState(0);
  const shift =
    typeof marquee === 'number' || trackW <= 0 ? 0 : marquee.interpolate({ inputRange: [0, 1], outputRange: [0, -trackW / 2] });
  return (
    <View style={[styles.section, styles.sectionFlush, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.padX}>
        <ExampleHead p={p} caption={caption} />
      </View>
      <View>
        <Badge n={1} p={p} style={[styles.badgeStrip, { zIndex: 2 }]} />
        <View
          aria-label="Numbers to know, sample values"
          style={[styles.strip, { borderColor: p.border, backgroundColor: p.surfaceMuted }]}
        >
          <Animated.View
            onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
            style={[styles.stripTrack, { gap, transform: [{ translateX: shift as number }] }]}
          >
            {items.map((t, i) => (
              <Text key={i} numberOfLines={1} style={[styles.stripLabel, { color: p.inkSoft, marginRight: i === items.length - 1 ? gap : 0 }]}>
                {t.label}{' '}
                <Text style={[styles.stripValue, { color: p.ink }]}>{t.value}</Text>{' '}
                <Text style={{ fontFamily: fonts.sansSemi, color: tone(t.tone) }}>{t.change}</Text>
              </Text>
            ))}
          </Animated.View>
        </View>
      </View>
      {web ? (
        <View style={[styles.padX, styles.webCats]}>
          <Badge n={2} p={p} style={styles.badgeCats} />
          <View style={styles.catCol}>
            <Text style={[styles.catHead, { color: p.muted }]}>CATEGORIES</Text>
            {SAMPLE_CATEGORIES.map((c) => {
              const on = c === 'Economy';
              return (
                <Text key={c} style={[styles.catItem, on && { backgroundColor: p.accentSoft, color: p.accentInk, fontFamily: fonts.sansSemi }, !on && { color: p.inkSoft }]}>
                  {c}
                </Text>
              );
            })}
          </View>
          <View style={styles.catStories}>
            <Text style={[styles.small, { color: p.muted }]}>
              Example: you picked <Text style={{ color: p.accentInk, fontFamily: fonts.sansSemi }}>Economy</Text>, so you only see economy stories.
            </Text>
            <MiniStory p={p} meta="New data · Economy · Today" title="Consumer prices cooled a little last month" />
            <MiniStory p={p} meta="Summary · Economy · Yesterday" title="Fed holds rates and signals slower cuts" />
          </View>
        </View>
      ) : (
        <View>
          <Badge n={2} p={p} style={[styles.badgeStrip, { zIndex: 2, top: -12 }]} />
          <View style={[styles.padX, styles.chips]}>
            {SAMPLE_CATEGORIES.map((c) => {
              const on = c === 'All';
              return (
                <Text
                  key={c}
                  style={[
                    styles.chip,
                    { borderColor: on ? p.accent : p.borderStrong, backgroundColor: on ? p.accentSoft : p.surface, color: on ? p.accentInk : p.inkSoft },
                    on && { fontFamily: fonts.sansSemi },
                  ]}
                >
                  {c}
                </Text>
              );
            })}
          </View>
        </View>
      )}
      {note ? <Text style={[styles.note, styles.padX, { color: p.muted }]}>{note}</Text> : null}
    </View>
  );
}

function MiniStory({ p, meta, title }: { p: Palette; meta: string; title: string }) {
  return (
    <View style={[styles.mini, { borderColor: p.border }]}>
      <Text style={[styles.note, { color: p.muted }]}>{meta}</Text>
      <Text style={[styles.miniTitle, { color: p.ink }]}>{title}</Text>
    </View>
  );
}

// Step 3: Brief and Following.
export function BriefFollowingPanel({ p, web, caption, note }: { p: Palette; web: boolean; caption?: string; note?: string }) {
  return (
    <View style={[styles.section, { backgroundColor: p.surface, borderColor: p.border }]}>
      <ExampleHead p={p} caption={caption} />
      <View style={[styles.twoUp, web && styles.twoUpWeb]}>
        <View style={[styles.panel, web && styles.panelWeb, { borderColor: p.border, backgroundColor: p.surfaceMuted }]}>
          <Badge n={1} p={p} style={[styles.badgeTopRight, { zIndex: 1 }]} />
          <View style={styles.panelHead}>
            <BriefIcon color={p.accentInk} size={18} />
            <Text style={[styles.panelHeadText, { color: p.accentInk }]}>Brief · today in a minute</Text>
          </View>
          {['Story headline one', 'Story headline two', 'Story headline three'].map((h, i) => (
            <View key={h} style={styles.briefRow}>
              <Text style={[styles.briefNum, { color: p.accent }]}>{i + 1}</Text>
              <Text style={[styles.briefText, { color: p.ink }]}>{h}</Text>
            </View>
          ))}
          <Text style={[styles.note, styles.panelFoot, { color: p.muted, borderTopColor: p.divider }]}>{TUTORIAL_AI_LABEL}</Text>
        </View>
        <View style={[styles.panel, web && styles.panelWeb, { borderColor: p.border }]}>
          <Badge n={2} p={p} style={[styles.badgeTopRight, { zIndex: 1 }]} />
          <View style={styles.rowBetween}>
            <View style={styles.newUpdate}>
              <View style={[styles.dot, { backgroundColor: p.accent }]} />
              <Text style={[styles.newUpdateText, { color: p.accent }]}>New story</Text>
            </View>
            <View style={styles.panelHead}>
              <PulseIcon color={p.accent} size={18} strokeWidth={2} />
              <Text style={[styles.panelHeadText, { color: p.accent }]}>Following</Text>
            </View>
          </View>
          <Text style={[styles.miniTitle, { color: p.ink }]}>A story on a topic you follow</Text>
          <View style={styles.briefRow}>
            <View style={[styles.timelineDot, { backgroundColor: p.accent }]} />
            <Text style={[styles.briefText, { color: p.ink, fontSize: 14 }]}>
              <Text style={{ fontFamily: fonts.sansSemi }}>Because you follow Economy</Text> · 2 h ago
            </Text>
          </View>
          <View style={styles.briefRow}>
            <View style={[styles.timelineDot, styles.timelineDotOpen, { borderColor: p.borderStrong }]} />
            <Text style={[styles.briefText, { color: p.muted, fontSize: 14 }]}>Earlier story · yesterday</Text>
          </View>
        </View>
      </View>
      {note ? <Text style={[styles.note, { color: p.muted }]}>{note}</Text> : null}
    </View>
  );
}

const RECAP_ICONS: Record<RecapRow['icon'], (c: string) => ReactNode> = {
  next: (c) => <ChevronUpIcon color={c} size={20} />,
  swipe: (c) => <ThumbUpIcon color={c} size={20} />,
  source: (c) => <LinkIcon color={c} size={20} />,
  follow: (c) => <PulseIcon color={c} size={20} />,
  search: (c) => <SearchIcon color={c} size={20} />,
};

export function Recap({ p, rows, web }: { p: Palette; rows: RecapRow[]; web: boolean }) {
  return (
    <View role="list" aria-label="Recap" style={[styles.recap, { backgroundColor: p.surface, borderColor: p.border }]}>
      {rows.map((r, i) => (
        <View role="listitem" key={r.icon} style={[styles.recapRow, web && { minHeight: 64 }, i > 0 && { borderTopWidth: 1, borderTopColor: p.divider }]}>
          <View aria-hidden importantForAccessibility="no-hide-descendants" style={[styles.recapIcon, { backgroundColor: p.accentSoft }]}>
            <View style={r.icon === 'next' && web ? { transform: [{ rotate: '180deg' }] } : undefined}>{RECAP_ICONS[r.icon](p.accentInk)}</View>
          </View>
          <Text style={[web ? styles.recapTextWeb : styles.recapText, { color: p.ink }]}>
            <Text style={{ fontFamily: fonts.sansSemi }}>{r.bold}</Text>
            {r.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  badgeTopRight: { right: -6, top: -10 },
  badgeAi: { right: -4, top: -14 },
  badgeStrip: { right: 12, top: -10 },
  badgeCats: { left: 150, top: -14, zIndex: 2 },
  legendBadge: { position: 'relative', width: 24, height: 24, borderRadius: 12, marginTop: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  example: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  exampleText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  small: { fontFamily: fonts.sans, fontSize: 13 },
  card: { borderRadius: 24, borderWidth: 1, paddingTop: 18, paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
  cardWeb: { paddingTop: 28, paddingHorizontal: 32, paddingBottom: 18, gap: 18 },
  h1: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 27, letterSpacing: -0.4, paddingRight: 20 },
  h1Web: { fontFamily: fonts.serif, fontSize: 38, lineHeight: 41, letterSpacing: -0.7, paddingRight: 24 },
  lead: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, marginTop: 8 },
  leadWeb: { fontFamily: fonts.sans, fontSize: 18, lineHeight: 27, marginTop: 12 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed' },
  sourceName: { flex: 1, fontFamily: fonts.sansSemi, fontSize: 15 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: 2 },
  pillText: { fontFamily: fonts.sansSemi, fontSize: 13, letterSpacing: 0.4 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, paddingTop: 4, gap: 4 },
  aiWrap: { flex: 1, paddingRight: 24 },
  ai: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  footIcons: { flexDirection: 'row' },
  iconBox: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  legend: { gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  legendText: { flex: 1, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  legendTextWeb: { flex: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 23 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 14, borderWidth: 1 },
  kbd: { minWidth: 44, height: 36, borderRadius: 8, borderWidth: 1, borderBottomWidth: 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  kbdText: { fontFamily: fonts.sansSemi, fontSize: 20 },
  tileTitle: { fontFamily: fonts.sansSemi, fontSize: 14 },
  tileHint: { fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' },
  section: { borderRadius: 24, borderWidth: 1, padding: 16, gap: 14, overflow: 'hidden' },
  sectionFlush: { paddingHorizontal: 0, gap: 16 },
  padX: { paddingHorizontal: 18 },
  strip: { height: 44, borderTopWidth: 1, borderBottomWidth: 1, overflow: 'hidden', justifyContent: 'center', paddingLeft: 16 },
  stripTrack: { flexDirection: 'row', flexShrink: 0, alignSelf: 'flex-start', ...(Platform.OS === 'web' ? { width: 'max-content' } : null) } as object,
  stripLabel: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.4, flexShrink: 0, ...(Platform.OS === 'web' ? { whiteSpace: 'nowrap' } : null) } as object,
  stripValue: { fontFamily: fonts.serif, fontSize: 16, letterSpacing: 0 },
  chips: { flexDirection: 'row', gap: 8, overflow: 'hidden' },
  chip: { flexShrink: 0, height: 44, lineHeight: 42, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1, fontFamily: fonts.sansMedium, fontSize: 14, overflow: 'hidden' },
  webCats: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  catCol: { width: 180, gap: 2 },
  catHead: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, paddingHorizontal: 12, paddingBottom: 6 },
  catItem: { minHeight: 44, lineHeight: 44, paddingHorizontal: 12, borderRadius: 12, fontFamily: fonts.sansMedium, fontSize: 16, overflow: 'hidden' },
  catStories: { flex: 1, minWidth: 0, gap: 10 },
  mini: { borderWidth: 1, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 18, gap: 6 },
  miniTitle: { fontFamily: fonts.serif, fontSize: 20, lineHeight: 24 },
  note: { fontFamily: fonts.sans, fontSize: 12 },
  twoUp: { gap: 14 },
  twoUpWeb: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  panel: { borderWidth: 1, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  panelWeb: { flexGrow: 1, flexBasis: 300 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  panelHeadText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  briefRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  briefNum: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 20 },
  briefText: { flex: 1, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  panelFoot: { borderTopWidth: 1, paddingTop: 6 },
  newUpdate: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  newUpdateText: { fontFamily: fonts.sansSemi, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  timelineDotOpen: { backgroundColor: 'transparent', borderWidth: 2 },
  recap: { borderRadius: 24, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 18 },
  recapRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 6 },
  recapIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  recapText: { flex: 1, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  recapTextWeb: { flex: 1, fontFamily: fonts.sans, fontSize: 17, lineHeight: 23 },
});
