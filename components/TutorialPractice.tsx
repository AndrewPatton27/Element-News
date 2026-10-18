// Step 1's practice card, made interactive (design Mobile-/Web-Tutorial.dc.html).
// - Idle: the design's loops play (card sways left/right with a small tilt, the
//   DISLIKE / LIKE pills light up in turn, the ← / → tiles nudge).
// - Drag it left or right (touch or mouse): it follows, tilts and shows the same
//   like / dislike overlay as the real feed (components/FeedPager.tsx, rules in
//   lib/swipeLogic.ts). Past the threshold it flies off, then comes back so it can
//   be tried again.
// - Tap the source row, LIKE / DISLIKE, the thumbs (web) or Share: pressed state
//   plus a small confirmation ("Liked", "Disliked", ...).
// Nothing is saved: the state is a useReducer over practiceReducer
// (lib/tutorialLogic.ts); no storage, api, prefs, Share, links or analytics.
// Reduced motion: no loops, pills at full opacity, no tilt or fly-off.

import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, PanResponder, Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { Palette } from '../lib/theme';
import { fonts } from '../lib/theme';
import { lockAxis, MAX_TILT_DEG, SWIPE_THRESHOLD, type Axis } from '../lib/swipeLogic';
import {
  PRACTICE_INITIAL,
  PRACTICE_MESSAGE_MS,
  PRACTICE_RESET_MS,
  practiceHandlers,
  practiceReducer,
} from '../lib/tutorialLogic';
import { TUTORIAL_MOTION, type KeyTile } from '../lib/tutorialSteps';
import { ThumbDownIcon, ThumbUpIcon } from './Icons';
import { NATIVE_DRIVER, useKeyframeLoop } from './TutorialMotion';
import { PracticeCard, Tiles } from './TutorialParts';

const M = TUTORIAL_MOTION;

// Same 15% tint as the feed's overlay.
function tint(hex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}26` : hex;
}

export function PracticeArea(props: {
  p: Palette;
  web: boolean;
  reduced: boolean;
  title: string;
  lead?: string;
  caption?: string;
  tiles?: KeyTile[];
  legend: ReactNode;
}) {
  const { p, web, reduced } = props;
  const [state, dispatch] = useReducer(practiceReducer, PRACTICE_INITIAL);
  const h = useMemo(() => practiceHandlers(dispatch), []);
  const [busy, setBusy] = useState(false); // dragging or flying: idle loops pause

  // Idle loops (design elsway / elleft / elright / elnudge).
  const swayT = useKeyframeLoop(M.sway.at, M.sway.ms, reduced, busy);
  const rightT = useKeyframeLoop(M.likePill.at, M.likePill.ms, reduced, busy);
  const nudgeT = useKeyframeLoop(M.nudge.at, M.nudge.ms, reduced);
  const swayX = swayT.interpolate({ inputRange: [...M.sway.at], outputRange: [...M.sway.x] });
  const swayRotate = swayT.interpolate({
    inputRange: [...M.sway.at],
    outputRange: (web ? M.sway.rotateWeb : M.sway.rotateMobile).map((d) => `${d}deg`),
  });
  const dislikeOp = reduced ? 1 : swayT.interpolate({ inputRange: [...M.dislikePill.at], outputRange: [...M.dislikePill.opacity] });
  const likeOp = reduced ? 1 : rightT.interpolate({ inputRange: [...M.likePill.at], outputRange: [...M.likePill.opacity] });
  const nudge = nudgeT.interpolate({ inputRange: [...M.nudge.at], outputRange: [0, M.nudge.x, 0] });

  // Drag + fly-off, same rules and look as the feed's SwipeCard.
  const drag = useRef(new Animated.Value(0)).current;
  const appear = useRef(new Animated.Value(1)).current; // fades the card back in after a fly-off
  const [width, setWidth] = useState(0);
  const axis = useRef<Axis | null>(null);
  const live = useRef({ width, reduced });
  live.current = { width, reduced };
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  const responder = useMemo(() => {
    const springBack = () =>
      Animated.spring(drag, { toValue: 0, useNativeDriver: NATIVE_DRIVER, friction: 7 }).start(() => setBusy(false));
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        axis.current = null;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, g) => {
        if (axis.current === null) axis.current = lockAxis(g.dx, g.dy);
        return axis.current === 'x';
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        drag.stopAnimation();
        setBusy(true);
      },
      onPanResponderMove: (_, g) => drag.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        axis.current = null;
        const { width: w, reduced: still } = live.current;
        const decision = h.release(g.dx, g.vx, w);
        if (!decision) return springBack();
        if (still) {
          drag.setValue(0);
          setBusy(false);
          later(h.reset, PRACTICE_RESET_MS);
          return;
        }
        Animated.timing(drag, { toValue: (decision === 'like' ? 1 : -1) * w * 1.3, duration: 200, useNativeDriver: NATIVE_DRIVER }).start(() => {
          // Off screen: wait, then bring the practice card back for another try.
          later(() => {
            drag.setValue(0);
            h.reset();
            appear.setValue(0);
            Animated.timing(appear, { toValue: 1, duration: 200, useNativeDriver: NATIVE_DRIVER }).start(() => setBusy(false));
          }, PRACTICE_RESET_MS);
        });
      },
      onPanResponderTerminate: () => {
        axis.current = null;
        springBack();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, h]);
  // Confirmation: shows for PRACTICE_MESSAGE_MS after each event, then clears.
  const toast = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!state.message) return;
    AccessibilityInfo.announceForAccessibility?.(state.message);
    toast.setValue(reduced ? 1 : 0);
    if (!reduced) Animated.timing(toast, { toValue: 1, duration: 150, useNativeDriver: NATIVE_DRIVER }).start();
    const t = setTimeout(h.dismiss, PRACTICE_MESSAGE_MS);
    return () => clearTimeout(t);
  }, [state.seq, state.message, reduced, toast, h]);

  const reach = Math.max(1, width * SWIPE_THRESHOLD);
  const span = Math.max(1, width);
  const likeOverlay = drag.interpolate({ inputRange: [0, reach], outputRange: [0, 1], extrapolate: 'clamp' });
  const dislikeOverlay = drag.interpolate({ inputRange: [-reach, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const rotate = drag.interpolate({ inputRange: [-span, 0, span], outputRange: [`-${MAX_TILT_DEG}deg`, '0deg', `${MAX_TILT_DEG}deg`] });
  const motion = reduced ? null : { transform: [{ translateX: drag }, { rotate }], opacity: appear };
  // Web: vertical pans still scroll the tour; horizontal ones drag the card. No text
  // selection while dragging with a mouse.
  const webDrag = Platform.OS === 'web' ? ({ touchAction: 'pan-y', userSelect: 'none', cursor: 'grab' } as unknown as ViewStyle) : null;

  return (
    <>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <Animated.View style={[webDrag, motion]} {...responder.panHandlers}>
          <PracticeCard
            p={p}
            web={web}
            title={props.title}
            lead={props.lead}
            caption={props.caption}
            swayX={reduced ? 0 : swayX}
            swayRotate={reduced ? '0deg' : swayRotate}
            likeOpacity={likeOp}
            dislikeOpacity={dislikeOp}
            reaction={state.reaction}
            onLike={h.like}
            onDislike={h.dislike}
            onShare={h.share}
            onSource={h.source}
          />
          <Animated.View pointerEvents="none" style={[styles.overlay, { backgroundColor: tint(p.accent), opacity: likeOverlay }]}>
            <View style={[styles.stamp, { backgroundColor: p.accent }]}>
              <ThumbUpIcon color={p.onAccent} size={36} />
            </View>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.overlay, { backgroundColor: tint(p.warn), opacity: dislikeOverlay }]}>
            <View style={[styles.stamp, { backgroundColor: p.warn }]}>
              <ThumbDownIcon color={p.onAccent} size={36} />
            </View>
          </Animated.View>
        </Animated.View>
        <View style={styles.toastDock} pointerEvents="none">
          <Animated.View
            accessibilityLiveRegion="polite"
            role="status"
            style={[
              styles.toast,
              { backgroundColor: p.ink, opacity: state.message ? toast : 0 },
            ]}
          >
            <Text style={[styles.toastText, { color: p.bg }]}>{state.message ?? ' '}</Text>
          </Animated.View>
        </View>
      </View>
      {props.legend}
      {props.tiles ? <Tiles p={p} tiles={props.tiles} web={web} nudge={reduced ? 0 : nudge} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  stamp: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  toastDock: { position: 'absolute', left: 0, right: 0, bottom: -18, alignItems: 'center' },
  toast: { minHeight: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center' },
  toastText: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
