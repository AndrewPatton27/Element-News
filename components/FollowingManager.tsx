// "What you follow" panel for the Following screen. Always shows the topics,
// companies and sources followed, each with a remove button. "Add" opens pickers
// for more topics and sources and a box for a company ticker. With nothing
// followed it starts open, as the prompt to pick topics.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Category } from '../contract/types.ts';
import { FOLLOWABLE_SOURCES, normalizeTicker, sourceLabel, topicLabel, type Follows } from '../lib/followingLogic';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, radius } from '../lib/theme';
import { CloseIcon } from './Icons';
import { TopicChip } from './TopicPicker';

export interface FollowingManagerProps {
  categories: Category[]; // topics that can be followed (hidden ones already left out)
  follows: Follows;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onToggleTopic: (slug: string) => void;
  onToggleSource: (name: string) => void;
  onToggleTicker: (symbol: string) => void;
  topicsLoading?: boolean;
  error?: string | null;
}

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={`Stop following ${label}`}
      style={({ pressed }) => [styles.removable, { backgroundColor: p.accentSoft, borderColor: p.accent, opacity: pressed ? 0.75 : 1 }]}
    >
      <Text style={{ color: p.accentInk, fontFamily: fonts.sansSemi, fontSize: 14 }}>{label}</Text>
      <CloseIcon color={p.accentInk} size={14} />
    </Pressable>
  );
}

export function FollowingManager({
  categories,
  follows,
  expanded,
  onExpandedChange,
  onToggleTopic,
  onToggleSource,
  onToggleTicker,
  topicsLoading,
  error,
}: FollowingManagerProps) {
  const p = usePalette();
  const wide = useWide();
  const [draft, setDraft] = useState('');
  const [badTicker, setBadTicker] = useState(false);
  const count = follows.topics.length + follows.sources.length + follows.tickers.length;

  const addTicker = () => {
    const t = normalizeTicker(draft);
    if (!t) {
      setBadTicker(draft.trim() !== '');
      return;
    }
    setBadTicker(false);
    if (!follows.tickers.includes(t)) onToggleTicker(t);
    setDraft('');
  };

  return (
    <View style={[styles.panel, wide ? styles.panelWide : styles.panelNarrow, { backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header">
          {count > 0 ? 'You follow' : 'Pick what to follow'}
        </Text>
        {count > 0 ? (
          <Pressable
            onPress={() => onExpandedChange(!expanded)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expanded ? 'Done adding' : 'Add topics, companies or sources'}
            style={styles.toggle}
          >
            <Text style={[styles.toggleText, { color: p.accent }]}>{expanded ? 'Done' : '+ Add'}</Text>
          </Pressable>
        ) : null}
      </View>

      {count > 0 ? (
        <View style={styles.chips} accessibilityRole="list">
          {follows.topics.map((s) => (
            <RemovableChip key={`t-${s}`} label={topicLabel(s, categories)} onRemove={() => onToggleTopic(s)} />
          ))}
          {follows.tickers.map((s) => (
            <RemovableChip key={`k-${s}`} label={s} onRemove={() => onToggleTicker(s)} />
          ))}
          {follows.sources.map((s) => (
            <RemovableChip key={`s-${s}`} label={sourceLabel(s)} onRemove={() => onToggleSource(s)} />
          ))}
        </View>
      ) : (
        <Text style={[styles.help, { color: p.inkSoft }]}>
          Choose topics, companies or sources. The newest stories about them show up here first.
        </Text>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={[styles.help, { color: p.warn }]}>
          {error}
        </Text>
      ) : null}

      {expanded ? (
        <View style={styles.pickers}>
          <Text style={[styles.label, { color: p.muted }]}>Topics</Text>
          {topicsLoading ? (
            <Text style={[styles.help, { color: p.muted }]}>Loading your topics…</Text>
          ) : (
            <View style={styles.chips} accessibilityRole="list">
              {categories.map((c) => (
                <TopicChip key={c.slug} label={c.name} on={follows.topics.includes(c.slug)} onPress={() => onToggleTopic(c.slug)} />
              ))}
            </View>
          )}

          <Text style={[styles.label, { color: p.muted }]}>Companies</Text>
          <View style={styles.tickerRow}>
            <TextInput
              value={draft}
              onChangeText={(t) => {
                setDraft(t);
                setBadTicker(false);
              }}
              onSubmitEditing={addTicker}
              placeholder="Ticker, like AAPL"
              placeholderTextColor={p.muted}
              accessibilityLabel="Company ticker to follow"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
              returnKeyType="done"
              style={[styles.input, { color: p.ink, borderColor: p.borderStrong, backgroundColor: p.surfaceMuted }, { outlineStyle: 'none' } as object]}
            />
            <Pressable
              onPress={addTicker}
              accessibilityRole="button"
              accessibilityLabel="Follow this company"
              style={({ pressed }) => [styles.add, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={{ color: p.onAccent, fontFamily: fonts.sansSemi, fontSize: 14 }}>Follow</Text>
            </Pressable>
          </View>
          {badTicker ? (
            <Text accessibilityRole="alert" style={[styles.help, { color: p.warn }]}>
              Enter a ticker of 1 to 5 letters, like AAPL.
            </Text>
          ) : null}

          <Text style={[styles.label, { color: p.muted }]}>Sources</Text>
          <View style={styles.chips} accessibilityRole="list">
            {FOLLOWABLE_SOURCES.map((s) => (
              <TopicChip key={s.name} label={s.label} on={follows.sources.includes(s.name)} onPress={() => onToggleSource(s.name)} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: radius.tile, gap: 12 },
  panelNarrow: { paddingVertical: 16, paddingHorizontal: 18 },
  panelWide: { paddingVertical: 22, paddingHorizontal: 24 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontFamily: fonts.serif, fontSize: 21, lineHeight: 25 },
  toggle: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  toggleText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  removable: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: radius.chip, borderWidth: 1 },
  help: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  pickers: { gap: 10, paddingTop: 4 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', paddingTop: 6 },
  tickerRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, fontFamily: fonts.sans, fontSize: 16 },
  add: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
