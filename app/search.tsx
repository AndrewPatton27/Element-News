// Search (designs Mobile-Search / Web-Search). The box waits 300 ms after the last
// key, searches from 2 characters, and shows api.search results page by page.
// Empty box: recent searches (kept on this device), topics to browse and companies
// to try. A topic tile shows that topic's top cards; a company search offers
// "Follow". Hidden topics and sources stay out of the results, as in the feed.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BlurbCard, CategorySlug } from '../contract/types.ts';
import { useAppData } from '../lib/appData';
import { useAccount } from '../lib/accountContext';
import { withoutHidden } from '../lib/accountLogic';
import { withoutHiddenSources } from '../lib/sourceKeys';
import { normalizeTicker } from '../lib/followingLogic';
import {
  RECENT_KEY,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  addRecent,
  emptyResultsMessage,
  normalizeQuery,
  parseRecents,
  resultCountText,
  searchKey,
  searchTarget,
  serializeRecents,
  suggestedTopics,
} from '../lib/searchLogic';
import { defaultStore } from '../lib/storage';
import { useFollows } from '../lib/useFollows';
import { usePagedCards } from '../lib/usePagedCards';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, font, space } from '../lib/theme';
import { DetailSheet } from '../components/DetailSheet';
import { FollowingButton } from '../components/FollowingButton';
import { Disclaimer } from '../components/Labels';
import { ScreenShell } from '../components/ScreenShell';
import { SearchBox } from '../components/SearchBox';
import { SearchIdle } from '../components/SearchIdle';
import { SearchResults } from '../components/SearchResults';
import { Shell } from '../components/Shell';
import { SourcesSheet } from '../components/SourcesSheet';
import { disclaimerText } from '../lib/labels';

const store = defaultStore();

export default function SearchScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config, categories } = useAppData();
  const acct = useAccount();
  const signedIn = acct.user !== null;
  const { follows, toggleTopic, toggleTicker, error: followError } = useFollows();

  const [text, setText] = useState('');
  const [typed, setTyped] = useState(''); // the text after the 300 ms wait
  const [topic, setTopic] = useState<{ slug: string; name: string } | null>(null);
  const [recent, setRecent] = useState<string[]>(() => parseRecents(store.get(RECENT_KEY)));
  const [sheetCard, setSheetCard] = useState<BlurbCard | null>(null);
  const [detailCard, setDetailCard] = useState<BlurbCard | null>(null);

  // Debounce: wait for a pause in typing. Clearing the box takes effect at once.
  useEffect(() => {
    if (normalizeQuery(text) === '') {
      setTyped('');
      return;
    }
    const t = setTimeout(() => setTyped(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  const target = searchTarget(typed, topic);
  const key = searchKey(target);

  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const visible = useCallback(
    (cards: BlurbCard[]) => withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources),
    [hidden, hiddenSources],
  );

  // The key decides when to start over; the function always reads the current target.
  const { state, loadMore, retry } = usePagedCards(
    key,
    (cursor, limit) =>
      target.kind === 'category'
        ? api.feed({ mode: 'top', category: target.slug as CategorySlug, cursor, limit })
        : target.kind === 'query'
          ? api.search(target.q, cursor, limit)
          : Promise.resolve({ items: [], next_cursor: null }),
    visible,
  );
  const items = visible(state.items);

  const remember = useCallback((q: string) => {
    setRecent((list) => {
      const next = addRecent(list, q);
      store.set(RECENT_KEY, serializeRecents(next));
      return next;
    });
  }, []);

  const submit = useCallback(() => {
    if (normalizeQuery(text).length >= SEARCH_MIN_CHARS) {
      setTyped(text); // no need to wait any longer
      setTopic(null);
      remember(text);
    }
  }, [text, remember]);

  const pickText = useCallback((q: string) => {
    setTopic(null);
    setText(q);
    setTyped(q);
  }, []);

  const clearAll = useCallback(() => {
    setText('');
    setTyped('');
    setTopic(null);
  }, []);

  const openDetail = useCallback(
    (c: BlurbCard) => {
      setDetailCard(c);
      if (target.kind === 'query') remember(target.q);
    },
    [target, remember],
  );
  const { trackOpenDetail } = acct;
  useEffect(() => {
    if (detailCard && signedIn) trackOpenDetail(detailCard);
  }, [detailCard, signedIn, trackOpenDetail]);

  const topics = useMemo(() => suggestedTopics(categories, hidden), [categories, hidden]);

  // "Follow" appears for a topic being browsed, and for a company the results are about.
  const ticker = target.kind === 'query' ? normalizeTicker(target.q) : null;
  const tickerMatches = ticker !== null && items.some((c) => c.tickers.some((t) => t.symbol.toUpperCase() === ticker));
  let followButton = null;
  if (target.kind === 'category') {
    followButton = (
      <FollowingButton name={target.name} following={follows.topics.includes(target.slug)} onPress={() => toggleTopic(target.slug)} />
    );
  } else if (ticker && tickerMatches) {
    followButton = <FollowingButton name={ticker} following={follows.tickers.includes(ticker)} onPress={() => toggleTicker(ticker)} />;
  }

  let body;
  if (target.kind === 'idle') {
    body = (
      <>
        <SearchIdle
          recent={recent}
          topics={topics}
          onPickRecent={pickText}
          onClearRecent={() => {
            store.set(RECENT_KEY, serializeRecents([]));
            setRecent([]);
          }}
          onPickTopic={(c) => {
            setText('');
            setTyped('');
            setTopic({ slug: c.slug, name: c.name });
          }}
          onPickTicker={pickText}
        />
        <Disclaimer text={disclaimerText(config)} center={!wide} />
      </>
    );
  } else if (target.kind === 'short') {
    body = (
      <Text style={[styles.hint, { color: p.muted }]} accessibilityLiveRegion="polite">
        Type at least {SEARCH_MIN_CHARS} characters to search.
      </Text>
    );
  } else {
    const noResults = (
      <View style={styles.none} accessibilityLiveRegion="polite">
        <Text style={[styles.noneTitle, { color: p.ink }]}>No results</Text>
        <Text style={[styles.noneText, { color: p.muted }]}>{emptyResultsMessage(target)}</Text>
        <Pressable onPress={clearAll} accessibilityRole="button" style={[styles.again, { borderColor: p.borderStrong, backgroundColor: p.surface }]}>
          <Text style={{ color: p.ink, fontFamily: fonts.sansSemi, fontSize: 15 }}>Back to suggestions</Text>
        </Pressable>
      </View>
    );
    body = (
      <>
        <View style={styles.headRow}>
          <View style={styles.headText}>
            {target.kind === 'category' ? (
              <Text style={[styles.topicTitle, { color: p.ink }]} accessibilityRole="header">
                {target.name}
              </Text>
            ) : null}
            {items.length > 0 ? (
              <Text style={[styles.count, { color: p.muted }]} accessibilityLiveRegion="polite">
                {target.kind === 'category' ? 'Top stories' : resultCountText(items.length, state.done)}
              </Text>
            ) : null}
          </View>
          {followButton}
        </View>
        {followError ? (
          <Text style={[styles.hint, { color: p.warn }]} accessibilityRole="alert">
            {followError}
          </Text>
        ) : null}
        <SearchResults
          items={items}
          state={state}
          config={config}
          categories={categories}
          onOpen={openDetail}
          onShowSources={setSheetCard}
          onLoadMore={loadMore}
          onRetry={retry}
          empty={noResults}
        />
      </>
    );
  }

  const box = (
    <SearchBox
      value={text}
      onChangeText={(t) => {
        setText(t);
        if (topic) setTopic(null);
      }}
      onSubmit={submit}
      onClear={clearAll}
      wide={wide}
    />
  );
  const sheets = (
    <>
      <SourcesSheet card={sheetCard} config={config} onClose={() => setSheetCard(null)} />
      <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
    </>
  );

  if (wide) {
    return (
      <ScreenShell tab="search" title="Search">
        {box}
        {body}
        {sheets}
      </ScreenShell>
    );
  }
  // Phones (Mobile-Search): the header is the search box itself, then the body scrolls.
  return (
    <Shell active="search" bare>
      <View style={[styles.header, { backgroundColor: p.surface, borderBottomColor: p.border }]}>{box}</View>
      <ScrollView style={styles.fill} contentContainerStyle={styles.bodyNarrow} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
      {sheets}
    </Shell>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { paddingHorizontal: space.page, paddingVertical: 10, borderBottomWidth: 1 },
  bodyNarrow: { paddingHorizontal: space.page, paddingTop: 18, paddingBottom: space.md, gap: 14 },
  hint: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 20, paddingHorizontal: 4 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  headText: { flexShrink: 1, gap: 2 },
  topicTitle: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 30 },
  count: { fontFamily: fonts.sans, fontSize: font.meta },
  none: { alignItems: 'center', gap: 10, paddingVertical: 36, paddingHorizontal: 16 },
  noneTitle: { fontFamily: fonts.serif, fontSize: 22, textAlign: 'center' },
  noneText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 420 },
  again: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
