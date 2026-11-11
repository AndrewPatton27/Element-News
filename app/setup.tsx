// /setup: the three-question setup (A-17, flag `onboarding`). One question per step, a progress line, Back and Next,
// and "Skip for now" on every step. Answers seed this device's follows, interests and depth (lib/onboarding/setupLogic.ts);
// signed in, the followed topics also go to the account. The screen stays reachable at /setup (Account links to it) so
// the answers can be changed later. With the flag off the screen sends the reader back to the feed.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAccount } from '../lib/account/accountContext';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { fonts, font, radius } from '../lib/theme/theme';
import { readFlags } from '../lib/flags/flags';
import { FINE_NAMES, LANE_TOPICS, MACRO_FINE } from '../lib/topics/fineTopics';
import { useSignals } from '../lib/signals/useSignals';
import { DEPTH_OPTIONS, EMPTY_ANSWERS, INVEST_OPTIONS, SETUP_CATEGORIES, planSetup, skipSetup, type SetupAnswers } from '../lib/onboarding/setupLogic';
import { toggleTopic } from '../lib/account/accountLogic';
import { FOLLOWS_KEY, parseFollows, serializeFollows } from '../lib/following/followingLogic';
import { defaultStore } from '../lib/storage/storage';
import { PrimaryButton } from '../components/account/FormParts';
import { TopicChip } from '../components/feed/TopicPicker';
import { ScreenShell } from '../components/shell/ScreenShell';

const store = defaultStore();
const STEPS = 3;

export default function SetupScreen() {
  const p = usePalette();
  const wide = useWide();
  const acct = useAccount();
  const { signals, update } = useSignals();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SetupAnswers>(() => ({ ...EMPTY_ANSWERS, topics: [...signals.interests, ...signals.optIn], depth: signals.depth }));
  const on = readFlags().onboarding;
  // A feed URL that came through the tour (?next=latest) gets its own tab back; otherwise For you.
  const { next } = useLocalSearchParams<{ next?: string }>();
  const nextTab = next === 'top' || next === 'latest' || next === 'for_you' ? next : null;
  useEffect(() => {
    if (!on) router.replace('/' as never);
  }, [on]);
  if (!on) return null;

  const leave = () => router.replace(`/?tab=${nextTab ?? 'for_you'}` as never);

  async function finish() {
    const existing = acct.user && acct.prefs ? acct.prefs.followed : parseFollows(store.get(FOLLOWS_KEY)).topics;
    const plan = planSetup(answers, signals, existing);
    update(() => plan.signals);
    if (plan.followTopics.length > 0) {
      if (acct.user && acct.prefs) {
        await acct.savePrefs([...acct.prefs.followed, ...plan.followTopics], acct.prefs.hidden).catch(() => undefined);
      } else {
        const f = parseFollows(store.get(FOLLOWS_KEY));
        store.set(FOLLOWS_KEY, serializeFollows({ ...f, topics: [...f.topics, ...plan.followTopics.filter((t) => !f.topics.includes(t))] }));
      }
    }
    leave();
  }
  function skip() {
    update(skipSetup);
    router.replace((nextTab ? `/?tab=${nextTab}` : '/') as never);
  }

  const heading = ['What do you want to follow?', 'Do you invest?', 'How much detail do you want?'][step];
  const sub = [
    'Pick any. Your For you feed puts these first. Crypto and Tech/AI are off unless you choose them, and show only reports from regulators and filings.',
    'It only changes which topics we start you on. Element never gives buy or sell advice.',
    'You can change this any time in Account, Saved and signals.',
  ][step];

  return (
    <ScreenShell tab="me" title="Set up Element">
      <View style={[styles.column, wide && styles.columnWide]} testID="setup">
        <Text style={[styles.progress, { color: p.muted }]} accessibilityLiveRegion="polite" testID="setup-progress">
          Question {step + 1} of {STEPS}
        </Text>
        <Text style={[styles.heading, { color: p.ink, fontSize: wide ? font.title : 28 }]} accessibilityRole="header">
          {heading}
        </Text>
        <Text style={[styles.sub, { color: p.inkSoft }]}>{sub}</Text>

        {step === 0 ? (
          <View style={styles.wrap} accessibilityRole="list">
            {MACRO_FINE.map((t) => (
              <TopicChip key={t} label={FINE_NAMES[t]} on={answers.topics.includes(t)} onPress={() => setAnswers((a) => ({ ...a, topics: toggleTopic(a.topics, t) }))} />
            ))}
            {SETUP_CATEGORIES.map((c) => (
              <TopicChip key={c.slug} label={c.name} on={answers.topics.includes(c.slug)} onPress={() => setAnswers((a) => ({ ...a, topics: toggleTopic(a.topics, c.slug) }))} />
            ))}
            {LANE_TOPICS.map((t) => (
              <TopicChip key={t} label={`${FINE_NAMES[t]} (optional)`} on={answers.topics.includes(t)} onPress={() => setAnswers((a) => ({ ...a, topics: toggleTopic(a.topics, t) }))} />
            ))}
          </View>
        ) : null}

        {step === 1 ? (
          <View style={styles.options} accessibilityRole="radiogroup">
            {INVEST_OPTIONS.map((o) => (
              <Option key={o.id} label={o.label} hint={o.hint} on={answers.invest === o.id} onPress={() => setAnswers((a) => ({ ...a, invest: o.id }))} />
            ))}
          </View>
        ) : null}

        {step === 2 ? (
          <View style={styles.options} accessibilityRole="radiogroup">
            {DEPTH_OPTIONS.map((o) => (
              <Option key={o.id} label={o.label} hint={o.hint} on={answers.depth === o.id} onPress={() => setAnswers((a) => ({ ...a, depth: o.id }))} />
            ))}
          </View>
        ) : null}

        <View style={styles.actions}>
          <PrimaryButton label={step === STEPS - 1 ? 'Done' : 'Next'} onPress={step === STEPS - 1 ? () => void finish() : () => setStep(step + 1)} />
          {step > 0 ? (
            <Pressable onPress={() => setStep(step - 1)} accessibilityRole="button" style={styles.link}>
              <Text style={[styles.linkText, { color: p.accentInk }]}>Back</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={skip} accessibilityRole="button" style={styles.link}>
            <Text style={[styles.linkText, { color: p.inkSoft }]}>Skip for now</Text>
          </Pressable>
        </View>
      </View>
    </ScreenShell>
  );
}

function Option({ label, hint, on, onPress }: { label: string; hint: string; on: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={on}
      accessibilityLabel={`${label}. ${hint}`}
      style={({ pressed }) => [styles.option, { borderColor: on ? p.accent : p.borderStrong, backgroundColor: on ? p.accentSoft : p.surface, opacity: pressed ? 0.8 : 1 }]}
    >
      <Text style={[styles.optionTitle, { color: on ? p.accentInk : p.ink }]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
      <Text style={[styles.optionHint, { color: p.muted }]}>{hint}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  column: { gap: 14 },
  columnWide: { maxWidth: 640, width: '100%', alignSelf: 'flex-start' },
  progress: { fontFamily: fonts.sansMedium, fontSize: font.meta },
  heading: { fontFamily: fonts.serif, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 22 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  options: { gap: 10 },
  option: { minHeight: 64, borderRadius: radius.tile, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 16, gap: 2, justifyContent: 'center' },
  optionTitle: { fontFamily: fonts.sansSemi, fontSize: font.body },
  optionHint: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 19 },
  actions: { gap: 6, alignItems: 'stretch', marginTop: 8 },
  link: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  linkText: { fontFamily: fonts.sansSemi, fontSize: font.nav },
});
