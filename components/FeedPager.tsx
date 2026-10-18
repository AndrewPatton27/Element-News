// Vertical one-card-per-screen pager. FlatList with paging and snap. On web the
// the arrow keys (and only those): up and down move between cards, right likes and left dislikes like a swipe; wide web also shows a
// "Next: press ↓ or scroll" button in the card footer.
//
// Swipe to react (touch, phone layouts, signed in): drag right = like, left =
// dislike, the same onReact signal as the thumb buttons. The gesture locks to an
// axis after a few px, so vertical paging and horizontal reacting never fight
// (web: touch-action pan-y leaves vertical pans to the browser). Past 35% of the
// width or a fast fling the card flies off, the reaction is saved, an Undo toast
// shows and the feed moves on; otherwise it springs back. Reduced motion: no tilt
// or fly-off, just the reaction. Pure rules: lib/swipeLogic.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  Text,
  StyleSheet,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../contract/types.ts';
import { usePalette } from '../lib/useTheme';
import { fonts, radius } from '../lib/theme';
import { nextRevealCount, scrollToIndexFallbackOffset, shouldHandleFeedKey } from '../lib/pagerLogic';
import {
  MAX_TILT_DEG,
  SWIPE_COACH_KEY,
  SWIPE_THRESHOLD,
  hasTouch,
  lockAxis,
  reactionToSend,
  showCoach,
  swipeDecision,
  swipeEnabled,
  undoPress,
  type Axis,
  markCardSwiped,
} from '../lib/swipeLogic';
import { defaultStore } from '../lib/storage';
import { Card } from './Card';
import { CardErrorBoundary } from './ErrorBoundary';
import type { Feedback } from '../lib/accountLogic';
import { ThumbDownIcon, ThumbUpIcon } from './Icons';
import { UndoToast } from './UndoToast';
import { shouldUseCompactCard } from '../lib/cardFit';

interface Props {
  items: BlurbCard[];
  timeLabel?: 'added';
  config: AppConfig | null;
  categories: Category[];
  loadingMore: boolean;
  done: boolean;
  onEndReached: () => void;
  onShowSources: (card: BlurbCard) => void;
  onOpenDetail?: (card: BlurbCard) => void;
  onMore?: (card: BlurbCard) => void;
  wide?: boolean;
  reactions?: Record<string, Feedback>;
  onReact?: (card: BlurbCard, pressed: Feedback) => void;
  followedTopics?: string[];
  onToggleTopicFollow?: (card: BlurbCard) => void;
  onActiveCard?: (card: BlurbCard) => void; // the card now on screen (for view tracking)
  onQueuePosition?: (index: number) => void;
  active?: boolean; // false when another screen or a sheet is on top: keys are left alone
}

// Below this page height the card switches to smaller type so it fits.
const MOUSE_SWIPE = false; // desktop mouse drag-to-react: off by default
const coachStore = defaultStore();

function detectTouch(): boolean {
  if (Platform.OS !== 'web') return true;
  const w = typeof window !== 'undefined' ? window : null;
  return hasTouch({
    native: false,
    matchMedia: w && typeof w.matchMedia === 'function' ? (q) => w.matchMedia(q) : null,
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  });
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => live && setReduced(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

// "#0B6B5D" -> "#0B6B5D26" (15% tint); other colour formats are used as they are.
function tint(hex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}26` : hex;
}

// Wraps one card: follows the finger horizontally, tilts, shows the like / dislike
// overlay, and on release either completes (onSwipe) or springs back.
function SwipeCard({
  enabled,
  reduced,
  width,
  onSwipe,
  children,
}: {
  enabled: boolean;
  reduced: boolean;
  width: number;
  onSwipe: (r: Feedback) => boolean; // true when the feed moved on to the next card
  children: ReactNode;
}) {
  const p = usePalette();
  const drag = useRef(new Animated.Value(0)).current;
  const axis = useRef<Axis | null>(null);
  const live = useRef({ enabled, reduced, width, onSwipe });
  live.current = { enabled, reduced, width, onSwipe };
  const nativeDriver = Platform.OS !== 'web';

  const responder = useMemo(() => {
    const springBack = () => Animated.spring(drag, { toValue: 0, useNativeDriver: nativeDriver, friction: 7 }).start();
    return PanResponder.create({
      // Every touch starts undecided; the axis is picked once, after a few px.
      onStartShouldSetPanResponderCapture: () => {
        axis.current = null;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, g) => {
        if (!live.current.enabled) return false;
        if (axis.current === null) axis.current = lockAxis(g.dx, g.dy);
        return axis.current === 'x';
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => drag.stopAnimation(),
      onPanResponderMove: (_, g) => drag.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        axis.current = null;
        const { width: w, reduced: still, onSwipe: done } = live.current;
        const decision = swipeDecision(g.dx, g.vx, w);
        if (!decision) return springBack();
        if (still) {
          drag.setValue(0);
          done(decision);
          return;
        }
        Animated.timing(drag, { toValue: (decision === 'like' ? 1 : -1) * w * 1.3, duration: 200, useNativeDriver: nativeDriver }).start(() => {
          // Moved on: put the card back while it is off screen. Last card: spring back.
          if (done(decision)) setTimeout(() => drag.setValue(0), 450);
          else springBack();
        });
      },
      onPanResponderTerminate: () => {
        axis.current = null;
        springBack();
      },
    });
  }, [drag, nativeDriver]);

  if (!enabled) return <>{children}</>;
  const reach = Math.max(1, width * SWIPE_THRESHOLD);
  const span = Math.max(1, width);
  const likeOpacity = drag.interpolate({ inputRange: [0, reach], outputRange: [0, 1], extrapolate: 'clamp' });
  const dislikeOpacity = drag.interpolate({ inputRange: [-reach, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const rotate = drag.interpolate({ inputRange: [-span, 0, span], outputRange: [`-${MAX_TILT_DEG}deg`, '0deg', `${MAX_TILT_DEG}deg`] });
  const motion = reduced ? null : { transform: [{ translateX: drag }, { rotate }] };
  // Web: the browser keeps vertical pans (scrolling the feed); horizontal ones come to us.
  const webTouch = Platform.OS === 'web' ? ({ touchAction: 'pan-y' } as unknown as ViewStyle) : null;
  return (
    <Animated.View style={[styles.fill, webTouch, motion]} {...responder.panHandlers}>
      {children}
      <Animated.View pointerEvents="none" style={[styles.overlay, { backgroundColor: tint(p.accent), opacity: likeOpacity }]}>
        <View style={[styles.stamp, { backgroundColor: p.accent }]}>
          <ThumbUpIcon color={p.onAccent} size={36} />
        </View>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.overlay, { backgroundColor: tint(p.warn), opacity: dislikeOpacity }]}>
        <View style={[styles.stamp, { backgroundColor: p.warn }]}>
          <ThumbDownIcon color={p.onAccent} size={36} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

export function FeedPager({
  items,
  config,
  categories,
  loadingMore: _loadingMore,
  done,
  onEndReached,
  onShowSources,
  onOpenDetail,
  wide,
  reactions,
  onReact,
  onActiveCard,
  onQueuePosition,
  active,
  onMore,
  followedTopics,
  onToggleTopicFollow,
  timeLabel,
}: Props) {
  const p = usePalette();
  const { height: windowHeight } = useWindowDimensions();
  const list = useRef<FlatList<BlurbCard>>(null);
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(5);
  const totalRef = useRef(items.length);
  totalRef.current = items.length;
  const indexRef = useRef(0);
  indexRef.current = index;

  const onLayout = (e: LayoutChangeEvent) => {
    setHeight(Math.round(e.nativeEvent.layout.height));
    setWidth(Math.round(e.nativeEvent.layout.width));
  };

  const [touch] = useState(detectTouch);
  const reduced = useReducedMotion();
  const canReact = typeof onReact === 'function';
  const swipeOn = swipeEnabled({ wide: !!wide, canReact, touch, mouseSwipe: MOUSE_SWIPE });
  const [coachSeen, setCoachSeen] = useState(() => coachStore.get(SWIPE_COACH_KEY));
  const dismissCoach = useCallback(() => {
    coachStore.set(SWIPE_COACH_KEY, '1');
    setCoachSeen('1');
  }, []);
  const coach = showCoach({ enabled: swipeOn, seen: coachSeen, index });
  useEffect(() => {
    if (!coach) return;
    const timer = setTimeout(dismissCoach, 5000);
    return () => clearTimeout(timer);
  }, [coach, dismissCoach]);
  const [undo, setUndo] = useState<{ card: BlurbCard; previous: Feedback | undefined; sent: Feedback; message: string } | null>(null);
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;
  // Thumb buttons: same signal as before, and using them counts as having seen the hint.
  const react = useMemo(
    () =>
      onReact
        ? (card: BlurbCard, pressed: Feedback) => {
            dismissCoach();
            onReact(card, pressed);
          }
        : undefined,
    [onReact, dismissCoach],
  );

  const onViewable = useRef<NonNullable<FlatListProps<BlurbCard>['onViewableItemsChanged']>>(({ viewableItems }) => {
    const first = viewableItems.find((v) => v.isViewable && typeof v.index === 'number');
    if (first && typeof first.index === 'number') {
      setIndex(first.index);
      onQueuePosition?.(first.index);
      setRevealed((n) => nextRevealCount(first.index!, n, totalRef.current));
    }
  }).current;

  const goTo = useCallback(
    (i: number) => {
      if (items.length === 0) return;
      const target = Math.max(0, Math.min(items.length - 1, i));
      list.current?.scrollToIndex({ index: target, animated: true });
      setIndex(target);
      if (target >= items.length - 2) onEndReached();
    },
    [items.length, onEndReached],
  );
  const next = useCallback(() => goTo(indexRef.current + 1), [goTo]);

  // A completed swipe: set the reaction (never toggle it off), offer Undo, move on.
  const swiped = useCallback(
    (card: BlurbCard, r: Feedback): boolean => {
      dismissCoach();
      if (!onReact) return false;
      const previous = reactionsRef.current?.[card.id];
      const sent = reactionToSend(previous, r);
      if (sent) {
        onReact(card, sent);
        markCardSwiped(card.id);
        setUndo({ card, previous, sent, message: sent === 'like' ? 'Liked. More like this.' : 'Disliked. Less like this.' });
      }
      const i = items.findIndex((c) => c.id === card.id);
      if (i < 0 || i >= items.length - 1) return false;
      goTo(i + 1);
      return true;
    },
    [onReact, items, goTo, dismissCoach],
  );
  const undoSwipe = useCallback(() => {
    if (!undo || !onReact) return setUndo(null);
    const press = undoPress(undo.previous, undo.sent);
    if (press) onReact(undo.card, press);
    setUndo(null);
  }, [undo, onReact]);
  const clearUndo = useCallback(() => setUndo(null), []);

  // Fast key-nav can target a row that isn't laid out yet, which makes scrollToIndex
  // throw "out of range". Wait one frame and retry; if it still can't, scroll to the
  // computed offset (index * itemHeight) so navigation never throws or no-ops.
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      const offset = scrollToIndexFallbackOffset(info, height);
      requestAnimationFrame(() => {
        try {
          list.current?.scrollToIndex({ index: info.index, animated: true });
        } catch {
          list.current?.scrollToOffset({ offset, animated: true });
        }
      });
    },
    [height],
  );

  // Page height changed (window resized, phone rotated): the old scroll offset no
  // longer lines up with a card, so jump straight back to the current one.
  useEffect(() => {
    if (height > 0 && indexRef.current > 0) list.current?.scrollToOffset({ offset: height * indexRef.current, animated: false });
  }, [height]);

  const current = items[index];
  useEffect(() => {
    if (current && onActiveCard) onActiveCard(current);
  }, [current, onActiveCard]);

  // New filter -> new list: jump back to the first card.
  const firstId = items[0]?.id;
  useEffect(() => {
    setIndex(0);
    setRevealed(Math.min(5, items.length));
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [firstId]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || active === false) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || target?.closest?.('[contenteditable], [role="dialog"], [aria-modal="true"]') || !shouldHandleFeedKey({ active: true, key: e.key, tagName: target?.tagName, contentEditable: target?.isContentEditable })) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
        e.preventDefault();
        goTo(indexRef.current + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') {
        e.preventDefault();
        goTo(indexRef.current - 1);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && canReact) {
        // Drew: the right arrow is a right swipe (like) and the left arrow a left swipe (dislike).
        const card = items[indexRef.current];
        if (card) {
          e.preventDefault();
          swiped(card, e.key === 'ArrowRight' ? 'like' : 'dislike');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, active, canReact, items, swiped]);

  const compact = !wide && shouldUseCompactCard(windowHeight, height);
  const renderItem = useCallback(
    ({ item, index: i }: { item: BlurbCard; index: number }) => {
      const last = i === items.length - 1 && done;
      return (
        <View style={[styles.page, wide && styles.pageWide, { height }]}>
          <View style={compact && coach ? { height: Math.max(0, height - 52) } : styles.cardArea}>
            <CardErrorBoundary resetKey={item.id}>
              <SwipeCard enabled={swipeOn} reduced={reduced} width={width} onSwipe={(r) => swiped(item, r)}>
                <Card
                  card={item}
                  timeLabel={timeLabel}
                  config={config}
                  categories={categories}
                  onShowSources={onShowSources}
                  onOpenDetail={onOpenDetail}
                  onMore={onMore}
                  followedTopic={followedTopics?.includes(item.category)}
                  onToggleTopicFollow={onToggleTopicFollow}
                  onNext={last ? undefined : next}
                  wide={wide}
                  compact={compact}
                  peek={!last}
                  reaction={reactions?.[item.id]}
                  onReact={react}
                />
              </SwipeCard>
            </CardErrorBoundary>
          </View>
        </View>
      );
    },
    [height, width, config, categories, onShowSources, onOpenDetail, onMore, followedTopics, onToggleTopicFollow, next, wide, compact, items.length, done, reactions, react, swipeOn, reduced, swiped, timeLabel],
  );

  return (
    <View style={styles.fill} onLayout={onLayout}>
      {height > 0 ? (
        <FlatList
          ref={list}
          data={items.slice(0, revealed)}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          pagingEnabled
          snapToInterval={height}
          snapToAlignment="start"
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
          onEndReached={onEndReached}
          onEndReachedThreshold={2}
          onScrollToIndexFailed={onScrollToIndexFailed}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          windowSize={5}
          initialNumToRender={5}
          maxToRenderPerBatch={5}
          removeClippedSubviews={Platform.OS !== 'web'}
          ListFooterComponent={
            done && items.length > 0 ? (
              <View style={styles.end}>
                <Text style={[styles.endText, { color: p.muted }]}>You’re all caught up. Switch to Latest or another topic.</Text>
              </View>
            ) : undefined
          }
        />
      ) : null}
      {coach ? (
        <View style={styles.coachDock} pointerEvents="box-none">
          <Pressable
            onPress={dismissCoach}
            accessibilityRole="button"
            accessibilityLabel="Swipe right to like, left to dislike. Tap to hide this tip."
            style={[styles.coach, { backgroundColor: p.ink }]}
          >
            <ThumbDownIcon color={p.bg} size={18} />
            <Text style={[styles.coachText, { color: p.bg }]}>Swipe right to like, left to dislike</Text>
            <ThumbUpIcon color={p.bg} size={18} />
          </Pressable>
        </View>
      ) : null}
      <UndoToast message={undo?.message ?? null} onUndo={undoSwipe} onDone={clearUndo} />
    </View>
  );
}

const styles = StyleSheet.create({
  end: { height: 120, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  endText: { fontFamily: fonts.sansMedium, fontSize: 14, textAlign: 'center' },
  fill: { flex: 1 },
  cardArea: { flex: 1 },
  // Phones: the card, the next card's edge and the disclaimer line all sit inside the page.
  page: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 4 },
  pageWide: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 12 },
  overlay: { ...StyleSheet.absoluteFill, borderRadius: radius.card, alignItems: 'center', justifyContent: 'center' },
  stamp: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  // Keep the transient hint at the bottom edge and dismiss it quickly on phones.
  coachDock: { position: 'absolute', left: 0, right: 0, bottom: 4, alignItems: 'center', paddingHorizontal: 32 },
  coach: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 16, borderRadius: 22 },
  coachText: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
