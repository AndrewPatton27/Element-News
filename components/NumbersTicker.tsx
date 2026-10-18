// A looping "Numbers to know" strip under the wide top bar (44 px, design Web-Final).
// The macro facts scroll horizontally like a ferris wheel, moving left to right
// and wrapping around forever. The list is laid out twice back to back so the
// loop is seamless; we measure one copy and translate by its width.
//
// Driven by requestAnimationFrame + transform rather than Reanimated, so it
// needs no extra babel plugin and behaves the same on web and native. It pauses
// while the pointer is over it, and with reduced motion it does not move (the
// strip scrolls sideways by hand instead).

import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useRouter } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AppConfig } from '../contract/types.ts';
import type { Api } from '../lib/api.ts';
import { changeText, factA11yLabel } from '../lib/format';
import { withToneLabel } from '../lib/numberTone';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { changeColor } from './DataCard';
import { useNumbers } from './NumbersPanel';

// Pixels travelled per second. Lower is calmer.
const SPEED = 48;

export function NumbersTicker({ api, config }: { api: Api; config: AppConfig | null }) {
  const p = usePalette();
  const { facts } = useNumbers(api);
  const router = useRouter();
  const openNumbers = () => router.push('/numbers');
  const [setWidth, setSetWidth] = useState(0);
  const [offset, setOffset] = useState(0);

  // Advance an offset in [0, setWidth) every frame. The track is translated by
  // (offset - setWidth), so it moves left to right and loops seamlessly because
  // a second identical copy trails behind.
  const raf = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  const pos = useRef(0);
  const paused = useRef(false);
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
      paused.current = true;
    };
    const leave = () => {
      paused.current = false;
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
      if (last.current != null && !paused.current) {
        const dt = (now - last.current) / 1000;
        pos.current = (pos.current + dt * SPEED) % setWidth;
        setOffset(pos.current);
      }
      last.current = now;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      last.current = null;
    };
  }, [setWidth, reduced]);

  if (!facts || facts.length === 0) return null;

  const translateX = setWidth > 0 && !reduced ? offset - setWidth : 0;

  const row = (keyPrefix: string, onMeasure?: (w: number) => void) => (
    <View
      style={styles.row}
      onLayout={onMeasure ? (e) => onMeasure(e.nativeEvent.layout.width) : undefined}
      // The measured copy carries accessibility; the clone is decorative.
      accessibilityElementsHidden={onMeasure ? undefined : true}
      importantForAccessibility={onMeasure ? 'auto' : 'no-hide-descendants'}
    >
      {facts.map((f) => (
        <Pressable
          key={`${keyPrefix}-${f.series_id}`}
          onPress={openNumbers}
          accessibilityRole="link"
          accessibilityLabel={`${withToneLabel(factA11yLabel(f), f.series_id, f.direction)}. Opens Numbers to know.`}
          style={({ pressed }) => [styles.item, { opacity: pressed ? 0.75 : 1 }]}
        >
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
        </Pressable>
      ))}
    </View>
  );

  if (reduced) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Numbers to know" contentContainerStyle={styles.reduced}>
        {row('a')}
      </ScrollView>
    );
  }

  return (
    <View ref={wrapRef} style={styles.wrap} accessibilityRole="list" accessibilityLabel="Numbers to know, scrolling">
      <View style={[styles.track, { transform: [{ translateX }] }]}>
        {row('a', setSetWidth)}
        {row('b')}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', height: 44, justifyContent: 'center' },
  track: { flexDirection: 'row', alignSelf: 'flex-start' },
  row: { flexDirection: 'row', gap: 44, paddingRight: 44, alignItems: 'center' },
  reduced: { paddingHorizontal: 32, alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'baseline', gap: 8, minHeight: 44, paddingVertical: 10 },
  label: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.48, textTransform: 'uppercase' },
  value: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 22 },
  change: { fontFamily: fonts.sansSemi, fontSize: 12 },
});
