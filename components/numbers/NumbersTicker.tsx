// A looping "Numbers to know" strip under the wide top bar (44 px, design Web-Final).
// The macro facts scroll horizontally like a ferris wheel, moving left to right
// and wrapping around forever. The list is laid out twice back to back so the
// loop is seamless; we measure one copy and translate by its width.
//
// Driven by requestAnimationFrame writing an Animated.Value: no React render per frame
// (setValue updates the transform directly on web and native). It pauses while the pointer
// is over it or it has keyboard focus, and with reduced motion it does not move (the strip
// scrolls sideways by hand instead). The moving strip is ONE link for keyboard and screen
// readers (its label lists the numbers), so Tab never walks through off-screen or cloned
// items. Soft fades at both ends hide the cut where the loop enters and leaves.

import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useRouter } from 'expo-router';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, MacroFact } from '../../contract/types.ts';
import type { Api } from '../../lib/api/api.ts';
import { changeText, factA11yLabel } from '../../lib/shared/format';
import { withToneLabel } from '../../lib/numbers/numberTone';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { changeColor } from '../card/DataCard';
import { useNumbers } from './NumbersPanel';

// Pixels travelled per second. Lower is calmer.
const SPEED = 48;
// Edge fade: bands of the strip colour, most opaque at the very edge.
const FADE_STEPS = [0.95, 0.7, 0.45, 0.2];

function factLabel(f: MacroFact): string {
  return withToneLabel(factA11yLabel(f), f.series_id, f.direction);
}

export function NumbersTicker({ api }: { api: Api; config: AppConfig | null }) {
  const p = usePalette();
  const { facts } = useNumbers(api);
  const router = useRouter();
  const openNumbers = () => router.push('/numbers');
  const [setWidth, setSetWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;

  // Advance an offset in [0, setWidth) every frame. The track is translated by
  // (offset - setWidth), so it moves left to right and loops seamlessly because
  // a second identical copy trails behind.
  const raf = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  const pos = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);
  const wrapRef = useRef<ComponentRef<typeof View>>(null);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  // Hover pauses the marquee (web only; the ref is the DOM node there).
  useEffect(() => {
    const el = wrapRef.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el || typeof el.addEventListener !== 'function') return;
    const enter = () => {
      hovered.current = true;
    };
    const leave = () => {
      hovered.current = false;
    };
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
    };
  }, [reduced, facts]);
  useEffect(() => {
    if (setWidth <= 0 || reduced) return;
    const step = (now: number) => {
      if (last.current != null && !hovered.current && !focused.current) {
        const dt = (now - last.current) / 1000;
        pos.current = (pos.current + dt * SPEED) % setWidth;
        x.setValue(pos.current - setWidth);
      }
      last.current = now;
      raf.current = requestAnimationFrame(step);
    };
    x.setValue(pos.current - setWidth);
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      last.current = null;
    };
  }, [setWidth, reduced, x]);

  if (!facts || facts.length === 0) return null;

  const content = (f: MacroFact) => (
    <>
      <Text style={[styles.label, { color: p.inkSoft }]} numberOfLines={1}>
        {f.label}
      </Text>
      <Text style={[styles.value, { color: p.ink }]} numberOfLines={1}>
        {f.value}
      </Text>
      {changeText(f) ? (
        <Text style={[styles.change, { color: changeColor(p, f) }]} numberOfLines={1}>
          {changeText(f)}
        </Text>
      ) : null}
    </>
  );

  if (reduced) {
    // Nothing moves: a row of separate links the reader scrolls sideways by hand.
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Numbers to know" contentContainerStyle={styles.reduced}>
        <View style={styles.row}>
          {facts.map((f) => (
            <Pressable
              key={f.series_id}
              onPress={openNumbers}
              accessibilityRole="link"
              accessibilityLabel={`${factLabel(f)}. Opens Numbers to know.`}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.75 : 1 }]}
            >
              {content(f)}
            </Pressable>
          ))}
        </View>
      </ScrollView>
    );
  }

  const row = (keyPrefix: string, onMeasure?: (w: number) => void) => (
    <View
      style={styles.row}
      onLayout={onMeasure ? (e) => onMeasure(e.nativeEvent.layout.width) : undefined}
      // The whole strip is one link with a full label, so the items themselves are hidden.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    >
      {facts.map((f) => (
        <View key={`${keyPrefix}-${f.series_id}`} style={styles.item}>
          {content(f)}
        </View>
      ))}
    </View>
  );

  const fade = (side: 'left' | 'right') => (
    <View pointerEvents="none" style={[styles.fade, side === 'left' ? styles.fadeLeft : styles.fadeRight]}>
      {FADE_STEPS.map((o) => (
        <View key={o} style={{ flex: 1, backgroundColor: p.bg, opacity: o }} />
      ))}
    </View>
  );

  return (
    <Pressable
      ref={wrapRef}
      onPress={openNumbers}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      accessibilityRole="link"
      accessibilityLabel={`Numbers to know: ${facts.map(factLabel).join('; ')}. Opens Numbers to know.`}
      style={({ pressed }) => [styles.wrap, { opacity: pressed ? 0.8 : 1 }]}
    >
      <Animated.View style={[styles.track, { transform: [{ translateX: x }] }]}>
        {row('a', setSetWidth)}
        {row('b')}
      </Animated.View>
      {fade('left')}
      {fade('right')}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', height: 44, justifyContent: 'center' },
  track: { flexDirection: 'row', alignSelf: 'flex-start' },
  row: { flexDirection: 'row', gap: 44, paddingRight: 44, alignItems: 'center' },
  reduced: { paddingHorizontal: 16, alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'baseline', gap: 8, minHeight: 44, paddingVertical: 10 },
  label: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.48, textTransform: 'uppercase' },
  value: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 22 },
  change: { fontFamily: fonts.sansSemi, fontSize: 12 },
  fade: { position: 'absolute', top: 0, bottom: 0, width: 28, flexDirection: 'row' },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0, flexDirection: 'row-reverse' },
});
