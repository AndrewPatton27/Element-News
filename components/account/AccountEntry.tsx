// Account entry points shared by Me (app/account.tsx) and About (app/about.tsx), so
// nothing is unreachable now that the web top bar has no Me button:
//   - AccountPrompt: guests get "Sign in" and "Create account" plus a one-line benefit;
//     signed-in readers get "Open your account" (hidden on the Me page itself).
//   - QuickLinks: Numbers to know, Replay the quick tour, and optionally Me / About.
//   - DeviceData: the "Your data on this device" note and "Clear data on this device"
//     with an in-page confirm. It clears local choices, recent searches and the quick-tour
//     flag only (lib/localPrefs.ts clearAll); nothing server side is touched.

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAccount } from '../../lib/account/accountContext';
import { clearAll } from '../../lib/storage/localPrefs';
import { defaultStore } from '../../lib/storage/storage';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { ListRow, OutlineButton, PrimaryButton } from './FormParts';
import { DeletedNotice } from './DeletedNotice';

export const BENEFIT_LINE = 'Sign in to sync your likes and follows across devices.';

const nav = (href: string) => () => router.navigate(href as never);

export function AccountPrompt({ showOpenAccount = true }: { showOpenAccount?: boolean }) {
  const p = usePalette();
  const { user } = useAccount();
  const box = [styles.card, { backgroundColor: p.surface, borderColor: p.border }];
  if (user) {
    return showOpenAccount ? (
      <View style={box}>
        <Text style={[styles.title, { color: p.ink }]} numberOfLines={1}>
          Signed in as {user.email}
        </Text>
        <PrimaryButton label="Open your account" onPress={nav('/account')} />
      </View>
    ) : null;
  }
  return (
    <View style={box}>
      <Text style={[styles.title, { color: p.ink }]}>You’re not signed in</Text>
      <Text style={[styles.help, { color: p.inkSoft }]}>
        {BENEFIT_LINE} Reading never needs an account.
      </Text>
      <PrimaryButton label="Sign in" onPress={nav('/signin')} />
      <OutlineButton label="Create account" onPress={nav('/signin?mode=signup')} />
    </View>
  );
}

export function QuickLinks({ account = false, about = false }: { account?: boolean; about?: boolean }) {
  const p = usePalette();
  const wide = useWide();
  const rows: { label: string; href: string }[] = [];
  if (account) rows.push({ label: 'Me and settings', href: '/account' });
  rows.push({ label: 'Numbers to know', href: '/numbers' });
  if (about) rows.push({ label: 'About Element', href: '/about' });
  rows.push({ label: 'Replay the quick tour', href: '/tutorial' });
  return (
    <View style={[styles.card, styles.list, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityLabel="Links">
      {rows.map((r, i) => (
        <ListRow key={r.href} first={i === 0} wide={wide} chevron label={r.label} onPress={nav(r.href)} />
      ))}
    </View>
  );
}

export function DeviceData() {
  const p = usePalette();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <View style={styles.data} accessibilityLabel="Your data on this device">
      <Text style={[styles.title, { color: p.ink }]}>Your data on this device</Text>
      <Text style={[styles.help, { color: p.inkSoft }]}>
        Likes, favorite and hidden topics, followed companies, recent searches and the quick-tour flag are saved in this browser or app only.
        Clearing them does not touch an account.
      </Text>
      {confirming ? (
        <>
          <Text style={[styles.help, { color: p.ink }]}>Clear everything saved on this device? This can’t be undone.</Text>
          <PrimaryButton
            danger
            label="Yes, clear this device"
            onPress={() => {
              clearAll(defaultStore()); // listeners in the account context refresh the screens
              setConfirming(false);
              setDone(true); // the notice opens only now, after the clear
            }}
          />
          <OutlineButton label="Cancel" onPress={() => setConfirming(false)} />
        </>
      ) : (
        <OutlineButton
          label="Clear data on this device"
          color={p.warn}
          border={p.warn}
          onPress={() => {
            setDone(false);
            setConfirming(true);
          }}
        />
      )}
      {done ? (
        <Text style={[styles.help, { color: p.accentInk }]} accessibilityLiveRegion="polite">
          Cleared. This device has forgotten your choices.
        </Text>
      ) : null}
      <DeletedNotice kind={done ? 'device' : null} onClose={() => setDone(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.tile, gap: 10, paddingVertical: 16, paddingHorizontal: 18 },
  list: { gap: 0, paddingVertical: 0, paddingHorizontal: 0, overflow: 'hidden' },
  data: { gap: 10 },
  title: { fontFamily: fonts.sansSemi, fontSize: font.body },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
});
