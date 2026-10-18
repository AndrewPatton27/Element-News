// The "Get this at 7 AM" card on the Brief: a real sign-up for the email brief. Email, Daily /
// Weekly / Both, a send time (5 AM to 10 PM, the reader's time zone, default 7 AM), the consent
// line, and one button. Double opt-in: the answer is "Check your email to confirm" (the same for
// every valid address, so it never reveals who is already subscribed). The address is kept on
// this device only if the reader ticks the box.

import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Api } from '../lib/api.ts';
import type { BriefKind } from '../contract/types.ts';
import {
  BRIEF_CONSENT,
  BRIEF_PROMPT_TEXT,
  BRIEF_PROMPT_TITLE,
  DEFAULT_SEND_HOUR,
  detectTimezone,
  readRememberedEmail,
  saveRememberedEmail,
  signupMessage,
  validateSignup,
  type SignupMessage,
} from '../lib/briefLogic';
import { defaultStore } from '../lib/storage';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { HourPicker, KindPicker } from './BriefSignupFields';
import { fieldStyles } from './PasswordField';
import { PrimaryButton } from './FormParts';

const store = defaultStore();

export function BriefSignup({ api, initialKind = 'daily', wide }: { api: Api; initialKind?: BriefKind; wide: boolean }) {
  const p = usePalette();
  const remembered = useMemo(() => readRememberedEmail(store), []);
  const tz = useMemo(() => detectTimezone(), []);
  const [email, setEmail] = useState(remembered);
  const [kind, setKind] = useState<BriefKind>(initialKind);
  const [hour, setHour] = useState(DEFAULT_SEND_HOUR);
  const [remember, setRemember] = useState(remembered !== '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SignupMessage | null>(null);
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current) return;
    const check = validateSignup({ email, kind, hour, tz });
    if (!check.ok) {
      setProblem(check.error);
      setResult(null);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setResult(null);
    let status: 'pending' | 'invalid' | 'limited' | 'unavailable' = 'unavailable';
    try {
      const r = await api.subscribeBrief(check.value);
      status = r.status;
    } catch {
      status = 'unavailable';
    }
    inFlight.current = false;
    setBusy(false);
    const msg = signupMessage(status);
    setResult(msg);
    if (status === 'pending') {
      saveRememberedEmail(store, check.value.email, remember);
      setSent(true);
    }
  }

  const head = (
    <View style={styles.head}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.accentInk }]}>
        {BRIEF_PROMPT_TITLE}
      </Text>
      <Text style={[styles.text, { color: p.inkSoft }]}>{BRIEF_PROMPT_TEXT}</Text>
    </View>
  );

  if (sent && result?.tone === 'ok') {
    return (
      <View accessibilityLabel="Email brief sign-up" style={[styles.card, wide && styles.cardWide, { backgroundColor: p.accentSoft }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.accentInk }]}>
          {result.title}
        </Text>
        <Text style={[styles.text, { color: p.inkSoft }]} accessibilityLiveRegion="polite">
          {result.text}
        </Text>
        <Pressable onPress={() => setSent(false)} accessibilityRole="button" style={styles.linkBtn}>
          <Text style={[styles.linkText, { color: p.accent }]}>Use a different email</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View accessibilityLabel="Email brief sign-up" style={[styles.card, wide && styles.cardWide, { backgroundColor: p.accentSoft }]}>
      {head}
      <View style={styles.form}>
        <View style={styles.field}>
          <Text style={[fieldStyles.label, { color: p.ink }]}>Email</Text>
          <TextInput
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setProblem(null);
            }}
            onSubmitEditing={submit}
            style={[fieldStyles.input, { borderColor: problem ? p.bad : p.borderStrong, backgroundColor: p.surface, color: p.ink }]}
            keyboardType="email-address"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            placeholder="name@example.com"
            placeholderTextColor={p.muted}
            accessibilityLabel="Email address"
            returnKeyType="send"
          />
        </View>
        <View style={styles.field}>
          <Text style={[fieldStyles.label, { color: p.ink }]}>Which brief</Text>
          <KindPicker value={kind} onChange={setKind} />
        </View>
        <View style={styles.field}>
          <Text style={[fieldStyles.label, { color: p.ink }]}>Send it at</Text>
          <HourPicker hour={hour} tz={tz} onChange={setHour} />
        </View>
        <Pressable
          onPress={() => setRemember((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: remember }}
          aria-checked={remember}
          accessibilityLabel="Remember my email on this device"
          style={styles.checkRow}
        >
          <View style={[styles.box, { borderColor: p.borderStrong, backgroundColor: remember ? p.accent : p.surface }]}>
            {remember ? <Text style={[styles.tick, { color: p.onAccent }]}>✓</Text> : null}
          </View>
          <Text style={[styles.checkText, { color: p.inkSoft }]}>Remember my email on this device</Text>
        </Pressable>
        <Text style={[styles.consent, { color: p.inkSoft }]}>{BRIEF_CONSENT}</Text>
        {problem ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: p.bad }]}>
            {problem}
          </Text>
        ) : null}
        {result && result.tone === 'error' ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.resultBox}>
            <Text style={[styles.resultTitle, { color: p.bad }]}>{result.title}</Text>
            <Text style={[styles.text, { color: p.inkSoft }]}>{result.text}</Text>
          </View>
        ) : null}
        <PrimaryButton label={busy ? 'Signing you up…' : 'Email me the brief'} onPress={submit} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 16, gap: 12 },
  cardWide: { borderRadius: 20, padding: 22 },
  head: { gap: 4 },
  title: { fontFamily: fonts.serif, fontSize: 20, lineHeight: 24 },
  text: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  form: { gap: 14 },
  field: { gap: 6 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tick: { fontSize: 14, fontFamily: fonts.sansSemi },
  checkText: { flex: 1, fontFamily: fonts.sans, fontSize: 14 },
  consent: { fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 18 },
  error: { fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20 },
  resultBox: { gap: 2 },
  resultTitle: { fontFamily: fonts.sansSemi, fontSize: 15 },
  linkBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  linkText: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
