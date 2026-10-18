// "Pick topics you care about": shown once after the first sign-in. Saved with
// api.set_prefs; "Skip" remembers the choice on this device.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAccount } from '../lib/accountContext';
import { useAppData } from '../lib/appData';
import { usePalette, useWide } from '../lib/useTheme';
import { userMessage } from '../lib/errors';
import { fonts, font } from '../lib/theme';
import { PrimaryButton, SectionLabel } from '../components/FormParts';
import { ScreenShell } from '../components/ScreenShell';
import { TopicPicker } from '../components/TopicPicker';

export default function OnboardingScreen() {
  const p = usePalette();
  const wide = useWide();
  const { categories } = useAppData();
  const acct = useAccount();
  const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!acct.user) router.replace('/signin' as never);
  }, [acct.user]);
  useEffect(() => {
    if (acct.prefs && acct.prefs.followed.length > 0) setSelected(acct.prefs.followed);
  }, [acct.prefs]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await acct.savePrefs(
        selected,
        hidden.filter((h) => !selected.includes(h)),
      );
      router.dismissTo('/?tab=for_you' as never);
    } catch (e) {
      setError(userMessage(e, 'Could not save your topics.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenShell tab="me" title="Your topics">
      <View style={[styles.column, wide && styles.columnWide]}>
        <Text style={[styles.heading, { color: p.ink, fontSize: wide ? font.title : 28 }]} accessibilityRole="header">
          Pick your favorite topics
        </Text>
        <Text style={[styles.sub, { color: p.inkSoft }]}>
          Your “For you” feed puts your favorites first. Likes and “less like this” fine-tune it over time. You can change your favorites any time
          in Account.
        </Text>
        <TopicPicker categories={categories} selected={selected} onChange={setSelected} />
        <SectionLabel>Topics to hide (optional)</SectionLabel>
        <Text style={[styles.sub, { color: p.inkSoft }]}>You won’t see these at all.</Text>
        <TopicPicker
          categories={categories.filter((c) => !selected.includes(c.slug))}
          selected={hidden.filter((h) => !selected.includes(h))}
          onChange={setHidden}
        />
        {error ? (
          <Text style={[styles.error, { color: p.up }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <PrimaryButton
            label={busy ? 'Saving…' : selected.length ? `Save ${selected.length} topic${selected.length === 1 ? '' : 's'}` : 'Save'}
            onPress={busy ? () => undefined : save}
          />
          <Pressable
            onPress={() => {
              acct.skipOnboarding();
              router.dismissTo('/');
            }}
            accessibilityRole="button"
            style={styles.skip}
          >
            <Text style={[styles.skipText, { color: p.inkSoft }]}>Skip for now</Text>
          </Pressable>
        </View>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  column: { gap: 14 },
  columnWide: { maxWidth: 640, width: '100%', alignSelf: 'flex-start' },
  heading: { fontFamily: fonts.serif, letterSpacing: -0.4 },
  sub: { fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 22 },
  error: { fontFamily: fonts.sansMedium, fontSize: font.chip },
  actions: { gap: 6, alignItems: 'stretch' },
  skip: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  skipText: { fontFamily: fonts.sansSemi, fontSize: font.nav },
});
