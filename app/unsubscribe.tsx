// The page every brief email's "Unsubscribe" link opens: /unsubscribe?token=<uuid>. One tap on
// "Unsubscribe" ends the emails (no login); the page then confirms it. It does not unsubscribe
// by itself on load, so a mail scanner that opens links cannot cancel anyone by accident. Also
// offers "Change my time instead" and, after, a way to sign up again (a fresh confirmation).

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAppData } from '../lib/appData';
import { runMail, tokenParam, type MailOutcome } from '../lib/briefLogic';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, font, radius } from '../lib/theme';
import { OutlineButton, PrimaryButton } from '../components/FormParts';
import { ScreenShell } from '../components/ScreenShell';

export default function UnsubscribeScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api } = useAppData();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = tokenParam(params.token);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MailOutcome | null>(null);

  async function unsubscribe() {
    if (!token || busy) return;
    setBusy(true);
    setOutcome(await runMail(() => api.unsubscribeBrief(token)));
    setBusy(false);
  }

  const goManage = () => router.replace({ pathname: '/brief', params: { manage: token ?? '' } } as never);
  const goSignup = () => router.replace('/brief' as never);

  let title = 'Unsubscribe from the email brief';
  let text = 'Tap the button and we stop sending the brief to this address. No login, nothing else to do.';
  if (!token) {
    title = 'This link is not complete';
    text = 'Open the Unsubscribe link from the bottom of your latest brief email again.';
  } else if (outcome === 'done') {
    title = 'You are unsubscribed';
    text = 'You will not get any more emails from us. If that was a mistake, you can sign up again below. We will ask you to confirm your email first.';
  } else if (outcome === 'unavailable') {
    title = 'We could not do that right now';
    text = 'The service is not reachable at the moment, so nothing was changed. Please try again in a little while.';
  } else if (outcome === 'failed') {
    title = 'This link is no longer valid';
    text = 'Use the Unsubscribe link in your most recent brief email.';
  }

  return (
    <ScreenShell tab="brief" title="Email brief">
      <View style={[styles.wrap, wide && styles.wrapWide]}>
        <View style={[styles.card, wide && styles.cardWide, wide && { backgroundColor: p.surface, borderColor: p.border }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: p.ink, fontSize: wide ? font.title : 28 }]}>
            {title}
          </Text>
          <Text accessibilityLiveRegion="polite" style={[styles.text, { color: outcome === 'done' ? p.accentInk : p.inkSoft }]}>
            {text}
          </Text>
          <View style={styles.actions}>
            {token && outcome !== 'done' ? <PrimaryButton label={busy ? 'Unsubscribing…' : 'Unsubscribe'} onPress={unsubscribe} disabled={busy} /> : null}
            {token && outcome !== 'done' ? <OutlineButton label="Change my time instead" onPress={goManage} /> : null}
            {outcome === 'done' || !token ? <PrimaryButton label="Sign up again" onPress={goSignup} /> : null}
            <Pressable onPress={() => router.replace('/' as never)} accessibilityRole="link" style={styles.link}>
              <Text style={[styles.linkText, { color: p.accent }]}>Open the feed</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 20, paddingHorizontal: 8, paddingTop: 4 },
  wrapWide: { width: '100%', maxWidth: 520, alignSelf: 'flex-start' },
  card: { gap: 16 },
  cardWide: { borderWidth: 1, borderRadius: radius.card, padding: 28 },
  title: { fontFamily: fonts.serif, letterSpacing: -0.4 },
  text: { fontFamily: fonts.sans, fontSize: font.body, lineHeight: 24 },
  actions: { gap: 10 },
  link: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  linkText: { fontFamily: fonts.sansSemi, fontSize: font.nav },
});
