// Brief screen chrome: the Daily / Weekly tabs (designs Mobile-Brief, Web-Brief) and the
// "Generated 5 h ago · last 24 h" line with its Refresh button.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { BRIEF_MODES, type BriefMode } from '../lib/briefLogic';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';

// Underline tabs. Phones: 56 px high inside the header, 15 px text. Wide: 48 px row under the title, 16 px.
export function BriefTabs({ mode, onChange, wide }: { mode: BriefMode; onChange: (m: BriefMode) => void; wide?: boolean }) {
  const p = usePalette();
  return (
    <View style={[styles.tabs, wide && styles.tabsWide, wide && { borderBottomColor: p.border }]} accessibilityRole="tablist">
      {BRIEF_MODES.map((o) => {
        const on = o.mode === mode;
        return (
          <Pressable
            key={o.mode}
            onPress={() => onChange(o.mode)}
            accessibilityRole="tab"
            aria-selected={on}
            accessibilityState={{ selected: on }}
            style={[styles.tab, wide ? styles.tabWide : styles.tabNarrow, { borderBottomColor: on ? p.accent : 'transparent' }]}
          >
            <Text style={[styles.tabText, wide && styles.tabTextWide, { color: on ? p.ink : p.muted, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Local icon (the shared Icons file is not edited for this screen).
function RefreshIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <Path d="M20 4v5h-5" />
    </Svg>
  );
}

// Nothing to show: the brief is not ready (or the back end has no brief yet), or every item in it
// is hidden by the reader's own topic / source settings. Both give a way forward.
export function BriefEmpty({
  mode,
  hidden,
  onRefresh,
  onFeed,
  onSettings,
}: {
  mode: BriefMode;
  hidden: boolean;
  onRefresh: () => void;
  onFeed: () => void;
  onSettings?: () => void;
}) {
  const p = usePalette();
  const name = mode === 'weekly' ? 'weekly' : 'daily';
  return (
    <View style={[styles.empty, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityLabel={hidden ? 'Brief is hidden by your settings' : 'Brief not ready'}>
      <Text accessibilityRole="header" style={[styles.emptyTitle, { color: p.ink }]}>
        {hidden ? 'Everything here is hidden' : `Your ${name} brief is not ready yet`}
      </Text>
      <Text style={[styles.emptyText, { color: p.muted }]}>
        {hidden
          ? 'The topics and sources you switched off cover this whole brief. You can change that in your account.'
          : `The ${name} brief is put together from the top stories of the ${mode === 'weekly' ? 'week' : 'day'}. Check back soon, or read what is new in the feed.`}
      </Text>
      <View style={styles.emptyActions}>
        {hidden && onSettings ? (
          <Pressable onPress={onSettings} accessibilityRole="button" style={[styles.emptyBtn, { backgroundColor: p.accent }]}>
            <Text style={[styles.emptyBtnText, { color: p.onAccent }]}>Edit my topics</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onRefresh} accessibilityRole="button" style={[styles.emptyBtn, { backgroundColor: p.accent }]}>
            <Text style={[styles.emptyBtnText, { color: p.onAccent }]}>Try again</Text>
          </Pressable>
        )}
        <Pressable onPress={onFeed} accessibilityRole="link" style={[styles.emptyBtn, { borderWidth: 1, borderColor: p.borderStrong, backgroundColor: p.surface }]}>
          <Text style={[styles.emptyBtnText, { color: p.ink }]}>Open the feed</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function BriefMeta({ line, refreshing, onRefresh }: { line: string; refreshing: boolean; onRefresh: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.meta}>
      <Text style={[styles.metaText, { color: p.muted }]} accessibilityLiveRegion="polite">
        {refreshing ? 'Refreshing…' : line}
      </Text>
      <Pressable
        onPress={onRefresh}
        disabled={refreshing}
        accessibilityRole="button"
        accessibilityLabel={refreshing ? 'Refreshing the brief' : 'Refresh the brief'}
        accessibilityState={{ disabled: refreshing, busy: refreshing }}
        style={({ pressed }) => [styles.refresh, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: refreshing ? 0.5 : pressed ? 0.75 : 1 }]}
      >
        <RefreshIcon color={p.accent} />
        <Text style={[styles.refreshText, { color: p.accent }]}>Refresh</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 4 },
  tabsWide: { borderBottomWidth: 1 },
  tab: { justifyContent: 'center', paddingHorizontal: 10, borderBottomWidth: 3 },
  tabNarrow: { height: 56 },
  tabWide: { height: 48, paddingHorizontal: 16, marginBottom: -1 },
  tabText: { fontSize: 15 },
  tabTextWide: { fontSize: 16 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  metaText: { fontFamily: fonts.sans, fontSize: 13, flexShrink: 1 },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1 },
  refreshText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  empty: { borderRadius: 20, borderWidth: 1, padding: 22, gap: 10, alignItems: 'flex-start' },
  emptyTitle: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 28 },
  emptyText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, maxWidth: 520 },
  emptyActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 6 },
  emptyBtn: { minHeight: 44, paddingHorizontal: 18, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { fontFamily: fonts.sansSemi, fontSize: 15 },
});
