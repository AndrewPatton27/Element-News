// Following page, stories section (Mobile-Following / Web-Following): one card per
// followed story with a badge, its category, the title, a timeline of updates (newest
// strong), "Open story ›" and a Following toggle. Updates come from api.relatedCards.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Api } from '../lib/api';
import type { BlurbCard, Category } from '../contract/types.ts';
import { categoryName } from '../lib/format';
import { clearStoryUpdatesCache, loadStoryUpdates, sortStories, storyBadge, updateMeta, type FollowedStory, type StoryRow } from '../lib/followedStories';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { PulseIcon } from './Icons';
import { CardActionRow } from './CardActionRow';

const updateListeners = new Set<() => void>();

export function clearStoryUpdates(): void {
  clearStoryUpdatesCache();
  updateListeners.forEach((listener) => listener());
}

export function useStoryRows(api: Api, stories: FollowedStory[]): { rows: StoryRow[]; loading: boolean } {
  const [updates, setUpdates] = useState<Record<string, BlurbCard[]>>({});
  const [loading, setLoading] = useState(true);
  const [cacheRevision, setCacheRevision] = useState(0);
  useEffect(() => {
    const listener = () => setCacheRevision((revision) => revision + 1);
    updateListeners.add(listener);
    return () => { updateListeners.delete(listener); };
  }, []);
  const ids = stories.map((s) => s.id).join(',');
  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all(
      stories.map(async (s) => {
        try {
          const list = await loadStoryUpdates(api, s);
          return [s.id, list] as const;
        } catch {
          return [s.id, []] as const;
        }
      }),
    ).then((pairs) => {
      if (!live) return;
      setUpdates(Object.fromEntries(pairs));
      setLoading(false);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ids, cacheRevision]);
  const rows = sortStories(stories.flatMap((s) => (s.card ? [{ story: s.card, updates: updates[s.id] ?? [] }] : [])));
  return { rows, loading };
}

export function FollowedStories({ rows, loading, categories, onOpen, onUnfollow }: {
  rows: StoryRow[]; loading: boolean; categories: Category[]; onOpen: (c: BlurbCard) => void; onUnfollow: (c: BlurbCard) => void;
}) {
  const p = usePalette();
  const wide = useWide();
  if (loading && !rows.length) return <Text style={{ color: p.muted, fontFamily: fonts.sans }} accessibilityLiveRegion="polite">Loading your stories…</Text>;
  return (
    <View style={[styles.grid, wide && styles.gridWide]}>
      {rows.map(({ story, updates }) => {
        const has = updates.length > 0;
        const latest = has ? updates[0] : story;
        const timeline = [
          ...updates.map((c, i) => ({ c, fresh: i === 0 })),
          { c: story, fresh: false },
        ];
        return (
          <View key={story.id} style={[styles.card, wide ? styles.cardWide : styles.cardNarrow, { backgroundColor: p.surface, borderColor: p.border }]}>
            <View style={styles.top}>
              <View style={styles.badgeRow}>
                <View style={[styles.dot, { backgroundColor: has ? p.accent : p.borderStrong }]} />
                <Text style={[styles.badge, wide && { fontSize: 13 }, { color: has ? p.accent : p.muted }]}>{storyBadge(updates)}</Text>
              </View>
              <Text style={[styles.cat, wide && { fontSize: 13 }, { color: p.muted }]}>{categoryName(story.category, categories)}</Text>
            </View>
            <Pressable onPress={() => onOpen(latest)} accessibilityRole="link" accessibilityLabel={`Open story: ${story.headline}`}>
              <Text style={[styles.title, wide && styles.titleWide, { color: p.ink }]}>{story.headline}</Text>
            </Pressable>
            <View accessibilityLabel="Updates" style={styles.list}>
              {timeline.map(({ c, fresh }, i) => (
                <Pressable
                  key={c.id}
                  onPress={() => onOpen(c)}
                  accessibilityRole="link"
                  accessibilityLabel={`Open article: ${c.headline}`}
                  style={({ pressed }) => [styles.li, wide && { minHeight: 48 }, pressed && { opacity: 0.7 }]}
                >
                  <View style={styles.rail}>
                    <View style={[styles.node, { backgroundColor: fresh ? p.accent : p.surface, borderColor: fresh ? p.accent : p.borderStrong }]} />
                    <View style={[styles.line, { backgroundColor: p.border, opacity: i === timeline.length - 1 ? 0 : 1 }]} />
                  </View>
                  <View style={styles.liText}>
                    <Text style={[styles.upText, wide && { fontSize: 16 }, { color: p.ink, fontFamily: fresh ? fonts.sansSemi : fonts.sansMedium }]}>{c.headline}</Text>
                    <Text style={[styles.upMeta, wide && { fontSize: 13 }, { color: p.muted }]}>{updateMeta(c)}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
            <View style={[styles.foot, { borderTopColor: p.divider }]}>
              <Pressable onPress={() => onOpen(latest)} accessibilityRole="button" accessibilityLabel={`Open story: ${story.headline}`} style={styles.open}>
                <Text style={[styles.openText, wide && { fontSize: 15 }, { color: p.accent }]}>Open story ›</Text>
              </Pressable>
              <Pressable onPress={() => onUnfollow(story)} accessibilityRole="button" accessibilityLabel="Stop following this story" aria-pressed={true} style={styles.toggle}>
                <PulseIcon color={p.accent} size={20} />
                <Text style={[styles.openText, wide && { fontSize: 15 }, { color: p.accent }]}>Following</Text>
              </Pressable>
            </View>
            <CardActionRow card={latest} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 14 },
  gridWide: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' },
  card: { borderWidth: 1, borderRadius: 20, gap: 10 },
  cardNarrow: { width: '100%', paddingVertical: 16, paddingHorizontal: 18 },
  cardWide: { flexBasis: 380, flexGrow: 1, flexShrink: 1, paddingVertical: 22, paddingHorizontal: 24, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: { fontFamily: fonts.sansSemi, fontSize: 12 },
  cat: { fontFamily: fonts.sans, fontSize: 12, flexShrink: 1, textAlign: 'right' },
  title: { fontFamily: fonts.serif, fontSize: 21, lineHeight: 25 },
  titleWide: { fontSize: 26, lineHeight: 30 },
  list: { marginTop: 2 },
  li: { flexDirection: 'row', gap: 12, minHeight: 44 },
  rail: { width: 12, alignItems: 'center' },
  node: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, marginTop: 5 },
  line: { flex: 1, width: 2, marginTop: 2 },
  liText: { flex: 1, gap: 1, paddingBottom: 10 },
  upText: { fontSize: 15, lineHeight: 20 },
  upMeta: { fontFamily: fonts.sans, fontSize: 12 },
  foot: { borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: -8, paddingTop: 4 },
  open: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  toggle: { minHeight: 44, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  openText: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
