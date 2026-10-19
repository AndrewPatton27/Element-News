// The first-run tour: 4 steps (designs docs/design/mobile/Mobile-Tutorial*.dc.html and
// docs/design/web/Web-Tutorial*.dc.html; copy in lib/tutorialSteps.ts, logic in
// lib/tutorialLogic.ts). Used two ways:
// - as an overlay from app/_layout.tsx on the first visit (TutorialGate below);
// - as the /tutorial route (app/tutorial.tsx), replayable from Me / About.
//
// Controls: Skip tutorial (top right), Back, Next ("Swipe up to continue" on phones,
// "Press ↓ or scroll to continue" on wide web), and on the last step Start reading /
// Create a free account. Phones: swipe up = next, swipe down = back. Web: ↓/→/PageDown
// next, ↑/←/PageUp back, Esc skips; the wheel moves a step when the step fits on screen.
// The tour's key handler runs first (capture) and stops the feed behind it from moving.
// Motion follows the design @keyframes (components/TutorialMotion.tsx); the practice
// card on step 1 is interactive but saves nothing (components/TutorialPractice.tsx).
// With reduced motion the practice card, ticker and hint arrow stay still.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_NAME } from '../../lib/api/config';
import { DISCLAIMER_FALLBACK } from '../../lib/shared/labels';
import { defaultStore } from '../../lib/storage/storage';
import { fonts } from '../../lib/theme/theme';
import {
  backStep,
  hasSeenTutorial,
  isLastStep,
  keyToAction,
  markTutorialSeen,
  nextStep,
  progressLabel,
  shouldAutoShow,
  trapTabIndex,
} from '../../lib/tutorial/tutorialLogic';
import { PRACTICE_FOOTER, TUTORIAL_FOOTNOTE, TUTORIAL_MOTION, getTutorialSteps } from '../../lib/tutorial/tutorialSteps';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { ChevronRightIcon, ChevronLeftIcon, ChevronUpIcon } from '../shell/Icons';
import { useKeyframeLoop, useLinearLoop, useReducedMotion } from './TutorialMotion';
import { BriefFollowingPanel, FeedTopPanel, Legend, Recap, StepTransition } from './TutorialParts';
import { PracticeArea } from './TutorialPractice';

export type TutorialExit = 'skip' | 'done' | 'signup';

export function Tutorial({ onExit }: { onExit: (how: TutorialExit) => void }) {
  const p = usePalette();
  const web = useWide();
  const steps = useMemo(() => getTutorialSteps(web ? 'web' : 'mobile'), [web]);
  const count = steps.length;
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  stepRef.current = step;
  const s = steps[step];
  const last = isLastStep(step, count);
  const reduced = useReducedMotion();
  const prevStep = useRef(0);
  const dir: 1 | -1 = step >= prevStep.current ? 1 : -1;
  useEffect(() => {
    prevStep.current = step;
  }, [step]);

  const go = useCallback((to: number) => setStep(to), []);
  const next = useCallback(() => go(nextStep(stepRef.current, count)), [go, count]);
  const back = useCallback(() => go(backStep(stepRef.current, count)), [go, count]);
  const rootRef = useRef<ComponentRef<typeof View>>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // On web, move focus into the modal and return it to the opener when the tour closes.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current as unknown as HTMLElement | null;
    const style = document.createElement('style');
    style.textContent = '#element-tutorial-dialog :is(button,a,[role="button"],[role="link"],[tabindex]):focus-visible{outline:3px solid #146B61!important;outline-offset:3px!important;border-radius:6px}';
    document.head.appendChild(style);
    root?.focus();
    return () => {
      style.remove();
      previousFocus.current?.focus();
    };
  }, []);

  // Scroll to the top and announce the new step.
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    AccessibilityInfo.announceForAccessibility?.(`${progressLabel(step, count)}. ${steps[step]?.title ?? ''}`);
  }, [step, count, steps]);

  // Keyboard (web). Capture phase + stopImmediatePropagation keeps the feed still.
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const root = rootRef.current as unknown as HTMLElement | null;
        const nodes = root ? Array.from(root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('aria-hidden') && el.getAttribute('aria-disabled') !== 'true') : [];
        if (nodes.length === 0) {
          e.preventDefault();
          root?.focus();
        } else {
          const at = nodes.indexOf(document.activeElement as HTMLElement);
          const nextAt = trapTabIndex(at, nodes.length, e.shiftKey);
          if (at < 0 || (e.shiftKey ? at === 0 : at === nodes.length - 1)) {
            e.preventDefault();
            nodes[nextAt]?.focus();
          }
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyToAction(e.key, stepRef.current, count);
      // Swallow the feed's own keys while the tour is open, even when they do nothing here.
      if (action || ['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      if (action === 'next') next();
      else if (action === 'back') back();
      else if (action === 'skip') exitRef.current('skip');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [count, next, back]);

  // Wheel / trackpad (web): one step per gesture, only when the step fits on screen.
  const fits = useRef(true);
  const viewH = useRef(0);
  const contentH = useRef(0);
  const updateFits = () => (fits.current = contentH.current <= viewH.current + 2);
  // Scrolling to the bottom of a step that is taller than the screen moves on to the next step.
  const bottomFired = useRef(false);
  useEffect(() => {
    bottomFired.current = false;
  }, [step]);

  const lastWheel = useRef(0);
  useEffect(() => {
    const el = rootRef.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el || typeof el.addEventListener !== 'function') return;
    const onWheel = (e: WheelEvent) => {
      if (!fits.current || Math.abs(e.deltaY) < 30) return;
      const now = Date.now();
      if (now - lastWheel.current < 700) return;
      lastWheel.current = now;
      if (e.deltaY > 0 && !isLastStep(stepRef.current, count)) next();
      else if (e.deltaY < 0) back();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [count, next, back]);

  // Swipe up / down (phones).
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => !web && Math.abs(g.dy) > 24 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5 && fits.current,
        onPanResponderRelease: (_e, g) => {
          if (g.dy < -50 && !isLastStep(stepRef.current, count)) next();
          else if (g.dy > 50) back();
        },
      }),
    [web, count, next, back],
  );

  // Motion (design @keyframes, values in TUTORIAL_MOTION): the continue arrow bounces
  // (elhint 1.6 s), the numbers strip scrolls (elscroll 30 s phones / 40 s web).
  // The practice card's loops live in components/TutorialPractice.tsx.
  const bounce = useKeyframeLoop(TUTORIAL_MOTION.hint.at, TUTORIAL_MOTION.hint.ms, reduced);
  const marquee = useLinearLoop(web ? TUTORIAL_MOTION.marquee.msWeb : TUTORIAL_MOTION.marquee.msMobile, reduced || s.id !== 'top');
  const hintY = TUTORIAL_MOTION.hint.y * (web ? 1 : -1);
  const bounceY = bounce.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, hintY, 0] });

  const progress = progressLabel(step, count);
  const H = web ? styles.h1Web : styles.h1;

  return (
    <View
      ref={rootRef}
      nativeID="element-tutorial-dialog"
      tabIndex={-1}
      role="dialog"
      aria-modal
      aria-labelledby="element-tutorial-title"
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: p.bg }]}
      {...pan.panHandlers}
    >
      <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
        <View style={[styles.header, web && styles.headerWeb, { borderBottomColor: web ? p.border : 'transparent', backgroundColor: web ? p.surface : p.bg }]}>
          <Text nativeID="element-tutorial-title" role="heading" aria-level={2} style={[styles.wordmark, web && styles.wordmarkWeb, { color: p.accent }]} aria-hidden={false}>
            {APP_NAME}
          </Text>
          <Pressable
            onPress={() => onExit('skip')}
            accessibilityRole="button"
            accessibilityLabel="Skip tutorial"
            accessibilityHint="Closes the tour. You can replay it in Me."
            style={({ pressed }) => [styles.skip, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.skipText, { color: p.inkSoft }]}>Skip tutorial</Text>
          </Pressable>
        </View>

        <ScrollView
          ref={scroll}
          scrollEventThrottle={64}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            if (fits.current || last || bottomFired.current) return;
            if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 6) {
              bottomFired.current = true;
              setTimeout(() => next(), 220);
            }
          }}
          style={styles.fill}
          contentContainerStyle={[styles.body, web && styles.bodyWeb]}
          onLayout={(e) => {
            viewH.current = e.nativeEvent.layout.height;
            updateFits();
          }}
          onContentSizeChange={(_w, h) => {
            contentH.current = h;
            updateFits();
          }}
        >
          <StepTransition stepKey={step} dir={dir} reduced={reduced}>          <View style={styles.progressRow}>
            <Text accessibilityLiveRegion="polite" style={[styles.progress, web && { fontSize: 14 }, { color: p.accentInk }]}>
              {progress}
            </Text>
            <View style={styles.dots} aria-hidden importantForAccessibility="no-hide-descendants">
              {steps.map((st, i) => (
                <View
                  key={st.id}
                  style={[styles.dot, i === step && { width: web ? 28 : 24 }, { backgroundColor: i === step ? p.accent : p.borderStrong }]}
                />
              ))}
            </View>
          </View>

          {s.id === 'card' ? (
            <PracticeArea
              p={p}
              web={web}
              reduced={reduced}
              title={s.title}
              lead={s.lead}
              caption={s.exampleCaption}
              tiles={s.tiles}
              legend={<Legend p={p} items={s.legend} web={web} />}
            />
          ) : null}

          {s.id === 'top' || s.id === 'brief' ? (
            <>
              <Text role="heading" aria-level={1} style={[H, { color: p.ink }]}>
                {s.title}
              </Text>
              {s.id === 'top' ? (
                <FeedTopPanel p={p} web={web} caption={s.exampleCaption} note={s.practiceNote} marquee={reduced ? 0 : marquee} />
              ) : (
                <BriefFollowingPanel p={p} web={web} caption={s.exampleCaption} note={s.practiceNote} />
              )}
              <Legend p={p} items={s.legend} web={web} />
            </>
          ) : null}

          {s.id === 'recap' ? (
            <>
              <View style={styles.recapHead}>
                <Text role="heading" aria-level={1} style={[web ? styles.h1RecapWeb : styles.h1Recap, { color: p.ink }]}>
                  {s.title}
                </Text>
                {s.lead ? <Text style={[web ? styles.leadWeb : styles.lead, { color: p.inkSoft }]}>{s.lead}</Text> : null}
              </View>
              {s.recap ? <Recap p={p} rows={s.recap} web={web} /> : null}
              <View style={styles.ctas}>
                <Pressable
                  onPress={() => onExit('done')}
                  accessibilityRole="button"
                  accessibilityLabel="Start reading"
                  style={({ pressed }) => [styles.primary, web && { minHeight: 60 }, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
                >
                  <Text style={[styles.primaryText, { color: p.onAccent }]}>Start reading</Text>
                </Pressable>
                <Pressable
                  onPress={() => onExit('signup')}
                  accessibilityRole="button"
                  accessibilityLabel="Create a free account"
                  style={({ pressed }) => [styles.secondary, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.85 : 1 }]}
                >
                  <Text style={[styles.secondaryText, { color: p.ink }]}>Create a free account</Text>
                </Pressable>
                <Text style={[styles.footnote, { color: p.muted }]}>{TUTORIAL_FOOTNOTE}</Text>
              </View>
            </>
          ) : null}

          <View style={styles.nav}>
            {step > 0 ? (
              <Pressable
                onPress={back}
                accessibilityRole="button"
                accessibilityLabel="Back, previous step"
                style={({ pressed }) => [styles.navBtn, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.6 : 1 }]}
              >
                <ChevronLeftIcon color={p.inkSoft} size={20} />
                <Text style={[styles.backText, { color: p.ink }]}>Back</Text>
              </Pressable>
            ) : (
              <View style={styles.back} />
            )}
            {!last && s.continueHint ? (
              <Pressable
                onPress={next}
                accessibilityRole="button"
                accessibilityLabel={`Next step. ${s.continueHint}`}
                style={({ pressed }) => [styles.continue, { opacity: pressed ? 0.7 : 1 }]}
              >
                {web ? <Text style={[styles.continueText, { color: p.accent }]}>{s.continueHint}</Text> : null}
                <Animated.View style={{ transform: [{ translateY: reduced ? 0 : bounceY }, { rotate: web ? '180deg' : '0deg' }] }}>
                  {/* Design: a double chevron, the trailing one at 45% opacity. */}
                  <View style={styles.hintIcon}>
                    <ChevronUpIcon color={p.accent} size={30} strokeWidth={2.4} />
                    <View style={styles.hintTrail}>
                      <ChevronUpIcon color={p.accent} size={30} strokeWidth={2.4} />
                    </View>
                  </View>
                </Animated.View>
                
              </Pressable>
            ) : null}
            <Pressable
              onPress={last ? () => onExit('done') : next}
              accessibilityRole="button"
              accessibilityLabel={last ? 'Done, finish the tour' : 'Next'}
              style={({ pressed }) => [styles.navBtn, { backgroundColor: '#0B6B5D', borderColor: '#0B6B5D', opacity: pressed ? 0.8 : 1 }]}
            >
              <Text style={[styles.navBtnText, { color: '#FFFFFF' }]}>{last ? 'Done' : 'Next'}</Text>
              {last ? null : <ChevronRightIcon color="#FFFFFF" size={18} />}
            </Pressable>
          </View>

          {/* The disclaimer, once per step. */}
          <Text style={[styles.footer, { color: p.muted }]}>
            {last ? DISCLAIMER_FALLBACK : `${PRACTICE_FOOTER} · ${DISCLAIMER_FALLBACK}`}
          </Text>
          </StepTransition>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// First-run overlay, rendered by app/_layout.tsx over every screen. Shows once per
// device (versioned key in lib/tutorialLogic.ts), signed in or not.
export function TutorialGate() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    if (shouldAutoShow(hasSeenTutorial(defaultStore()), pathname)) setOpen(true);
  }, [pathname]);
  if (!open) return null;
  return (
    <Tutorial
      onExit={(how) => {
        markTutorialSeen(defaultStore());
        setOpen(false);
        // Finishing or skipping the tour lands on the Trending tab (the t value makes the feed re-read the tab).
        if (how === 'signup') router.push('/signin?mode=signup' as never);
        else router.replace(`/?tab=top&t=${Date.now()}` as never);
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 1000 },
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingLeft: 20, paddingRight: 8 },
  headerWeb: { height: 64, paddingHorizontal: 32, borderBottomWidth: 1 },
  wordmark: { fontFamily: fonts.serif, fontSize: 22, letterSpacing: -0.2 },
  wordmarkWeb: { fontSize: 26 },
  skip: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  skipText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  body: { paddingHorizontal: 16, paddingBottom: 10, gap: 12, flexGrow: 1 },
  bodyWeb: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 32, paddingTop: 28, paddingBottom: 40, gap: 20 },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingBottom: 4 },
  progress: { fontFamily: fonts.sansSemi, fontSize: 13 },
  dots: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  h1: { fontFamily: fonts.serif, fontSize: 28, lineHeight: 31, letterSpacing: -0.5, marginHorizontal: 4 },
  h1Web: { fontFamily: fonts.serif, fontSize: 40, lineHeight: 43, letterSpacing: -0.8 },
  h1Recap: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 36, letterSpacing: -0.6 },
  h1RecapWeb: { fontFamily: fonts.serif, fontSize: 48, lineHeight: 50, letterSpacing: -0.9 },
  recapHead: { gap: 8, marginHorizontal: 4 },
  lead: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 },
  leadWeb: { fontFamily: fonts.sans, fontSize: 18, lineHeight: 27 },
  ctas: { gap: 10, marginTop: 'auto' },
  primary: { minHeight: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: fonts.sansSemi, fontSize: 17 },
  secondary: { minHeight: 52, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontFamily: fonts.sansSemi, fontSize: 16 },
  footnote: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto', paddingTop: 4 },
  back: { width: 88, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  navBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 44, minWidth: 92, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1 },
  navBtnText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  continue: { flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center' },
  continueText: { fontFamily: fonts.sansSemi, fontSize: 16 },
  hintIcon: { width: 30, height: 30 },
  // The design's second path sits 5 of 24 viewBox units lower (6 px at 30 px).
  hintTrail: { position: 'absolute', left: 0, top: 6, opacity: 0.45 },
  footer: { fontFamily: fonts.sans, fontSize: 12, textAlign: 'center', paddingHorizontal: 4 },
});
