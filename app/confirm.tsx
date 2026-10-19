// The page the confirmation email links to: /confirm?token=<uuid>. It confirms the email brief
// sign-up (double opt-in) and says what happened. The token is the only thing sent; it is
// checked as a UUID first. Works signed out, no account needed.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAppData } from '../lib/shared/appData';
import { runMail, tokenParam, type MailOutcome } from '../lib/brief/briefLogic';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { fonts, font, radius } from '../lib/theme/theme';
import { OutlineButton, PrimaryButton } from '../components/account/FormParts';
import { ScreenShell } from '../components/shell/ScreenShell';
import { LoadingState } from '../components/shell/States';

type State = { phase: 'working' } | { phase: 'missing' } | { phase: 'result'; outcome: MailOutcome };

export default function ConfirmScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api } = useAppData();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = tokenParam(params.token);
  const [state, setState] = useState<State>({ phase: 'working' });

  useEffect(() => {
    if (!token) {
      setState({ phase: 'missing' });
      return;
    }
    let alive = true;
    setState({ phase: 'working' });
    runMail(() => api.confirmBrief(token)).then((outcome) => alive && setState({ phase: 'result', outcome }));
    return () => {
      alive = false;
    };
  }, [api, token]);

  let title = 'Confirming your email';
  let text = '';
  if (state.phase === 'missing') {
    title = 'This link is not complete';
    text = 'Open the confirmation link from your email again. If it still does not work, sign up again on the Brief page.';
  } else if (state.phase === 'result') {
    if (state.outcome === 'done') {
      title = 'You are subscribed';
      text = 'Thanks for confirming. Your brief will arrive at the time you chose. Every email has a one-click unsubscribe link.';
    } else if (state.outcome === 'unavailable') {
      title = 'We could not confirm right now';
      text = 'The service is not reachable at the moment. Nothing was changed. Try this link again in a little while.';
    } else {
      title = 'This link has expired or was already used';
      text = 'Sign up again on the Brief page and we will send a fresh confirmation email.';
    }
  }

  return (
    <ScreenShell tab="brief" title="Email brief">
      <View style={[styles.wrap, wide && styles.wrapWide]}>
        <View style={[styles.card, wide && styles.cardWide, wide && { backgroundColor: p.surface, borderColor: p.border }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: p.ink, fontSize: wide ? font.title : 28 }]}>
            {title}
          </Text>
          {state.phase === 'working' ? (
            <LoadingState label="Confirming…" />
          ) : (
            <Text accessibilityLiveRegion="polite" style={[styles.text, { color: p.inkSoft }]}>
              {text}
            </Text>
          )}
          {state.phase !== 'working' ? (
            <View style={styles.actions}>
              <PrimaryButton label="Open the brief" onPress={() => router.replace('/brief' as never)} />
              <OutlineButton label="Open the feed" onPress={() => router.replace('/' as never)} />
            </View>
          ) : null}
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
});
