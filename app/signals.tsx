// /signals: "Saved and signals" (A-22, flag `signals`; D-121 lanes under flag `topics`). One page for what the reader told
// Element on this device: saved stories (tap to read, Remove), muted companies and topics (Unmute), how much detail a
// card shows (Normal or Short) and the opt-in lanes Crypto and Tech/AI. Topic mutes on whole categories live in
// Account, Your topics (the account store); this page holds the rest (lib/signals/signalsLogic.ts).

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BlurbCard } from '../contract/types.ts';
import { useAppData } from '../lib/shared/appData';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { fonts, font, radius } from '../lib/theme/theme';
import { readFlags } from '../lib/flags/flags';
import { useSignals } from '../lib/signals/useSignals';
import { toggleMutedTicker, toggleMutedTopic, toggleOptIn, toggleSaved, withDepth } from '../lib/signals/signalsLogic';
import { FINE_NAMES, LANE_TOPICS, type FineTopic } from '../lib/topics/fineTopics';
import { categoryName } from '../lib/shared/format';
import { SectionLabel } from '../components/account/FormParts';
import { ScreenShell } from '../components/shell/ScreenShell';
import { DetailSheet } from '../components/card/DetailSheet';

export default function SignalsScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config, categories } = useAppData();
  const { signals, update } = useSignals();
  const flags = readFlags();
  const [detail, setDetail] = useState<BlurbCard | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!flags.signals) router.replace('/' as never);
  }, [flags.signals]);
  if (!flags.signals) return null;
  const card = { borderWidth: 1, borderRadius: radius.tile, borderColor: p.border, backgroundColor: p.surface } as const;
  const row = (first: boolean) => [styles.row, !first && { borderTopWidth: 1, borderTopColor: p.divider }];

  async function open(id: string) {
    setMissing(null);
    const c = await api.card(id).catch(() => null);
    if (c) setDetail(c);
    else setMissing('That story is no longer available.');
  }

  return (
    <ScreenShell tab="me" title="Saved and signals" notice onBack={() => router.navigate('/account' as never)} backLabel="Back to Account">
      <View style={[styles.column, wide && styles.columnWide]} testID="signals-screen">
        <View style={styles.section}>
          <SectionLabel>Saved for later</SectionLabel>
          {signals.saved.length === 0 ? (
            <Text style={[styles.help, { color: p.muted }]}>Nothing saved yet. Use the ⋯ menu on a card, then Save for later.</Text>
          ) : (
            <View style={card}>
              {signals.saved.map((s, i) => (
                <View key={s.id} style={row(i === 0)}>
                  <Pressable onPress={() => void open(s.id)} accessibilityRole="button" style={styles.rowMain} testID="saved-row">
                    <Text style={[styles.rowTitle, { color: p.ink }]} numberOfLines={3}>{s.headline}</Text>
                    <Text style={[styles.rowMeta, { color: p.muted }]}>{categoryName(s.category, categories)}</Text>
                  </Pressable>
                  <Pressable onPress={() => update((x) => toggleSaved(x, { id: s.id, headline: s.headline, category: s.category as BlurbCard['category'] }))} accessibilityRole="button" accessibilityLabel={`Remove ${s.headline} from saved`} style={styles.action}>
                    <Text style={[styles.actionText, { color: p.accentInk }]}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          {missing ? <Text style={[styles.help, { color: p.up }]} accessibilityRole="alert">{missing}</Text> : null}
        </View>

        <View style={styles.section}>
          <SectionLabel>Muted</SectionLabel>
          {signals.mutedTickers.length + signals.mutedTopics.length === 0 ? (
            <Text style={[styles.help, { color: p.muted }]}>No muted companies or topics. Mute one from a card’s ⋯ menu.</Text>
          ) : (
            <View style={card}>
              {signals.mutedTickers.map((t, i) => (
                <View key={`t-${t}`} style={row(i === 0)}>
                  <Text style={[styles.rowTitle, styles.rowMain, { color: p.ink }]}>{t} (company)</Text>
                  <Pressable onPress={() => update((x) => toggleMutedTicker(x, t))} accessibilityRole="button" accessibilityLabel={`Unmute ${t}`} style={styles.action}>
                    <Text style={[styles.actionText, { color: p.accentInk }]}>Unmute</Text>
                  </Pressable>
                </View>
              ))}
              {signals.mutedTopics.map((t, i) => (
                <View key={`f-${t}`} style={row(i === 0 && signals.mutedTickers.length === 0)}>
                  <Text style={[styles.rowTitle, styles.rowMain, { color: p.ink }]}>{FINE_NAMES[t as FineTopic] ?? t} (topic)</Text>
                  <Pressable onPress={() => update((x) => toggleMutedTopic(x, t))} accessibilityRole="button" accessibilityLabel={`Unmute ${FINE_NAMES[t as FineTopic] ?? t}`} style={styles.action}>
                    <Text style={[styles.actionText, { color: p.accentInk }]}>Unmute</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <SectionLabel>Detail on cards</SectionLabel>
          <View style={styles.seg} accessibilityRole="radiogroup">
            {(['normal', 'short'] as const).map((d) => {
              const on = signals.depth === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => update((x) => withDepth(x, d))}
                  accessibilityRole="radio"
                  aria-checked={on}
                  style={[styles.segItem, { borderColor: on ? p.accent : p.borderStrong, backgroundColor: on ? p.accentSoft : p.surface }]}
                >
                  <Text style={[styles.segText, { color: on ? p.accentInk : p.inkSoft }]}>{on ? '✓ ' : ''}{d === 'normal' ? 'Normal' : 'Short'}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.help, { color: p.muted }]}>Short shows the headline and one key point. “More detail” still opens everything.</Text>
        </View>

        {flags.topics ? (
          <View style={styles.section}>
            <SectionLabel>More topics (optional)</SectionLabel>
            <Text style={[styles.help, { color: p.muted }]}>Off unless you switch them on. They show only reports from regulators and company filings, and appear in Trending only when they affect the wider economy.</Text>
            <View style={card}>
              {LANE_TOPICS.map((t, i) => {
                const on = signals.optIn.includes(t);
                return (
                  <Pressable
                    key={t}
                    onPress={() => update((x) => toggleOptIn(x, t))}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`${FINE_NAMES[t]}: ${on ? 'on' : 'off'}`}
                    style={[row(i === 0), { minHeight: 56 }]}
                  >
                    <Text style={[styles.rowTitle, styles.rowMain, { color: p.ink }]}>{FINE_NAMES[t]}</Text>
                    {/* The whole row is the switch (R-402): the 40x20 track alone was a too-small tap target. */}
                    <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants">
                      <Switch value={on} trackColor={{ false: p.borderStrong, true: p.accent }} />
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>
      <DetailSheet card={detail} config={config} categories={categories} onClose={() => setDetail(null)} />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  column: { gap: 24 },
  columnWide: { maxWidth: 640, width: '100%', alignSelf: 'flex-start' },
  section: { gap: 10 },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16, minHeight: 56 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: fonts.sansSemi, fontSize: font.body, lineHeight: 22 },
  rowMeta: { fontFamily: fonts.sans, fontSize: font.meta },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 },
  actionText: { fontFamily: fonts.sansSemi, fontSize: font.chip },
  seg: { flexDirection: 'row', gap: 8 },
  segItem: { flex: 1, minHeight: 48, borderRadius: radius.chip, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segText: { fontFamily: fonts.sansSemi, fontSize: font.body },
});
