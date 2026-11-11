// One feed card. Top: badge and topic (and the "⋯" options). Middle: the serif
// headline, the numbers panel on data cards, then the key takeaways (2-4 bullets from
// the card's own key points, else its 2-3 sentence summary) and a quiet "More detail"
// link, vertically balanced in the free space. Bottom: one bar on a single line: source
// and time (opens the sources sheet with links to the originals), then like, dislike,
// follow and share. The AI notice and the disclaimer are not on the card: the feed shows
// them once in a persistent strip under the card area (D-80). No images, no prices. Link-out cards (reserved, the
// parser skips them in v1) keep their own body from the Feed-LinkOut draft. Swiping
// to react lives in FeedPager.

import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type AccessibilityActionEvent } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { categoryName, clampHeadline, eventLabel } from '../../lib/shared/format';
import { primarySource, shareAlikeCredit } from '../../lib/shared/labels';
import { cardTakeaways } from '../../lib/shared/cardBody';
import { OPEN_DETAIL_HINT, cardDetail } from '../../lib/shared/detail';
import { linkProps } from '../../lib/shared/openUrl';
import { usePalette } from '../../lib/theme/useTheme';
import type { Palette } from '../../lib/theme/theme';
import { fonts, radius } from '../../lib/theme/theme';
import { DataFacts, DataNotices } from './DataCard';
import { ExternalIcon, NumbersIcon, PulseIcon, ShareIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';
import type { Feedback } from '../../lib/account/accountLogic';
import { ShareAlikeLine } from './Labels';
import { CardBar, type BarSize } from './CardBar';
import { Takeaways } from './Takeaways';
import { useShortDepth } from '../../lib/signals/useShortDepth';
import { AboutChips } from '../companies/AboutChips';
import { useFollowedStories } from '../../lib/following/useFollowedStories';
import { linkOutCredit, linkOutDelay, shareUrl } from './cardFooter';
import { followStoryLabel, showFollowLabel } from '../../lib/feed/cardFooterLabels';
import { shareStory } from '../../lib/shared/useCardActions';
import { tip } from '../../lib/theme/tooltip';
import { msSinceSwipeEnd, shouldOpenDetail, wasCardSwiped, type PointerPoint } from '../../lib/feed/swipeLogic';

interface Props {
  card: BlurbCard;
  timeLabel?: 'added'; // Latest tab: show "Added X ago" (published_at) instead of the event time
  config: AppConfig | null;
  categories: Category[];
  onShowSources: (card: BlurbCard) => void;
  onOpenDetail?: (card: BlurbCard) => void; // tap on the card body
  onMore?: (card: BlurbCard) => void; // "⋯" options (signed in only)
  onNext?: () => void;
  wide?: boolean;
  compact?: boolean; // short screens: smaller type so the card fits
  peek?: boolean; // phones: show the edge of the next card under this one
  reaction?: Feedback; // signed in: this user's like/dislike
  onReact?: (card: BlurbCard, pressed: Feedback) => void; // signed in only
  followedTopic?: boolean;
  dimmed?: boolean; // Latest: a card the reader disliked stays in time order but is shown faded (client only)
  onToggleTopicFollow?: (card: BlurbCard) => void;
}

type BadgeIcon = typeof SparkleIcon;

// Feed-LinkOut badge colours. Not in the palette; fine while DARK_MODE_ENABLED is false.
const LINK_OUT_BADGE = { bg: '#E9ECF3', fg: '#2D3A5C' };

// Share the card's /b/<id> page: the Web Share sheet where the browser has one, else
// copy the link. Returns the toast text, or null when the system sheet handled it.
const shareCard = shareStory;

function badgeFor(card: BlurbCard, p: Palette): { text: string; bg: string; fg: string; Icon: BadgeIcon | null } {
  if (card.kind === 'data') return { text: 'New data', bg: p.dataSoft, fg: p.dataInk, Icon: NumbersIcon };
  if (card.kind === 'link_out') return { text: 'From the publisher', bg: LINK_OUT_BADGE.bg, fg: LINK_OUT_BADGE.fg, Icon: ExternalIcon };
  // Drew: no "Summary" tag on AI-written cards (the AI label in the small print already says so).
  if (card.ai.generated) return { text: '', bg: p.accentSoft, fg: p.accentInk, Icon: null };
  return { text: 'From the source', bg: p.surfaceMuted, fg: p.inkSoft, Icon: null };
}

// The badge wording, shared with the top-stories list.
export function badgeLabel(card: BlurbCard): string {
  if (card.kind === 'data') return 'New data';
  return card.ai.generated ? '' : 'From the source';
}

// "World", or "Recalls & Safety · Recall" when the event adds something. The time and
// the source sit in the bottom bar (one place for all of a card's metadata).
function metaLine(card: BlurbCard, categories: Category[]): string {
  const category = categoryName(card.category, categories);
  if (card.kind === 'link_out') return [category, linkOutDelay(card.freshness?.delayed_hours)].filter(Boolean).join(' · ');
  const event = eventLabel(card.event_type);
  const parts = [category];
  // Data cards already carry the "New data" badge, so "Data release" would only repeat it.
  if (event && card.kind !== 'data' && !category.toLowerCase().includes(event.toLowerCase())) parts.push(event);
  return parts.join(' · ');
}

// Type sizes for the takeaways: larger on tall cards so a short body does not leave
// a gap, smaller on short phones so it still fits. Measured card height in px.
function bodyType(wide: boolean, compact: boolean, h: number, roomyTall: boolean): { size: number; lead: number } {
  if (roomyTall) return { size: 23, lead: 35 };
  if (wide) return h > 0 && h < 660 ? { size: 18, lead: 27 } : { size: 21, lead: 32 };
  if (compact) return { size: 16, lead: 23 };
  return h > 620 ? { size: 18, lead: 28 } : { size: 17, lead: 25 };
}

export function Card(props: Props) {
  const { card, timeLabel, config, categories, onShowSources, onOpenDetail, onNext, wide, compact, peek, reaction, onReact, onMore } = props;
  const p = usePalette();
  const pressStart = useRef<{ point: PointerPoint | null; at: number } | null>(null);
  const recordPressStart = (x?: number, y?: number) => {
    pressStart.current = { point: Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null, at: Date.now() };
  };
  const detailPressIn = (event: { nativeEvent: { pageX?: number; pageY?: number } }) =>
    recordPressStart(event.nativeEvent.pageX, event.nativeEvent.pageY);
  const detailMouseDown = (event: { pageX: number; pageY: number }) => recordPressStart(event.pageX, event.pageY);
  const openDetailFromPress = (event: { nativeEvent: { pageX?: number; pageY?: number } }) => {
    const start = pressStart.current;
    pressStart.current = null;
    const up = Number.isFinite(event.nativeEvent.pageX) && Number.isFinite(event.nativeEvent.pageY)
      ? { x: event.nativeEvent.pageX!, y: event.nativeEvent.pageY! }
      : null;
    const duration = start ? Date.now() - start.at : 0;
    if (wasCardSwiped(card.id)) return;
    if (shouldOpenDetail(start?.point ?? null, up, duration, msSinceSwipeEnd())) onOpenDetail?.(card);
  };
  const credit = shareAlikeCredit(card, config);
  const badge = badgeFor(card, p);
  const reactFn = typeof onReact === 'function' ? onReact : undefined;
  const linkOut = card.kind === 'link_out';

  const hasDetail = !linkOut && cardDetail(card) !== null;
  const opensDetail = !!onOpenDetail && hasDetail;
  // Design size is 28 on phones (48 on wide); long headlines and short screens step down.
  // A narrow wide column (small desktop window) steps the wide headline down too.
  // A short desktop window (card under 660 px tall) tightens padding, gaps and type so
  // the labels and the bottom bar still fit without scrolling.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const tight = !!wide && box.h > 0 && box.h < 660;
  // Tablets in the phone layout (a card over 600 px wide and 900 px tall): newspaper-size
  // type and roomier gaps, so the centred content fills the card instead of floating in it.
  // Decided from the window (not the card's own size), because on tablets the card hugs its
  // content and its measured height changes with it.
  const win = useWindowDimensions();
  const tablet = !wide && !compact && win.width >= 640 && win.height >= 900;
  const wideSize = tight ? 40 : box.w > 0 && box.w < 600 ? 38 : card.headline.length > 80 ? 42 : 48;
  // Feed-Data / Feed-LinkOut drafts: data and link-out cards get 24 px padding and a
  // 32 px headline on phones. Two-number data cards have a tall panel and the FRED
  // notice to show, so on phones they use the summary-card sizes and the panel tightens.
  const denseData = !wide && card.kind === 'data' && card.macro.length > 1;
  const roomy = !wide && !compact && card.kind !== 'summary' && !denseData;
  const phoneSize = tablet ? (card.headline.length > 80 ? 44 : 50) : compact ? 22 : denseData ? 24 : card.headline.length > 80 ? (roomy ? 28 : 26) : roomy ? 32 : 28;
  const headlineSize = wide ? wideSize : phoneSize;
  const headlineTrack = wide ? 0.025 : roomy ? 0.015 : 0.02;
  const headlineLead = wide ? 1.07 : linkOut ? 1.12 : 1.1;
  // Bar and type sizes. Narrow phones (under 360 px of card) get the small bar.
  const barSize: BarSize = wide ? 'wide' : compact || (box.w > 0 && box.w < 350) ? 'small' : 'phone';
  // History chart under the numbers: a thin line on compact (short) phones, small on dense two- and three-number cards.
  const chartH = card.kind !== 'data' ? 0 : compact ? 30 : wide ? (tight ? 56 : 84) : denseData ? 40 : box.h > 0 && box.h < 560 ? 36 : 52;
  const type = bodyType(!!wide, !!compact, box.h, tablet);
  // How many bullets fit: data cards share the space with the numbers panel.
  // A-22 depth preference (flag `signals`): "Short" keeps one bullet per card.
  const shortDepth = useShortDepth();
  const maxPoints = shortDepth ? 1 : wide ? (card.kind === 'data' ? (tight ? 2 : 3) : 4) : compact ? (card.kind === 'data' ? 1 : 2) : denseData ? 2 : card.kind === 'data' ? 3 : 4;
  // Bullets are whole or not shown: when the middle overflows (short screens, long
  // headlines), drop the last bullet until it fits instead of cutting one mid-line.
  const [fit, setFit] = useState({ key: '', points: maxPoints });
  const fitKey = `${card.id}:${box.w}x${box.h}:${maxPoints}`;
  const points = fit.key === fitKey ? fit.points : maxPoints;
  const view = useRef({ h: 0, content: 0 });
  const checkFit = () => {
    const { h, content } = view.current;
    // 8 = middleContent paddingBottom
    if (h > 0 && content + 8 > h + 1 && points > 1) setFit({ key: fitKey, points: points - 1 });
    // Still too tall with the fewest bullets (short phones, long headlines, many numbers):
    // the middle scrolls and a soft fade at its foot says there is more below.
    const over = h > 0 && content + 8 > h + 1 && points <= 1;
    setOverflow((o) => (o === over ? o : over));
    // A card that has to scroll must not hide "More detail" below its bottom edge (I-06): the button moves out of
    // the scrolling part into its own row above the bar. Latched per card and size, so it cannot flip back and forth.
    if (over) setPinned((k) => (k === fitKey ? k : fitKey));
  };
  const [overflow, setOverflow] = useState(false);
  const [pinned, setPinned] = useState('');
  const pinMore = pinned === fitKey;
  // The measures above only run when a layout changes. When dropping a bullet changes nothing that is measured (a card
  // without bullets, e.g. a dense data card on a short phone) no new layout arrives, so look again after each step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { checkFit(); }, [points, fitKey, pinMore]);
  const [atEnd, setAtEnd] = useState(false);
  const takeaways = cardTakeaways(card, points);
  const showTakeaways = takeaways.kind !== 'none' && !(denseData && compact);

  // Share: system sheet or copy-link, with a short toast.
  const shareable = shareUrl(card.share_path, null) !== null;
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  const storyFollows = useFollowedStories();
  const storyFollowed = storyFollows.isFollowed(card.id);
  const onToggleStory = () => setToast(storyFollows.toggle(card.id, card) ? 'Following this story' : 'Stopped following this story');
  const onShare = () => {
    shareCard(card)
      .then(setToast)
      .catch(() => setToast('Could not share.'));
  };

  // Screen readers get the swipe reactions (and paging) as actions on the card body.
  const a11yActions = [
    ...(reactFn ? [{ name: 'like', label: 'Like' }, { name: 'dislike', label: 'Dislike' }] : []),
    ...(onNext ? [{ name: 'next', label: 'Next card' }] : []),
  ];
  const onA11yAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if ((name === 'like' || name === 'dislike') && reactFn) reactFn(card, name);
    else if (name === 'next') onNext?.();
  };

  const moreDetail = (
    <Pressable
      onPress={openDetailFromPress}
      onPressIn={detailPressIn}
      onTouchStart={detailPressIn}
      {...(Platform.OS === 'web' ? { onMouseDown: detailMouseDown } as any : {})}
      accessibilityRole="button"
      accessibilityLabel={`More detail. ${OPEN_DETAIL_HINT}`}
      style={pinMore ? styles.morePinnedBtn : styles.more}
    >
      <Text style={[styles.moreText, wide && { fontSize: 15 }, { color: p.accentInk }]}>More detail ›</Text>
    </Pressable>
  );

  const headline = (
    <Text
      numberOfLines={linkOut ? 6 : compact || denseData ? 3 : 4}
      style={[
        styles.headline,
        { color: p.ink, fontSize: headlineSize, lineHeight: headlineSize * headlineLead, letterSpacing: -headlineSize * headlineTrack, maxWidth: wide || tablet ? 820 : undefined },
      ]}
      accessibilityRole="header"
      aria-level={2}
      testID="card-headline"
    >
      {/* link-out headlines are shown word for word (200-character cap, rule 7) */}
      {linkOut ? card.headline.slice(0, 200) : clampHeadline(card.headline)}
    </Text>
  );

  // The bottom bar's buttons: 44 px icon buttons, like / dislike / follow / share
  // (D-63: like and dislike on every card). Wide web adds the keyboard hint after them.
  const iconSize = barSize === 'small' ? 20 : 22;
  // G-04: wide cards say what the pulse follows ("Follow story"); phones keep the icon (no room, see lib/feed/cardFooterLabels.ts).
  const followLabel = showFollowLabel(box.w) ? followStoryLabel(storyFollowed) : null;
  const actions = (
    <>
      {reactFn ? (
        <>
          <ReactButton kind="like" on={reaction === 'like'} size={iconSize} onPress={() => reactFn(card, 'like')} />
          <ReactButton kind="dislike" on={reaction === 'dislike'} size={iconSize} onPress={() => reactFn(card, 'dislike')} />
        </>
      ) : null}
      <Pressable
        onPress={onToggleStory}
        accessibilityRole="button"
        accessibilityLabel={storyFollowed ? 'Following this story, double tap to stop' : 'Follow this story'}
        {...tip(storyFollowed ? 'Following this story (click to stop)' : 'Follow this story')}
        accessibilityState={{ selected: storyFollowed }}
        aria-pressed={storyFollowed}
        style={({ pressed }) => [styles.iconBtn, followLabel && styles.followBtn, storyFollowed && { backgroundColor: p.accentSoft }, pressed && styles.pressed]}
      >
        <PulseIcon color={storyFollowed ? p.accentInk : p.ink} size={iconSize} />
        {followLabel ? <Text style={[styles.followText, { color: storyFollowed ? p.accentInk : p.ink }]}>{followLabel}</Text> : null}
      </Pressable>
      {shareable ? (
        <Pressable
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Share"
          {...tip('Share this story')}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <ShareIcon color={p.ink} size={iconSize} />
        </Pressable>
      ) : null}
    </>
  );
  const nextHint =
    wide && onNext ? (
      <Pressable onPress={onNext} accessibilityRole="button" accessibilityLabel="Next card" style={[styles.next, { borderLeftColor: p.divider }]}>
        <Text style={[styles.nextText, { color: p.muted }]}>Next: press ↓ or scroll</Text>
      </Pressable>
    ) : null;

  const src = primarySource(card);
  return (
    <View style={[styles.wrap, tablet && styles.wrapTablet, props.dimmed && styles.dimmed]} testID={props.dimmed ? 'card-dimmed' : undefined}>
      <View
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          const h = Math.round(e.nativeEvent.layout.height);
          setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
        }}
        style={[styles.card, wide && styles.cardWide, tight && styles.cardTight, (compact || denseData) && styles.cardCompact, roomy && styles.cardRoomy, tablet && styles.cardHug, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <View style={styles.meta}>
          {badge.text ? (
            <View style={[styles.badge, { backgroundColor: badge.bg }]}>
              {badge.Icon ? <badge.Icon color={badge.fg} size={14} /> : null}
              <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.text}</Text>
            </View>
          ) : null}
          {/* No "Updated" badge: every rewrite pass sets updated_at, so it said nothing (audit C1). */}
          <Text testID="card-meta" numberOfLines={1} style={[styles.metaText, wide && { fontSize: 14 }, { color: p.accentInk }]}>
            {metaLine(card, categories)}
          </Text>
          {onMore ? (
            <Pressable onPress={() => onMore(card)} accessibilityRole="button" accessibilityLabel="More options for this card" style={styles.moreBtn}>
              <Text style={[styles.moreDots, { color: p.muted }]}>⋯</Text>
            </Pressable>
          ) : null}
        </View>

        {linkOut ? (
          <>
            {src ? <Text style={[styles.publisher, { color: p.inkSoft }]}>{src.name}</Text> : null}
            {headline}
            <View style={styles.spacer} />
            {src ? (
              <Pressable
                {...linkProps(src.url, card.id)}
                accessibilityRole="link"
                accessibilityLabel={`Read on the publisher's site, ${src.name}. Opens the original.`}
                style={({ pressed }) => [styles.readBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
              >
                <Text style={[styles.readText, { color: p.onAccent }]}>Read on the publisher&apos;s site</Text>
                <ExternalIcon color={p.onAccent} />
              </Pressable>
            ) : null}
            <Text style={[styles.linkOutCredit, { color: p.muted }]}>
              {linkOutCredit(card.attribution)} · Headline and link only; Element adds no summary here.
            </Text>
          </>
        ) : (
          <>
            {/* Only this middle part may shrink (and clip); the small print and the bar below
                never do, so they are always visible. The content sits vertically balanced in
                the free space, so tall phones and desktop windows show no empty gap. Tapping
                it opens the detail sheet, but only when the card has detail. The hint is part
                of the label because react-native-web drops accessibilityHint. */}
            <View style={[styles.middleScroll, tablet && styles.middleHug]}>
            <ScrollView
              style={tablet ? styles.hugScroll : styles.fill}
              contentContainerStyle={styles.middleContent}
              scrollEnabled={!!compact || overflow}
              onLayout={(e) => { view.current.h = e.nativeEvent.layout.height; checkFit(); }}
              onScroll={overflow ? (e) => {
                const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
                const end = contentOffset.y + layoutMeasurement.height >= contentSize.height - 4;
                setAtEnd((a) => (a === end ? a : end));
              } : undefined}
              scrollEventThrottle={64}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {/* the group's own height is the content's natural height (the container centres it) */}
              <View
                onLayout={(e) => { view.current.content = e.nativeEvent.layout.height; checkFit(); }}
                style={[styles.group, wide && { gap: tight ? 14 : 22 }, compact && { gap: 8 }]}
              >
                <Pressable
                  onPress={opensDetail ? openDetailFromPress : undefined}
                  onPressIn={opensDetail ? detailPressIn : undefined}
                  onTouchStart={opensDetail ? detailPressIn : undefined}
                  {...(Platform.OS === 'web' ? { onMouseDown: detailMouseDown } as any : {})}
                  disabled={!opensDetail && a11yActions.length === 0}
                  accessible={opensDetail || a11yActions.length > 0}
                  accessibilityRole={opensDetail ? 'button' : undefined}
                  accessibilityLabel={opensDetail ? `${card.headline}. ${OPEN_DETAIL_HINT}` : a11yActions.length > 0 ? card.headline : undefined}
                  accessibilityActions={a11yActions.length > 0 ? a11yActions : undefined}
                  onAccessibilityAction={a11yActions.length > 0 ? onA11yAction : undefined}
                  style={[styles.middlePressable, wide && { gap: tight ? 14 : 22 }, compact && { gap: 8 }, roomy && { gap: 18 }, tablet && { gap: 30 }]}
                >
                  {headline}

                  {card.kind === 'data' ? <DataFacts card={card} config={config} compact={compact} dense={denseData} hideNotices chartH={chartH} /> : null}

                  {showTakeaways ? (
                    <Takeaways card={card} fontSize={type.size} lineHeight={type.lead} max={points} bulletLines={compact ? 3 : 5} maxWidth={wide || tablet ? 720 : undefined} />
                  ) : null}

                  {/* Which companies the card is about; a chip opens the company page (components/companies/AboutChips). */}
                  <AboutChips card={card} wide={wide} />
                </Pressable>

                {opensDetail && !pinMore ? moreDetail : null}
              </View>
            </ScrollView>
            {overflow && !atEnd ? (
              <View pointerEvents="none" style={styles.fade}>
                {FADE_STEPS.map((o) => (
                  <View key={o} style={{ flex: 1, backgroundColor: p.surface, opacity: o }} />
                ))}
              </View>
            ) : null}
            </View>
            {card.kind === 'data' ? <DataNotices card={card} config={config} small /> : null}
            {opensDetail && pinMore ? <View style={styles.morePinned}>{moreDetail}</View> : null}
            {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
          </>
        )}

        <CardBar card={card} onPress={() => onShowSources(card)} timeLabel={timeLabel} size={barSize} trailing={nextHint}>
          {actions}
        </CardBar>
      </View>
      {toast ? (
        <View style={styles.toastDock} pointerEvents="none">
          <Text style={[styles.toast, { backgroundColor: p.ink, color: p.bg }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
            {toast}
          </Text>
        </View>
      ) : null}
      {/* the edge of the next card peeking out below, as in the design (phone layout only) */}
      {wide || compact ? null : <View style={[styles.stack, { backgroundColor: p.surface, borderColor: p.border, opacity: peek ? 1 : 0 }]} />}
    </View>
  );
}

// "More like this" / "Less like this" as 44 px icon buttons. Pressed state = tinted
// circle + outline + check mark + aria-pressed, never colour alone. Pressing again undoes it.
function ReactButton({ kind, on, size = 22, onPress }: { kind: Feedback; on: boolean; size?: number; onPress: () => void }) {
  const p = usePalette();
  const like = kind === 'like';
  const Icon = like ? ThumbUpIcon : ThumbDownIcon;
  const color = on ? p.accentInk : p.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={like ? 'More like this' : 'Less like this'}
      {...tip(like ? 'Like this story' : 'Dislike this story')}
      aria-pressed={on}
      style={({ pressed }) => [
        styles.react,
        { borderColor: on ? p.accent : 'transparent', backgroundColor: on ? p.accentSoft : 'transparent' },
        pressed && styles.pressed,
      ]}
    >
      <Icon color={color} size={on ? size - 4 : size} />
      {on ? <Text style={[styles.reactCheck, { color }]}>✓</Text> : null}
    </Pressable>
  );
}

// A soft fade at the foot of an overflowing middle: bands of the card colour, each more
// opaque (no gradient library needed, same on web and native).
const FADE_STEPS = [0.15, 0.35, 0.55, 0.75, 0.92];

// Tap targets are real 44 px boxes: react-native-web's Pressable ignores hitSlop.
const styles = StyleSheet.create({
  wrap: { flex: 1 },
  card: { flex: 1, borderWidth: 1, borderRadius: radius.card, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 14, gap: 14, overflow: 'hidden' },
  cardCompact: { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 8, gap: 8 }, // short screens: less air so the body still fits
  cardRoomy: { paddingTop: 24, paddingHorizontal: 24, paddingBottom: 14, gap: 16 }, // phone data and link-out cards (Feed-Data / Feed-LinkOut)
  cardTight: { paddingTop: 26, paddingHorizontal: 36, paddingBottom: 16, gap: 12 },
  cardWide: { paddingTop: 40, paddingHorizontal: 44, paddingBottom: 22, gap: 20 },
  stack: { height: 10, marginHorizontal: 28, borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  meta: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
  moreBtn: { minWidth: 44, minHeight: 44, marginVertical: -8, marginRight: -10, marginLeft: 'auto', alignItems: 'center', justifyContent: 'center' },
  moreDots: { fontSize: 20, lineHeight: 22 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  metaText: { fontFamily: fonts.sansSemi, fontSize: 13, letterSpacing: 0.2, flexShrink: 1 },
  headline: { fontFamily: fonts.serif },
  tickers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ticker: { fontFamily: fonts.sansMedium, fontSize: 13, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 3 },
  // Takes the free space and centres the content in it, so no empty gap is left.
  middleScroll: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 },
  middleContent: { flexGrow: 1, justifyContent: 'center', paddingBottom: 8 },
  // Tablets in the phone layout (ui-polish-m8): the card is as tall as its content (up to the
  // page) and sits centred on the page, instead of a full-height card with large empty gaps.
  wrapTablet: { justifyContent: 'center' },
  cardHug: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto', maxHeight: '100%', paddingTop: 32, paddingHorizontal: 36, paddingBottom: 18, gap: 24 },
  middleHug: { flexGrow: 0, flexBasis: 'auto' },
  hugScroll: { flexGrow: 0, flexShrink: 1 },
  fill: { flex: 1 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 28 },
  group: { gap: 16 },
  middlePressable: { gap: 16 },
  spacer: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 },
  more: { alignSelf: 'flex-start', minHeight: 44, marginVertical: -10, justifyContent: 'center' },
  morePinned: { flexShrink: 0, height: 44, marginVertical: -10 }, // a full 44 px target that takes the same 24 px as the in-scroll button
  morePinnedBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  dimmed: { opacity: 0.55 },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  // Press feedback: a small scale-down on press-in (web: eased by the global CSS transition).
  pressed: { opacity: 0.8, transform: [{ scale: 0.94 }] },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  followBtn: { width: 'auto', flexDirection: 'row', gap: 6, paddingHorizontal: 12 },
  followText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  react: { flexDirection: 'row', width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 1 },
  reactCheck: { fontFamily: fonts.sansSemi, fontSize: 12 },
  next: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, marginLeft: 4, borderLeftWidth: 1 },
  nextText: { fontFamily: fonts.sansMedium, fontSize: 14 },
  toastDock: { position: 'absolute', left: 0, right: 0, bottom: 72, alignItems: 'center', paddingHorizontal: 24 },
  toast: { fontFamily: fonts.sansMedium, fontSize: 14, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, overflow: 'hidden' },
  publisher: { fontFamily: fonts.sansSemi, fontSize: 15 },
  readBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 52, borderRadius: radius.md },
  readText: { fontFamily: fonts.sansSemi, fontSize: 16 },
  linkOutCredit: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
});
