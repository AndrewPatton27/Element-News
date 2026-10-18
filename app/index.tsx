// Feed screen. Phones: wordmark, Trending / Latest (/ For you) tabs, category chips,
// the swipe pager, bottom nav. Wide web (docs/design/web/Web-Final.dc.html): top bar
// with the tabs, Numbers strip, categories on the left, the wide card in the middle,
// top stories and trends on the right (Shell lays out the frame). Guests see a gentle
// sign-in prompt; the feed never needs an account.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { DwellTimer } from '../lib/dwell';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { BlurbCard, CategorySlug } from '../contract/types.ts';
import { useAppData } from '../lib/appData';
import { useAccount } from '../lib/accountContext';
import { useFollows } from '../lib/useFollows';
import { forYouCoversTopics, withoutHidden } from '../lib/accountLogic';
import { favoritesFirst } from '../lib/localPrefs';
import { rankLocal } from '../lib/localRank';
import { confidence, targetAhead } from '../lib/queueLogic';
import { sourceName, withoutHiddenSources } from '../lib/sourceKeys';
import { SIGN_IN_AGAIN_MESSAGE } from '../lib/session';
import type { FeedTab } from '../lib/feedLogic';
import { topicParam } from '../lib/briefLogic';
import { categoryName } from '../lib/format';
import { defaultStore } from '../lib/storage';
import { FOR_YOU_SEEN_MS, forYouProgress, readSeen, recordSeen } from '../lib/forYouGate';
import { ForYouWarmup } from '../components/ForYouWarmup';
import { useFeed } from '../lib/useFeed';
import { usePalette, useWide } from '../lib/useTheme';
import { MOBILE_HEADER_HEIGHT, fonts } from '../lib/theme';
import { CategoryChips, CategoryList } from '../components/CategoryChips';
import { FeedPager } from '../components/FeedPager';
import { CloseIcon } from '../components/Icons';
import { NumbersTicker } from '../components/NumbersTicker';
import { Shell, Wordmark } from '../components/Shell';
import { WideAside, useAsideData } from '../components/WideAside';
import { SortToggle } from '../components/SortToggle';
import { SourcesSheet } from '../components/SourcesSheet';
import { DetailSheet } from '../components/DetailSheet';
import { CardMenu } from '../components/CardMenu';
import { UndoToast } from '../components/UndoToast';
import { EmptyState, ErrorState, LoadingState } from '../components/States';

// Below this window width the right column is dropped.
const ASIDE_MIN_WIDTH = 1180;
const PROMPT_KEY = 'element.signin-prompt-dismissed';
const store = defaultStore();

export default function FeedScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config, categories } = useAppData();
  const acct = useAccount();
  const followsState = useFollows();
  const signedIn = acct.user !== null;
  const params = useLocalSearchParams<{ tab?: string; t?: string; category?: string }>();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<FeedTab>(params.tab === 'for_you' ? 'for_you' : 'top');
  const [category, setCategory] = useState<CategorySlug | null>(null);
  const [sheetCard, setSheetCard] = useState<BlurbCard | null>(null);
  const [detailCard, setDetailCard] = useState<BlurbCard | null>(null);
  const [menuCard, setMenuCard] = useState<BlurbCard | null>(null);
  const [undo, setUndo] = useState<
    | { message: string; kind: 'topic'; previous: { followed: string[]; hidden: string[] } }
    | { message: string; kind: 'source'; previous: string[] }
    | { message: string; kind: 'follow'; slug: string }
    | null
  >(null);
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({});
  // The feed stays mounted under Numbers / About / Account; only drive it (keys,
  // view tracking) while it's the screen on top (B2).
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [promptHidden, setPromptHidden] = useState(() => store.get(PROMPT_KEY) === '1');

  // Arriving from onboarding (or another screen's top bar) opens For you; it works signed out
  // too (ranked on this device).
  // Other screens' top bar sends ?tab=top|latest|for_you (t makes a repeat tap count).
  useEffect(() => {
    if (params.tab === 'for_you' || params.tab === 'top' || params.tab === 'latest') setMode(params.tab);
  }, [params.tab, params.t]);

  // The Brief's "See all N" opens the feed on one topic: /?tab=top&category=<slug>.
  useEffect(() => {
    const topic = topicParam(params.category);
    if (topic) setCategory(topic as CategorySlug);
  }, [params.category, params.t]);

  const forYou = mode === 'for_you';
  // Hidden topics and sources leave the feed and the chips at once: the account's when signed
  // in (the server filters too), this device's when signed out.
  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const sourcesSupported = acct.viewPrefs?.hiddenSources != null;
  // The same filter drives the list on screen and the paging, so "end of feed" and "load
  // more" are decided on what the reader can actually see.
  const visible = useCallback(
    (cards: BlurbCard[]) => withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources),
    [hidden, hiddenSources],
  );
  const local = acct.localPrefs;
  // For you stays locked until 10 stories across 4 topics have been read or reacted to.
  const [seenList, setSeenList] = useState(() => readSeen(store));
  const gate = forYouProgress({
    reacted: Object.entries(local.reactions).map(([id, v]) => ({ id, category: v.topic })),
    seen: seenList,
  });
  const locked = forYou && !gate.ready;
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSeenCandidate = useCallback((c: BlurbCard) => {
    if (seenTimer.current) clearTimeout(seenTimer.current);
    seenTimer.current = setTimeout(() => setSeenList(recordSeen(store, c)), FOR_YOU_SEEN_MS);
  }, []);
  useEffect(() => () => { if (seenTimer.current) clearTimeout(seenTimer.current); }, []);
  const rankPage = useCallback((cards: BlurbCard[]) => rankLocal(cards, local), [local]);
  const { state, loadMore, retry, rerank } = useFeed(
    api,
    { mode: locked ? 'top' : mode, category: forYou ? null : category, user: acct.user?.id ?? null },
    acct.account,
    visible,
    signedIn ? undefined : rankPage,
    targetAhead(confidence({ reactions: Object.keys(local.reactions).length, topics: local.follows.topics.length + (acct.viewPrefs?.followed.length ?? 0), sources: local.follows.sources.length, tickers: local.follows.tickers.length, favorites: (acct.viewPrefs?.followed.length ?? 0), accountSignals: signedIn ? Object.keys(acct.reactions).length : 0 })),
  );
  const queuePosition = useRef(0);
  useEffect(() => { rerank(local, queuePosition.current, signedIn); }, [local, signedIn, rerank]);
  const showSources = useCallback((c: BlurbCard) => setSheetCard(c), []);
  const openDetail = useCallback((c: BlurbCard) => setDetailCard(c), []);

  const items = visible(state.items);
  const followed = acct.viewPrefs?.followed ?? [];
  const followedTopics = (signedIn ? followed : followsState.follows.topics).filter((slug) => followOverrides[slug] ?? true);
  for (const [slug, isFollowed] of Object.entries(followOverrides)) {
    if (isFollowed && !followedTopics.includes(slug)) followedTopics.push(slug);
  }
  useEffect(() => {
    const source = signedIn ? followed : followsState.follows.topics;
    setFollowOverrides((current) => {
      const next = { ...current };
      for (const [slug, value] of Object.entries(current)) {
        if (source.includes(slug) === value) delete next[slug];
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [signedIn, followed, followsState.follows.topics]);
  const chipCategories = favoritesFirst(withoutHidden(categories, hidden), followed);
  useEffect(() => {
    if (category && hidden.includes(category)) setCategory(null);
  }, [category, hidden]);

  const hideTopic = useCallback(
    (c: BlurbCard) => {
      setMenuCard(null);
      const topic = categoryName(c.category, categories);
      acct
        .hideTopic(c.category)
        .then((previous) => setUndo({ message: `${topic} topics hidden.`, kind: 'topic', previous }))
        .catch(() => setUndo(null));
    },
    [acct, categories],
  );
  const toggleCardFollow = useCallback((card: BlurbCard) => {
    const isFollowed = followedTopics.includes(card.category);
    setFollowOverrides((current) => ({ ...current, [card.category]: !isFollowed }));
    followsState.toggleTopic(card.category);
    const topic = categoryName(card.category, categories);
    setUndo({ message: `${isFollowed ? 'Unfollowed' : 'Following'} ${topic}`, kind: 'follow', slug: card.category });
  }, [followedTopics, followsState, categories]);
  const hideSource = useCallback(
    (_c: BlurbCard, key: string) => {
      setMenuCard(null);
      acct
        .hideSource(key)
        .then((previous) => setUndo({ message: `Cards from ${sourceName(key)} hidden.`, kind: 'source', previous }))
        .catch(() => setUndo(null));
    },
    [acct],
  );
  const undoHide = useCallback(() => {
    if (undo?.kind === 'topic') void acct.restoreTopics(undo.previous).catch(() => undefined);
    if (undo?.kind === 'source') void acct.saveSources(undo.previous).catch(() => undefined);
    if (undo?.kind === 'follow') {
      const currentlyFollowed = followedTopics.includes(undo.slug);
      setFollowOverrides((current) => ({ ...current, [undo.slug]: !currentlyFollowed }));
      followsState.toggleTopic(undo.slug);
    }
    setUndo(null);
  }, [acct, undo, followedTopics, followsState]);
  const clearUndo = useCallback(() => setUndo(null), []);

  const { noteCards, trackView, react, trackDwell, trackDwellOnExit, trackOpenDetail } = acct;

  // ---- Time spent on cards (signed in only) ----
  // The clock runs for the card on screen and pauses while the tab is hidden, a
  // sheet or menu is open, or another screen is on top. Detail time is sent as
  // 'open_detail' instead. Sending is fire and forget.
  const dwell = useRef(new DwellTimer());
  const sendDwell = useCallback((r: { cardId: string; ms: number } | null) => r && trackDwell(r.cardId, r.ms), [trackDwell]);
  const onActiveCard = useCallback(
    (c: BlurbCard) => {
      trackView(c);
      sendDwell(dwell.current.show(c.id, Date.now()));
    },
    [trackView, sendDwell],
  );
  const onActiveBoth = useCallback(
    (c: BlurbCard) => {
      onSeenCandidate(c);
      if (signedIn) onActiveCard(c);
    },
    [onSeenCandidate, onActiveCard, signedIn],
  );
  useEffect(() => {
    const t = dwell.current;
    if (focused) t.resume('away', Date.now());
    else t.pause('away', Date.now());
  }, [focused]);
  const overlay = sheetCard !== null || detailCard !== null || menuCard !== null;
  useEffect(() => {
    const t = dwell.current;
    if (overlay) t.pause('sheet', Date.now());
    else t.resume('sheet', Date.now());
  }, [overlay]);
  useEffect(() => {
    if (detailCard && signedIn) trackOpenDetail(detailCard);
  }, [detailCard, signedIn, trackOpenDetail]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') dwell.current.resume('hidden', Date.now());
      else dwell.current.pause('hidden', Date.now());
    });
    // Closing the tab: send what we have. keepalive lets the request outlive the page and keeps
    // the auth header (sendBeacon cannot set headers).
    const onHide = () => {
      const r = dwell.current.finish(Date.now());
      if (r) trackDwellOnExit(r.cardId, r.ms);
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
    };
  }, [trackDwellOnExit]);
  useEffect(() => {
    // Signing out (or a different user) ends the current look without sending it.
    dwell.current.finish(Date.now());
  }, [acct.user?.id]);
  useEffect(() => {
    if (forYou && !locked) noteCards(state.items);
  }, [forYou, locked, state.items, noteCards]);

  const first = items.length === 0;
  let body;
  if (locked) body = <ForYouWarmup progress={gate} onBack={() => setMode('top')} />;
  else if (first && state.error) body = <ErrorState message={state.error} onRetry={retry} />;
  else if (first && (state.loading || !state.done)) body = <LoadingState label="Loading the feed…" />;
  else if (first) {
    body = (
      <EmptyState
        message={forYou ? 'Nothing new in your topics yet.' : category ? 'No cards in this category yet.' : 'No cards yet. Check back soon.'}
        actionLabel={forYou ? 'Show Trending' : category ? 'Show all categories' : undefined}
        onAction={forYou ? () => setMode('top') : category ? () => setCategory(null) : undefined}
      />
    );
  } else {
    body = (
      <FeedPager
        items={items}
        config={config}
        categories={categories}
        loadingMore={state.loading}
        done={state.done}
        onEndReached={loadMore}
        onShowSources={showSources}
        onOpenDetail={openDetail}
        wide={wide}
        reactions={acct.reactions}
        onReact={react}
        onQueuePosition={(i) => { queuePosition.current = i; }}
        followedTopics={followedTopics}
        onToggleTopicFollow={toggleCardFollow}
        onActiveCard={focused ? onActiveBoth : undefined}
        active={focused && sheetCard === null && detailCard === null && menuCard === null}
        onMore={setMenuCard}
      />
    );
  }

  const inlineError =
    items.length > 0 && state.error ? (
      <Pressable onPress={retry} accessibilityRole="button" style={[styles.inlineError, { backgroundColor: p.dataSoft }]}>
        <Text style={{ color: p.dataInk, fontFamily: fonts.sansSemi }}>Could not load more. Tap to retry.</Text>
      </Pressable>
    ) : null;

  // Guests: one quiet line under the chips, dismissible. Never blocks the feed.
  const expired = acct.notice === SIGN_IN_AGAIN_MESSAGE; // not "Your account was deleted."
  const prompt =
    !signedIn && (!promptHidden || expired) ? (
      <View style={[styles.prompt, !wide && styles.promptNarrow, wide && styles.promptWide, { backgroundColor: p.accentSoft }]}>
        <Pressable onPress={() => router.navigate('/signin' as never)} accessibilityRole="link" style={styles.promptMain}>
          <Text style={[styles.promptText, { color: p.accentInk }]}>
            {expired ? `${acct.notice} Sign in →` : 'Sign in for a feed tailored to you →'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            store.set(PROMPT_KEY, '1');
            setPromptHidden(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Hide this suggestion"
          hitSlop={10}
          style={styles.promptClose}
        >
          <CloseIcon color={p.accentInk} size={16} />
        </Pressable>
      </View>
    ) : null;

  // For you: the chips don't apply; show what it is built from instead.
  const forYouLine = forYou ? (
    <View style={[styles.forYouLine, !wide && styles.promptNarrow, wide && styles.forYouWide]}>
      <Text style={[styles.forYouText, wide && { flex: 0 }, { color: p.muted }]} numberOfLines={wide ? 6 : 2}>
        {!signedIn
          ? followed.length || Object.keys(acct.reactions).length
            ? 'Ranked on this device from your topics and likes.'
            : 'Like cards or pick topics and this feed learns, on this device.'
          : !forYouCoversTopics(state.items, followed)
            ? 'No new cards in your topics yet; showing top stories.'
            : followed.length
              ? `Tailored to ${followed.map((s) => categoryName(s, categories)).join(', ')} and your likes.`
              : 'Tailored to your likes.'}
      </Text>
      <Pressable onPress={() => router.navigate('/account' as never)} accessibilityRole="link" hitSlop={8}>
        <Text style={[styles.forYouEdit, { color: p.accentInk }]}>{followed.length ? 'Edit topics' : 'Pick topics'}</Text>
      </Pressable>
      {!signedIn ? (
        <Pressable onPress={() => router.navigate('/signin' as never)} accessibilityRole="link" hitSlop={8}>
          <Text style={[styles.forYouSync, { color: p.muted }]}>Sign in to sync across devices</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  // Under ~1180 px the right column would squeeze the card, so it steps aside (and its
  // two RPCs are not called).
  const asideFits = wide && width >= ASIDE_MIN_WIDTH;
  const aside = useAsideData(api, asideFits);
  // Hidden topics and sources leave Top stories too.
  const asideShown = { ...aside, stories: visible(aside.stories) };
  const showAside = asideFits && (aside.loading || asideShown.stories.length > 0 || aside.trends.length > 0);

  const chips = forYou ? (
    forYouLine
  ) : (
    <CategoryChips
      categories={chipCategories}
      selected={category}
      onSelect={setCategory}
      wide={wide}
      onEdit={() => router.navigate('/account' as never)}
    />
  );

  return (
    <Shell
      active="feed"
      feedTab={{ mode, onChange: setMode }}
      left={
        wide ? (
          <>
            {forYou ? (
              forYouLine
            ) : (
              <CategoryList
                categories={chipCategories}
                selected={category}
                onSelect={setCategory}
                onEdit={() => router.navigate('/account' as never)}
              />
            )}
            {prompt}
          </>
        ) : undefined
      }
      aside={
        showAside ? <WideAside data={asideShown} categories={categories} onOpenStory={openDetail} /> : undefined
      }
    >
      {wide ? null : (
        <>
          {/* Mobile-Final: 56 px white header (wordmark + feed tabs), then the Numbers ticker. */}
          <View style={[styles.header, { backgroundColor: p.surface, borderBottomColor: p.border }]}>
            <View style={styles.brand}>
              <Wordmark size={22} />
            </View>
            <View style={styles.tabs}>
              <SortToggle mode={mode} onChange={setMode} forYou />
            </View>
          </View>
          <View style={[styles.ticker, { borderBottomColor: p.border }]}>
            <NumbersTicker api={api} config={config} />
          </View>
          {chips}
          {prompt}
        </>
      )}
      {inlineError}
      <View style={styles.fill}>{body}</View>
      <SourcesSheet card={sheetCard} config={config} onClose={() => setSheetCard(null)} />
      <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
      <CardMenu
        card={menuCard}
        categories={categories}
        onHideTopic={hideTopic}
        onHideSource={sourcesSupported ? hideSource : undefined}
        onClose={() => setMenuCard(null)}
      />
      <UndoToast message={undo?.message ?? null} onUndo={undoHide} onDone={clearUndo} />
    </Shell>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-end', height: MOBILE_HEADER_HEIGHT, paddingLeft: 16, paddingRight: 12, borderBottomWidth: 1 },
  brand: { height: MOBILE_HEADER_HEIGHT - 1, justifyContent: 'center', marginRight: 6 },
  tabs: { flexShrink: 1, marginBottom: -1 }, // the active underline sits on the header's bottom rule
  ticker: { height: 44, borderBottomWidth: 1, justifyContent: 'center', overflow: 'hidden' },
  inlineError: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, marginTop: 6 },
  prompt: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 14, paddingRight: 8, minHeight: 40 },
  promptWide: { marginTop: 16, paddingLeft: 12, minHeight: 0 },
  promptNarrow: { marginHorizontal: 16, marginTop: 8 },
  promptMain: { flex: 1, paddingVertical: 8 },
  promptText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  promptClose: { padding: 6 },
  forYouLine: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36 },
  forYouWide: { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingHorizontal: 12 },
  forYouText: { flex: 1, fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
  forYouEdit: { fontFamily: fonts.sansSemi, fontSize: 14 },
  forYouSync: { fontFamily: fonts.sans, fontSize: 13, textDecorationLine: 'underline' },
});
