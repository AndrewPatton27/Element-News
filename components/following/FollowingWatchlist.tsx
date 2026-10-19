// "Watchlist" on the Me screen (designs Mobile-Me / Web-Me): the company tickers the
// reader follows, as removable chips, and "+ Add ticker". Tickers are kept on this
// device (lib/useFollows.ts). News only: the copy says Element shows no prices.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { normalizeTicker } from '../../lib/following/followingLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { CloseIcon } from '../shell/Icons';
import { SectionLabel } from '../account/FormParts';

export function FollowingWatchlist({ tickers, onToggle }: { tickers: string[]; onToggle: (symbol: string) => void }) {
  const p = usePalette();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [bad, setBad] = useState(false);

  const add = () => {
    const t = normalizeTicker(draft);
    if (!t) {
      setBad(draft.trim() !== '');
      return;
    }
    if (!tickers.includes(t)) onToggle(t);
    setDraft('');
    setBad(false);
    setAdding(false);
  };

  return (
    <View style={styles.section}>
      <SectionLabel>Watchlist</SectionLabel>
      <Text style={[styles.help, { color: p.inkSoft }]}>Follow company tickers to see their latest cards. Element shows news, not prices.</Text>
      <View style={styles.chips} accessibilityRole="list">
        {tickers.map((t) => (
          <Pressable
            key={t}
            onPress={() => onToggle(t)}
            accessibilityRole="button"
            accessibilityLabel={`Stop following ${t}`}
            style={({ pressed }) => [styles.chip, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.75 : 1 }]}
          >
            <Text style={{ color: p.ink, fontFamily: fonts.sansSemi, fontSize: 14 }}>{t}</Text>
            <CloseIcon color={p.muted} size={14} />
          </Pressable>
        ))}
        {!adding ? (
          <Pressable
            onPress={() => setAdding(true)}
            accessibilityRole="button"
            style={[styles.chip, { borderColor: p.borderStrong, borderStyle: 'dashed' }]}
          >
            <Text style={{ color: p.inkSoft, fontFamily: fonts.sans, fontSize: 14 }}>+ Add ticker</Text>
          </Pressable>
        ) : null}
      </View>
      {adding ? (
        <View style={styles.addRow}>
          <TextInput
            value={draft}
            onChangeText={(t) => {
              setDraft(t);
              setBad(false);
            }}
            onSubmitEditing={add}
            autoFocus
            placeholder="Ticker, like AAPL"
            placeholderTextColor={p.muted}
            accessibilityLabel="Company ticker to follow"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={8}
            returnKeyType="done"
            style={[styles.input, { color: p.ink, borderColor: p.borderStrong, backgroundColor: p.surface }, { outlineStyle: 'none' } as object]}
          />
          <Pressable onPress={add} accessibilityRole="button" accessibilityLabel="Follow this company" style={[styles.add, { backgroundColor: p.accent }]}>
            <Text style={{ color: p.onAccent, fontFamily: fonts.sansSemi, fontSize: 14 }}>Add</Text>
          </Pressable>
        </View>
      ) : null}
      {bad ? (
        <Text accessibilityRole="alert" style={[styles.help, { color: p.warn }]}>
          Enter a ticker of 1 to 5 letters, like AAPL.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 14, borderRadius: radius.chip, borderWidth: 1 },
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, height: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, fontFamily: fonts.sans, fontSize: 16 },
  add: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
