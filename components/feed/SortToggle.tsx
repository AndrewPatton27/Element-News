// Feed tabs (underline style): Trending / Latest / For you for everyone. Signed out, For you
// is ranked on the device (lib/localRank.ts). `forYou` is kept for callers but no longer hides the tab.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FeedTab } from '../../lib/feed/feedLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

const OPTIONS: { mode: FeedTab; label: string; hint: string }[] = [
  { mode: 'top', label: 'Trending', hint: 'What matters most right now' }, // display name only; the API mode stays 'top'
  { mode: 'latest', label: 'Latest', hint: 'Newest first' },
  { mode: 'for_you', label: 'For you', hint: 'Tailored to your topics and likes' },
];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SortToggle({ mode, onChange, wide, forYou: _forYou }: { mode: FeedTab | null; onChange: (m: FeedTab) => void; wide?: boolean; forYou?: boolean }) {
  const p = usePalette();
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {OPTIONS.map((o) => {
        const on = o.mode === mode;
        return (
          <Pressable
            key={o.mode}
            onPress={() => onChange(o.mode)}
            accessibilityRole="tab"
            aria-selected={on}
            accessibilityHint={o.hint}
            style={[styles.tab, wide && styles.tabWide, { borderBottomColor: on ? p.accent : 'transparent' }]}
          >
            <Text style={[styles.text, wide && styles.textWide, { color: on ? p.ink : p.muted, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  tab: { height: 44, paddingHorizontal: 14, justifyContent: 'center', borderBottomWidth: 3 },
  tabWide: { height: 64, paddingHorizontal: 14 }, // fills the 64 px top bar; the 3 px underline sits on its bottom edge
  text: { fontSize: 16 },
  textWide: { fontSize: 16 },
});
