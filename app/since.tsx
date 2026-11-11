// /since: "Since yesterday" (B-06, flag `since`). The cards published after the reader's last visit, macro news first
// (data prints and economy / government), then the rest, newest first. Reads api.feed (latest) page by page until the
// window is covered or MAX_PAGES is reached. The window comes from the device's last visit (lib/since/sinceLogic.ts).
// Hidden topics and sources, muted companies and the opt-in lanes apply exactly as in the feed.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BlurbCard } from '../contract/types.ts';
import { useAppData } from '../lib/shared/appData';
import { useAccount } from '../lib/account/accountContext';
import { withoutHidden } from '../lib/account/accountLogic';
import { withoutHiddenSources } from '../lib/sources/sourceKeys';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { fonts, font } from '../lib/theme/theme';
import { readFlags } from '../lib/flags/flags';
import { readSignals, withoutMuted } from '../lib/signals/signalsLogic';
import { laneVisible } from '../lib/topics/fineTopics';
import { cardsSince, sinceLabel, sinceStart, startVisit, readVisit } from '../lib/since/sinceLogic';
import { defaultStore } from '../lib/storage/storage';
import { ScreenShell } from '../components/shell/ScreenShell';
import { FollowingFeed } from '../components/following/FollowingFeed';
import { DetailSheet } from '../components/card/DetailSheet';
import { SourcesSheet } from '../components/card/SourcesSheet';

const store = defaultStore();
const MAX_PAGES = 4;

export default function SinceScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config, categories } = useAppData();
  const acct = useAccount();
  const on = readFlags().since;
  const [raw, setRaw] = useState<BlurbCard[]>([]);
  const [status, setStatus] = useState<{ loading: boolean; done: boolean; error: string | null }>({ loading: true, done: false, error: null });
  const [detail, setDetail] = useState<BlurbCard | null>(null);
  const [sources, setSources] = useState<BlurbCard | null>(null);
  // This screen reads the window the feed screen started; it never starts a session itself.
  const from = useMemo(() => sinceStart(readVisit(store) ?? startVisit(store)), []);

  useEffect(() => {
    if (!on) router.replace('/' as never);
  }, [on]);

  const load = useCallback(async () => {
    setStatus({ loading: true, done: false, error: null });
    try {
      let cursor: string | null = null;
      const all: BlurbCard[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await api.feed({ mode: 'latest', category: null, cursor, limit: 30 });
        all.push(...page.items);
        cursor = page.next_cursor;
        const oldest = page.items[page.items.length - 1];
        if (!cursor || !oldest || (Date.parse(oldest.published_at) || 0) <= from) break;
      }
      setRaw(all);
      setStatus({ loading: false, done: true, error: null });
    } catch {
      setStatus({ loading: false, done: false, error: 'Could not load the stories. Check your connection and try again.' });
    }
  }, [api, from]);
  useEffect(() => {
    if (on) void load();
  }, [on, load]);

  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const items = useMemo(() => {
    const signals = readSignals(store);
    let out = withoutHiddenSources(withoutHidden(raw, hidden), hiddenSources);
    if (readFlags().signals) out = withoutMuted(out, signals);
    if (readFlags().topics) out = out.filter((c) => laneVisible(c, 'latest', signals.optIn));
    return cardsSince(out, from);
  }, [raw, hidden, hiddenSources, from]);

  if (!on) return null;
  const macroCount = items.filter((c) => c.kind === 'data' || c.category === 'economy' || c.category === 'policy').length;

  return (
    <ScreenShell tab="feed" title="Since yesterday" meta={wide && items.length ? `${items.length} new` : undefined} notice onBack={() => router.navigate('/?tab=latest' as never)} backLabel="Back to the feed">
      <View style={styles.column} testID="since-screen">
        <Text style={[styles.intro, { color: p.inkBody }]} testID="since-summary">
          {status.loading
            ? 'Looking for what changed…'
            : items.length
              ? `${items.length} new in ${sinceLabel(from)}${macroCount ? `, ${macroCount} on the economy and government first` : ''}.`
              : `Nothing new in ${sinceLabel(from)}.`}
        </Text>
        <FollowingFeed
          items={items}
          state={status}
          config={config}
          categories={categories}
          reasonFor={() => null}
          onOpen={setDetail}
          onSources={setSources}
          onMore={() => undefined}
          onRetry={() => void load()}
          empty={
            <View style={styles.none}>
              <Text style={[styles.noneTitle, { color: p.ink }]}>You are caught up</Text>
              <Text style={[styles.noneText, { color: p.muted }]}>New stories will show up here as they are published.</Text>
              <Pressable onPress={() => router.navigate('/?tab=top' as never)} accessibilityRole="button" style={[styles.again, { borderColor: p.borderStrong, backgroundColor: p.surface }]}>
                <Text style={{ color: p.ink, fontFamily: fonts.sansSemi, fontSize: 15 }}>Back to the feed</Text>
              </Pressable>
            </View>
          }
        />
      </View>
      <SourcesSheet card={sources} config={config} onClose={() => setSources(null)} />
      <DetailSheet card={detail} config={config} categories={categories} onClose={() => setDetail(null)} />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  column: { gap: 14 },
  intro: { fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 22 },
  none: { minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  noneTitle: { fontFamily: fonts.serif, fontSize: 22 },
  noneText: { fontFamily: fonts.sans, fontSize: font.nav, textAlign: 'center' },
  again: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, justifyContent: 'center', marginTop: 6 },
});
