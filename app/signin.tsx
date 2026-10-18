// Sign in / create account / forgot password, with email and password (designs:
// docs/design/{mobile,web}/*-SignIn and *-CreateAccount). Create account is a
// mode of this screen (also reachable as /signin?mode=signup). After the first
// sign-in the topic picker opens; otherwise back to the feed.

import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { isOnboardingSkipped, useAccount } from '../lib/accountContext';
import { needsOnboarding } from '../lib/accountLogic';
import { useAppData } from '../lib/appData';
import { disclaimerText } from '../lib/labels';
import { RESET_SENT_MESSAGE, validateCredentials, validateEmail } from '../lib/session';
import { usePalette, useWide } from '../lib/useTheme';
import { userMessage } from '../lib/errors';
import { fonts, font, radius } from '../lib/theme';
import { PasswordField, fieldStyles } from '../components/PasswordField';
import { OutlineButton, PrimaryButton } from '../components/FormParts';
import { ScreenShell } from '../components/ScreenShell';

type Mode = 'signin' | 'signup' | 'forgot';

export const AGE_REQUIRED_MESSAGE = 'Please confirm you are 18 or older to create an account.';

// Where the emailed reset link should land: this site's /reset-password page.
function resetRedirectUrl(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.origin}/reset-password`;
  return Linking.createURL('/reset-password');
}

const TITLES: Record<Mode, string> = { signin: 'Sign in to follow and personalize', signup: 'Create your account', forgot: 'Reset your password' };
const HEADERS: Record<Mode, string> = { signin: 'Sign in', signup: 'Create account', forgot: 'Reset password' };

export default function SignInScreen() {
  const p = usePalette();
  const wide = useWide();
  const acct = useAccount();
  const { config } = useAppData();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [adult, setAdult] = useState(false); // Create account: "I am 18 or older"
  const [busy, setBusy] = useState(false);
  const [hideSignal, setHideSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null); // sample mode: offer the test link

  // Already signed in (back button, bookmark): show the account instead of the form.
  // Only for arriving signed in: after our own sign-in, submit() decides where to go.
  const arrivedSignedIn = useRef(acct.user !== null);
  useEffect(() => {
    if (arrivedSignedIn.current && acct.user) router.replace('/account' as never);
  }, [acct.user]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setSentTo(null);
    setPassword('');
    setConfirm('');
    setAdult(false);
  }

  async function submit() {
    if (busy) return;
    setError(null);
    setInfo(null);
    if (mode === 'forgot') {
      const problem = validateEmail(email);
      if (problem) return setError(problem);
      setBusy(true);
      try {
        await acct.requestPasswordReset(email, resetRedirectUrl());
        setInfo(RESET_SENT_MESSAGE);
        setSentTo(email.trim());
      } catch (e) {
        setError(userMessage(e, 'Could not send the reset link.'));
      } finally {
        setBusy(false);
      }
      return;
    }
    const problem = validateCredentials(email, password) ?? (mode === 'signup' && password !== confirm ? 'The two passwords don’t match.' : null) ??
      (mode === 'signup' && !adult ? AGE_REQUIRED_MESSAGE : null);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      if (mode === 'signup') {
        const r = await acct.signUp(email, password);
        if (r.status === 'confirm_email') {
          setInfo('Check your inbox to confirm your email, then sign in here.');
          setMode('signin');
          return;
        }
      } else {
        await acct.signIn(email, password);
      }
      acct.clearNotice();
      const prefs = await acct.refreshPrefs();
      if (needsOnboarding(true, prefs, isOnboardingSkipped(acct.account.currentUser()?.id))) router.replace('/onboarding' as never);
      else router.dismissTo('/');
    } catch (e) {
      setError(userMessage(e, 'Sign-in failed.'));
    } finally {
      // Never keep the password around (or on screen) after a submit.
      setPassword('');
      setConfirm('');
      setHideSignal((n) => n + 1);
      setBusy(false);
    }
  }

  const label = busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link';

  return (
    <ScreenShell
      tab="me"
      title={HEADERS[mode]}
      hideTitle
      onBack={mode === 'signin' ? undefined : () => switchMode('signin')}
      backLabel={mode === 'signup' ? 'Back to sign in' : 'Back'}
      onClose={() => router.dismissTo('/')}
    >
      <View style={[styles.panel, wide && [styles.panelWide, { backgroundColor: p.surface, borderColor: p.border }]]}>
        <View style={styles.head}>
          <Text style={[styles.title, { color: p.ink, fontSize: wide ? font.title : 28 }]} accessibilityRole="header">
            {TITLES[mode]}
          </Text>
          <Text style={[styles.sub, { color: p.inkSoft }]}>
            {mode === 'forgot'
              ? 'Enter the email you signed up with. We’ll send a link to choose a new password.'
              : mode === 'signup'
                ? 'It’s free. Pick your favorite topics and get a “For you” feed built from them and the cards you like.'
                : 'An account gives you a “For you” feed built from the topics you pick and the cards you like. Reading the feed never needs one.'}
          </Text>
        </View>
        {acct.notice && mode === 'signin' ? (
          <Text style={[styles.note, { backgroundColor: p.dataSoft, color: p.dataInk }]} accessibilityRole="alert">
            {acct.notice}
          </Text>
        ) : null}
        {acct.account.sample ? (
          <Text style={[styles.note, { backgroundColor: p.dataSoft, color: p.dataInk }]}>
            {mode === 'forgot'
              ? 'Sample mode: no email is sent. After you press the button, a test reset link appears here.'
              : 'Sample mode: any email and an 8+ character password work. Nothing leaves this device.'}
          </Text>
        ) : null}

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={[fieldStyles.label, { color: p.ink }]}>Email</Text>
            <TextInput
              style={[fieldStyles.input, { borderColor: p.borderStrong, backgroundColor: p.surface, color: p.ink }]}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              inputMode="email"
              keyboardType="email-address"
              placeholder="you@example.com"
              placeholderTextColor={p.muted}
              accessibilityLabel="Email"
              onSubmitEditing={mode === 'forgot' ? submit : undefined}
            />
          </View>
          {mode !== 'forgot' ? (
            <PasswordField
              label="Password"
              value={password}
              onChangeText={setPassword}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder={mode === 'signin' ? 'Your password' : 'At least 8 characters'}
              onSubmitEditing={mode === 'signin' ? submit : undefined}
              hideSignal={hideSignal}
            />
          ) : null}
          {mode === 'signup' ? (
            <PasswordField
              label="Confirm password"
              value={confirm}
              onChangeText={setConfirm}
              autoComplete="new-password"
              placeholder="Type it again"
              onSubmitEditing={submit}
              hideSignal={hideSignal}
            />
          ) : null}
          {mode === 'signup' ? (
            <Pressable
              onPress={() => setAdult((a) => !a)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: adult }}
              accessibilityLabel="I am 18 or older"
              style={styles.age}
            >
              <View style={[styles.box, { borderColor: adult ? p.accent : p.borderStrong, backgroundColor: adult ? p.accent : p.surface }]}>
                {adult ? <Text style={[styles.tick, { color: p.onAccent }]}>✓</Text> : null}
              </View>
              <Text style={[styles.ageText, { color: p.inkSoft }]}>I am 18 or older</Text>
            </Pressable>
          ) : null}
          {mode === 'signin' ? (
            <Pressable onPress={() => switchMode('forgot')} accessibilityRole="button" style={styles.forgot}>
              <Text style={[styles.linkText, { color: p.accent }]}>Forgot password?</Text>
            </Pressable>
          ) : null}
          {error ? (
            <Text style={[styles.message, { color: p.up }]} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {info ? (
            <Text style={[styles.message, { color: p.accentInk }]} accessibilityLiveRegion="polite">
              {info}
            </Text>
          ) : null}
          {acct.account.sample && sentTo && Platform.OS === 'web' ? (
            <Pressable
              onPress={() => window.location.assign(`/reset-password#access_token=${encodeURIComponent(`mock-recovery:${sentTo}`)}&type=recovery`)}
              accessibilityRole="link"
            >
              <Text style={[styles.linkText, { color: p.accentInk }]}>Open the test reset link</Text>
            </Pressable>
          ) : null}
          <PrimaryButton label={label} onPress={submit} />
          {!acct.user ? (
            <Pressable onPress={() => router.navigate('/account' as never)} accessibilityRole="link" style={styles.forgot}>
              <Text style={[styles.linkText, { color: p.accentInk }]}>Or keep using Element without an account: your topics and sources on this device →</Text>
            </Pressable>
          ) : null}
        </View>

        {mode === 'signin' ? (
          <>
            <View style={[styles.tintBox, { backgroundColor: p.accentSoft }]}>
              <Text style={[styles.tintText, { color: p.accentInk }]}>
                <Text style={styles.bold}>New to Element?</Text>
                {'\n'}Create a free account in a minute.
              </Text>
              <Pressable
                onPress={() => switchMode('signup')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.pill, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
              >
                <Text style={[styles.pillText, { color: p.onAccent }]}>Create account</Text>
              </Pressable>
            </View>
            <View style={styles.or}>
              <View style={[styles.rule, { backgroundColor: p.border }]} />
              <Text style={[styles.orText, { color: p.muted }]}>or</Text>
              <View style={[styles.rule, { backgroundColor: p.border }]} />
            </View>
            <OutlineButton label="Browse as a guest" onPress={() => router.dismissTo('/')} />
          </>
        ) : mode === 'signup' ? (
          <View style={styles.switchRow}>
            <Text style={[styles.sub, { color: p.inkSoft }]}>Already have an account?</Text>
            <Pressable onPress={() => switchMode('signin')} accessibilityRole="button" style={styles.switchBtn}>
              <Text style={[styles.linkText, { color: p.accent, fontSize: font.nav }]}>Sign in</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => switchMode('signin')} accessibilityRole="button" style={styles.switchBtn}>
            <Text style={[styles.linkText, { color: p.accent, fontSize: font.nav }]}>Back to sign in</Text>
          </Pressable>
        )}

        <Text style={[styles.fine, { color: p.muted }]}>
          Your password goes straight to our sign-in service (Supabase Auth), which stores only a one-way hash of it, never the password itself. We
          store your email, the topics you pick and what you like, view or open, only to tailor your feed. You can delete that data, or your whole
          account, on the Account screen.
        </Text>
        <Text style={[styles.fine, { color: p.muted }]}>{disclaimerText(config)}</Text>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 20, paddingHorizontal: 8, paddingTop: 4 },
  panelWide: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: 36,
    paddingTop: 36,
    paddingBottom: 30,
  },
  head: { gap: 8 },
  title: { fontFamily: fonts.serif, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 22 },
  note: { fontFamily: fonts.sansMedium, fontSize: font.meta, lineHeight: 18, padding: 12, borderRadius: radius.sm, overflow: 'hidden' },
  form: { gap: 14 },
  field: { gap: 6 },
  age: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { fontFamily: fonts.sansSemi, fontSize: 14, lineHeight: 16 },
  ageText: { fontFamily: fonts.sans, fontSize: font.chip },
  forgot: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  linkText: { fontFamily: fonts.sansSemi, fontSize: font.chip },
  message: { fontFamily: fonts.sansMedium, fontSize: font.chip, lineHeight: 20 },
  tintBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.sm + 4 },
  tintText: { flex: 1, fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 20 },
  bold: { fontFamily: fonts.sansSemi },
  pill: { minHeight: 44, paddingHorizontal: 16, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontFamily: fonts.sansSemi, fontSize: font.nav },
  or: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rule: { flex: 1, height: 1 },
  orText: { fontFamily: fonts.sans, fontSize: font.meta },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  switchBtn: { minHeight: 44, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  fine: { fontFamily: fonts.sans, fontSize: font.small, lineHeight: 18, textAlign: 'center' },
});
