// Vertical one-card-per-screen pager. FlatList with paging and snap. On web the
// arrow keys (and only those): up and down move between cards, right likes and left dislikes like a swipe; wide web also shows a
// "Next: press ↓ or scroll" button in the card footer.
//
// Navigation is deterministic (lib/feed/feedNav.ts): the card on screen is tracked by id, the
// order of cards already rendered is frozen (refetches, reranks after a like, new pages and the
// tab-head swap can only change cards not rendered yet, and new cards only join after them),
// every user action moves at most one card with a short lock, held-key auto-repeat is ignored,
// and where the list comes to rest only moves the reader when it is not a leftover of our own
// animated scroll.
//
// Swipe to react (touch, phone layouts, signed in): drag right = like, left =
// dislike, the same onReact signal as the thumb buttons. The gesture locks to an
// axis after a few px, so vertical paging and horizontal reacting never fight
// (web: touch-action pan-y leaves vertical pans to the browser). Past 35% of the
// width or a fast fling the card flies off, the reaction is saved, an Undo toast
// shows and the feed moves on; otherwise it springs back. Reduced motion: no tilt
// or fly-off, just the reaction. Pure rules: lib/swipeLogic.ts.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, radius } from '../../lib/theme/theme';
import { shouldHandleFeedKey } from '../../lib/feed/pagerLogic';
import {
  canReactNow,
  currentIndex,
  initNav,
  isKeyRepeat,
  reactNav,
  renderedIds,
  restingIndex,
  settleNav,
  stepNav,
  syncNav,
  undoNav,
  type NavResult,
  type NavState,
} from '../../lib/feed/feedNav';
import {
  MAX_TILT_DEG,
  SWIPE_COACH_KEY,
  SWIPE_THRESHOLD,
  hasTouch,
  lockAxis,
  reactionToSend,
  showCoach,
  coachLane,
  COACH_AUTO_DISMISS_MS,
  swipeDecision,
  swipeEnabled,
  undoPress,
  type Axis,
  markCardSwiped,
} from '../../lib/feed/swipeLogic';
import { defaultStore } from '../../lib/storage/storage';
import { Card } from '../card/Card';
import { CardErrorBoundary } from '../shell/ErrorBoundary';
import type { Feedback } from '../../lib/account/accountLogic';
import { ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';
import { UndoToast } from './UndoToast';
import { cornerToastText } from '../../lib/feed/toastPlacement';
import { shouldUseCompactCard } from '../../lib/feed/cardFit';

interface Props {
  items: BlurbCard[];
  timeLabel?: 'added';
  config: AppConfig | null;
  categories: Category[];
  loadingMore: boolean;
  done: boolean;
  /** Cards shown again because the reader had already seen them (the feed ran out of new ones). */
  reshownIds?: ReadonlySet<string>;
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
const REST_IDLE_MS = 120; // no scroll event for this long = the list came to rest
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
        // Decide (react + move on) at release, so the move is locked in before the fly-off
        // animation; a second swipe during it is dropped by the navigation lock.
        const moved = done(decision);
        if (!moved) return springBack();
        Animated.timing(drag, { toValue: (decision === 'like' ? 1 : -1) * w * 1.3, duration: 200, useNativeDriver: nativeDriver }).start(() => {
          // Moved on: put the card back while it is off screen.
          setTimeout(() => drag.setValue(0), 450);
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

interface UndoInfo {
  card: BlurbCard;
  previous: Feedback | undefined;
  sent: Feedback;
  message: string;
  label: string;
  seq: number;
}

export function FeedPager({
  items,
  config,
  categories,
  loadingMore: _loadingMore,
  done,
  reshownIds,
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
  const heightRef = useRef(0);
  heightRef.current = height;

  const onLayout = (e: LayoutChangeEvent) => {
    setHeight(Math.round(e.nativeEvent.layout.height));
    setWidth(Math.round(e.nativeEvent.layout.width));
  };

  // ---- Navigation state: one source of truth (React state for rendering, mirrored in a ref so
  // key and gesture handlers always act on the latest copy, never a stale closure) ----
  const byId = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);
  const incoming = useMemo(() => items.map((c) => c.id), [items]);
  const [navState, setNavState] = useState<NavState>(() => initNav(incoming));
  // Merge what the feed wants to show now (a pure derivation): cards already rendered keep their
  // place, new ones only join after them.
  const s = useMemo(() => syncNav(navState, incoming).state, [navState, incoming]);
  const nav = useRef<NavState>(s);
  useLayoutEffect(() => {
    nav.current = s;
    if (s !== navState) setNavState(s);
  }, [s, navState]);
  const index = Math.max(0, currentIndex(s));
  const rows = useMemo(() => renderedIds(s).map((id) => byId.get(id)).filter((c): c is BlurbCard => !!c), [s, byId]);
  const rerender = useCallback(() => setNavState(nav.current), []);
  // The row the list is at or heading to. When the current card's index changes without our
  // own animated move (a card behind the reader was hidden), the list jumps there instantly.
  const listAt = useRef(index);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const scrollToRow = useCallback((i: number, animated: boolean) => {
    listAt.current = i;
    list.current?.scrollToOffset({ offset: heightRef.current * i, animated });
  }, []);

  const apply = useCallback(
    (r: NavResult) => {
      if (!r.accepted) return false;
      nav.current = r.state;
      const i = currentIndex(r.state);
      if (r.cause === 'step' || r.cause === 'undo') scrollToRow(i, !reducedRef.current);
      else if (r.cause === 'settle') listAt.current = i;
      rerender();
      return true;
    },
    [scrollToRow, rerender],
  );

  useLayoutEffect(() => {
    if (height > 0 && listAt.current !== index) scrollToRow(index, false);
  });

  // Page height changed (window resized, phone rotated): the old scroll offset no
  // longer lines up with a card, so jump straight back to the current one.
  useEffect(() => {
    if (height > 0) scrollToRow(Math.max(0, currentIndex(nav.current!)), false);
  }, [height, scrollToRow]);

  // Where the list came to rest (user scroll, our own animation landing). A report that is a
  // leftover of our own move is ignored; if our move never lands, the report wins after a grace.
  const lastY = useRef(0);
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRest = useCallback(() => {
    restTimer.current = null;
    const st = nav.current!;
    const r = settleNav(st, restingIndex(lastY.current, heightRef.current), Date.now());
    if (r.accepted) apply(r);
    else if (st.pending && r.state === st) {
      restTimer.current = setTimeout(onRest, Math.max(20, st.pending.until - Date.now() + 20));
    }
  }, [apply]);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastY.current = e.nativeEvent.contentOffset.y;
      if (restTimer.current) clearTimeout(restTimer.current);
      restTimer.current = setTimeout(onRest, REST_IDLE_MS);
    },
    [onRest],
  );
  useEffect(() => () => { if (restTimer.current) clearTimeout(restTimer.current); }, []);

  const step = useCallback((dir: 1 | -1) => apply(stepNav(nav.current!, dir, Date.now())), [apply]);
  const next = useCallback(() => void step(1), [step]);

  const [touch] = useState(detectTouch);
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
    const timer = setTimeout(dismissCoach, COACH_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [coach, dismissCoach]);
  const [undo, setUndo] = useState<UndoInfo | null>(null);
  const undoSeq = useRef(0);
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;
  // Thumb buttons: same signal as before (a toggle, no move), and using them counts as having seen the hint.
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

  // A completed swipe or a like / dislike arrow key: only for the card on screen and outside the
  // navigation lock. Sets the reaction (never toggles it off), offers Undo, moves on exactly one.
  const swiped = useCallback(
    (card: BlurbCard, r: Feedback): boolean => {
      dismissCoach();
      if (!onReact) return false;
      const now = Date.now();
      if (!canReactNow(nav.current!, card.id, now)) return false;
      const previous = reactionsRef.current?.[card.id];
      const sent = reactionToSend(previous, r);
      if (sent) {
        onReact(card, sent);
        markCardSwiped(card.id);
        const t = cornerToastText(sent === 'like' ? 'like' : 'dislike');
        setUndo({ card, previous, sent, message: t.text, label: t.label, seq: ++undoSeq.current });
      }
      const res = reactNav(nav.current!, card.id, now);
      apply(res);
      return res.accepted && res.cause === 'step';
    },
    [onReact, dismissCoach, apply],
  );
  const undoSwipe = useCallback(() => {
    if (!undo || !onReact) return setUndo(null);
    const press = undoPress(undo.previous, undo.sent);
    if (press) onReact(undo.card, press);
    apply(undoNav(nav.current!, undo.card.id, Date.now()));
    setUndo(null);
  }, [undo, onReact, apply]);
  const clearUndo = useCallback(() => setUndo(null), []);

  const current = s.currentId ? byId.get(s.currentId) : undefined;
  useEffect(() => {
    if (current && onActiveCard) onActiveCard(current);
  }, [current, onActiveCard]);
  useEffect(() => {
    onQueuePosition?.(index);
  }, [index, onQueuePosition]);
  // Near the end of what is loaded: ask for more.
  const nearEnd = index >= s.order.length - 3;
  useEffect(() => {
    if (nearEnd) onEndReached();
  }, [nearEnd, s.order.length, onEndReached]);

  // Keys go through refs, so the listener is added once and always sees the current card.
  const keyActions = useRef({ step, swiped, byId });
  keyActions.current = { step, swiped, byId };
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || active === false) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || target?.closest?.('[contenteditable], [role="dialog"], [aria-modal="true"]') || !shouldHandleFeedKey({ active: true, key: e.key, tagName: target?.tagName, contentEditable: target?.isContentEditable })) return;
      const isReact = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
      if (isReact && !canReact) return;
      e.preventDefault();
      // Holding a key fires auto-repeat keydowns: one press, one card.
      if (isKeyRepeat(e)) return;
      const a = keyActions.current;
      if (e.key === 'ArrowDown') a.step(1);
      else if (e.key === 'ArrowUp') a.step(-1);
      else {
        // Drew: the right arrow is a right swipe (like) and the left arrow a left swipe (dislike).
        const id = nav.current?.currentId;
        const card = id ? a.byId.get(id) : undefined;
        if (card) a.swiped(card, e.key === 'ArrowRight' ? 'like' : 'dislike');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, canReact]);

  const compact = !wide && shouldUseCompactCard(windowHeight, height);
  const lastIndex = rows.length - 1;
  const atEnd = done && rows.length === s.order.length;
  const renderItem = useCallback(
    ({ item, index: i }: { item: BlurbCard; index: number }) => {
      const last = i === lastIndex && atEnd;
      return (
        <View style={[styles.page, wide && styles.pageWide, { height }]}>
          <View style={coachLane(coach, height) ? { height: height - coachLane(coach, height) } : styles.cardArea}>
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
    [height, width, config, categories, onShowSources, onOpenDetail, onMore, followedTopics, onToggleTopicFollow, next, wide, compact, lastIndex, atEnd, reactions, react, swipeOn, reduced, swiped, timeLabel, coach],
  );

  return (
    <View style={styles.fill} onLayout={onLayout} onTouchStart={coach ? dismissCoach : undefined}>
      {height > 0 ? (
        <FlatList
          ref={list}
          // Smooth, eased paging between cards on the web (arrow keys, buttons and swipes).
          style={Platform.OS === 'web' ? ({ scrollBehavior: 'smooth' } as object) : undefined}
          data={rows}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          pagingEnabled
          snapToInterval={height}
          snapToAlignment="start"
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
          onScroll={onScroll}
          scrollEventThrottle={16}
          windowSize={5}
          initialNumToRender={5}
          maxToRenderPerBatch={5}
          removeClippedSubviews={Platform.OS !== 'web'}
          ListFooterComponent={
            atEnd && rows.length > 0 ? (
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
      {/* By card id: `index` is the position in the nav order, which can differ from `items`. */}
      {reshownIds && current && reshownIds.has(current.id) ? (
        <View style={styles.caughtUpDock} pointerEvents="none" accessibilityLiveRegion="polite">
          <Text style={[styles.caughtUp, { backgroundColor: p.ink, color: p.bg }]}>You’re all caught up. These are stories you’ve already seen.</Text>
        </View>
      ) : null}
      <UndoToast
        message={undo?.message ?? null}
        label={undo?.label}
        token={undo?.seq}
        placement="corner"
        wide={wide}
        onUndo={undoSwipe}
        onDone={clearUndo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  end: { height: 120, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  endText: { fontFamily: fonts.sansMedium, fontSize: 14, textAlign: 'center' },
  fill: { flex: 1 },
  caughtUpDock: { position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 24 },
  caughtUp: { fontFamily: fonts.sansMedium, fontSize: 13, textAlign: 'center', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, overflow: 'hidden' },
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
