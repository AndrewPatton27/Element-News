// Motion helpers for the tour (values in TUTORIAL_MOTION, lib/tutorialSteps.ts).
// The design's CSS @keyframes ease each segment between two keyframes with
// `ease-in-out`; useKeyframeLoop does the same with Animated: one eased timing per
// segment, so interpolating the value over the same offsets matches the CSS.
// Uses the built-in Animated (native driver on iOS/Android, JS on web).
// Reduced motion: the value stays at 0 (the static first keyframe); callers pin
// anything that must look "final" (e.g. pills at opacity 1).

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform } from 'react-native';

export const NATIVE_DRIVER = Platform.OS !== 'web';
export const CSS_EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1);

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (!mq) return;
      setReduced(mq.matches);
      const on = () => setReduced(mq.matches);
      mq.addEventListener?.('change', on);
      return () => mq.removeEventListener?.('change', on);
    }
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduced(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// Loops 0 → at[1] → … → 1 forever, each segment ease-in-out over its share of `ms`.
// `paused` (e.g. while the reader drags the practice card) eases back to 0 and waits.
export function useKeyframeLoop(at: readonly number[], ms: number, off: boolean, paused = false): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  const key = at.join(',');
  useEffect(() => {
    if (off || paused) {
      if (off) v.setValue(0);
      else Animated.timing(v, { toValue: 0, duration: 150, easing: CSS_EASE_IN_OUT, useNativeDriver: NATIVE_DRIVER }).start();
      return;
    }
    v.setValue(0);
    const segments: Animated.CompositeAnimation[] = [];
    for (let i = 1; i < at.length; i++) {
      segments.push(
        Animated.timing(v, {
          toValue: at[i],
          duration: Math.max(0, (at[i] - at[i - 1]) * ms),
          easing: CSS_EASE_IN_OUT,
          useNativeDriver: NATIVE_DRIVER,
        }),
      );
    }
    segments.push(Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: NATIVE_DRIVER }));
    const loop = Animated.loop(Animated.sequence(segments));
    loop.start();
    return () => loop.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, key, ms, off, paused]);
  return v;
}

// Linear 0 → 1 loop (the numbers strip). Stays at 0 when off.
export function useLinearLoop(ms: number, off: boolean): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    if (off) return;
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: NATIVE_DRIVER }));
    loop.start();
    return () => loop.stop();
  }, [v, ms, off]);
  return v;
}
