// A list of result tiles with its loading, error and "show more" states. Used by
// Search and Following. `columns` 2 splits the tiles into two even columns on wide
// screens (design Web-Following); order reads left to right, top to bottom.
// Paging is a "Show more" button: it works with the keyboard and screen readers and
// needs no scroll handler.

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../contract/types.ts';
import type { FeedState } from '../lib/feedLogic';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { SearchResultCard } from './SearchResultCard';

export interface SearchResultsProps {
  items: BlurbCard[]; // already filtered for hidden topics and sources
  state: Pick<FeedState, 'loading' | 'done' | 'error'>;
  config: AppConfig | null;
  categories: Category[];
  columns?: 1 | 2;
  reasonFor?: (card: BlurbCard) => string | null;
  onOpen: (card: BlurbCard) => void;
  onShowSources: (card: BlurbCard) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  empty?: ReactNode; // shown when there are no items and nothing is loading
}

export function splitColumns<T>(items: T[], columns: 1 | 2): T[][] {
  if (columns === 1) return [items];
  return [items.filter((_, i) => i % 2 === 0), items.filter((_, i) => i % 2 === 1)];
}

export function SearchResults({ items, state, config, categories, columns = 1, reasonFor, onOpen, onShowSources, onLoadMore, onRetry, empty }: SearchResultsProps) {
  const p = usePalette();
  const first = items.length === 0;

  if (first && state.error) {
    return (
      <View accessibilityRole="alert" style={styles.note}>
        <Text style={[styles.noteTitle, { color: p.ink }]}>Could not load results</Text>
        <Text style={[styles.noteText, { color: p.muted }]}>{state.error}</Text>
        <Pressable onPress={onRetry} accessibilityRole="button" style={[styles.button, { backgroundColor: p.accent }]}>
          <Text style={[styles.buttonText, { color: p.onAccent }]}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (first && (state.loading || !state.done)) {
    return (
      <View style={styles.note} accessibilityLiveRegion="polite">
        <ActivityIndicator color={p.accent} />
        <Text style={[styles.noteText, { color: p.muted }]}>Loading…</Text>
      </View>
    );
  }
  if (first) return <>{empty ?? null}</>;

  return (
    <View style={styles.wrap}>
      <View style={[styles.columns, columns === 2 && styles.gapWide]} accessibilityRole="list">
        {splitColumns(items, columns).map((col, i) => (
          <View key={i} style={styles.column}>
            {col.map((c) => (
              <SearchResultCard
                key={c.id}
                card={c}
                config={config}
                categories={categories}
                reason={reasonFor ? reasonFor(c) : null}
                onOpen={onOpen}
                onShowSources={onShowSources}
              />
            ))}
          </View>
        ))}
      </View>
      {state.error ? (
        <Pressable onPress={onRetry} accessibilityRole="button" style={[styles.inlineError, { backgroundColor: p.dataSoft }]}>
          <Text style={{ color: p.dataInk, fontFamily: fonts.sansSemi }}>Could not load more. Tap to retry.</Text>
        </Pressable>
      ) : state.loading ? (
        <View style={styles.more} accessibilityLiveRegion="polite">
          <ActivityIndicator color={p.accent} />
        </View>
      ) : !state.done ? (
        <Pressable
          onPress={onLoadMore}
          accessibilityRole="button"
          style={({ pressed }) => [styles.moreButton, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.75 : 1 }]}
        >
          <Text style={[styles.moreText, { color: p.ink }]}>Show more</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  columns: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  gapWide: { gap: 16 },
  column: { flex: 1, minWidth: 0, gap: 14 },
  note: { alignItems: 'center', gap: 10, paddingVertical: 36, paddingHorizontal: 16 },
  noteTitle: { fontFamily: fonts.serif, fontSize: 22, textAlign: 'center' },
  noteText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 420 },
  button: { minHeight: 44, paddingHorizontal: 22, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  inlineError: { alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  moreButton: { alignSelf: 'center', minHeight: 44, paddingHorizontal: 22, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 15 },
});
