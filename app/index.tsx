// Feed screen. Phones: wordmark, Trending / Latest (/ For you) tabs, category chips,
// the swipe pager, bottom nav. Wide web (docs/design/web/Web-Final.dc.html): top bar
// with the tabs, Numbers strip, categories on the left, the wide card in the middle,
// top stories and trends on the right (Shell lays out the frame). Guests see a gentle
// sign-in prompt; the feed never needs an account.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { DwellTimer } from '../lib/feed/dwell';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { BlurbCard, CategorySlug } from '../contract/types.ts';
import { useAppData } from '../lib/shared/appData';
import { useAccount } from '../lib/account/accountContext';
import { useFollows } from '../lib/following/useFollows';
import { forYouCoversTopics, withoutHidden } from '../lib/account/accountLogic';
import { favoritesFirst } from '../lib/storage/localPrefs';
import { rankLocal } from '../lib/feed/localRank';
import { SKIP_TARGET_ID } from '../lib/shared/focusMain';
import { rememberFeedTab, startFeedTab } from '../lib/feed/lastTab';
import { reasonFor as cardReasonFor, reasonText } from '../lib/feed/reasonLine';
import { confidence, targetAhead } from '../lib/feed/queueLogic';
import { sourceName, withoutHiddenSources } from '../lib/sources/sourceKeys';
import { SIGN_IN_AGAIN_MESSAGE } from '../lib/account/session';
import type { FeedTab } from '../lib/feed/feedLogic';
import { topicParam } from '../lib/brief/briefLogic';
import { categoryName } from '../lib/shared/format';
import { defaultStore, onStoreChange } from '../lib/storage/storage';
import { FOR_YOU_SEEN_MS, SEEN_KEY, forYouProgress, readSeen, recordSeen } from '../lib/feed/forYouGate';
import { ForYouWarmup } from '../components/feed/ForYouWarmup';
import { shadowContext, surfaceForTab, type ShadowSurface } from '../lib/ml/shadowLog';
import { useFeed, useFeedHeads } from '../lib/feed/useFeed';
import { latestOrder, promoteHead } from '../lib/feed/feedOrder';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { MOBILE_HEADER_HEIGHT, fonts } from '../lib/theme/theme';
import { CategoryChips, CategoryList } from '../components/feed/CategoryChips';
import { FeedPager } from '../components/feed/FeedPager';
import { CloseIcon } from '../components/shell/Icons';
import { NumbersTicker } from '../components/numbers/NumbersTicker';
import { Shell, Wordmark } from '../components/shell/Shell';
import { WideAside, useAsideData } from '../components/shell/WideAside';
import { SortToggle } from '../components/feed/SortToggle';
import { SourcesSheet } from '../components/card/SourcesSheet';
import { DetailSheet } from '../components/card/DetailSheet';
import { reportToast } from '../lib/api/report';
import type { ReportReason } from '../lib/api/report';
import { CardMenu } from '../components/card/CardMenu';
import { UndoToast } from '../components/feed/UndoToast';
import { cornerToastText } from '../lib/feed/toastPlacement';
import { CardSkeleton, EmptyState, ErrorState } from '../components/shell/States';
import { readFlags } from '../lib/flags/flags';
import { FINE_NAMES, fineChips, isFineTopic, laneVisible, matchesFine, MACRO_FINE, fineTopicsOf } from '../lib/topics/fineTopics';
import { useSignals } from '../lib/signals/useSignals';
import { interestsFirst, isSaved, toggleMutedTicker, toggleMutedTopic, toggleSaved, withoutMuted } from '../lib/signals/signalsLogic';
import { sinceStart, startVisit, touchVisit } from '../lib/since/sinceLogic';
import { pickedReason } from '../lib/onboarding/setupLogic';
import { sincePillText } from '../lib/since/sinceFeed';
import { useSinceCards } from '../lib/since/useSinceCards';
import { hasSeenTutorial } from '../lib/tutorial/tutorialLogic';

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
  // Wave 2 flags (lib/flags/flags.ts): all off by default; with them off none of the code below changes the feed.
  const flags = useMemo(() => readFlags(), []);
  const { signals, update: updateSignals } = useSignals();
  const params = useLocalSearchParams<{ tab?: string; t?: string; category?: string; dl?: string }>();
  const { width, height: windowHeight } = useWindowDimensions();
  // Short phones (360x640 and similar): the card needs every row, so the guest sign-in
  // nudge stays hidden there (the Me tab and the top bar still offer sign-in).
  const shortPhone = !wide && windowHeight > 0 && windowHeight < 700;
  // Landscape phones and 200% zoom (under 520 px tall): the category chips step aside too, so the
  // card keeps enough height to read; categories stay reachable by widening or rotating.
  const tinyHeight = !wide && windowHeight > 0 && windowHeight < 520;
  // The bottom Feed tab links to / with no tab: bring back the tab used last this visit (Trending on a fresh launch).
  const [mode, setMode] = useState<FeedTab>(() => startFeedTab(params.tab));
  useEffect(() => rememberFeedTab(mode), [mode]);
  const [category, setCategory] = useState<CategorySlug | null>(null);
  const [sheetCard, setSheetCard] = useState<BlurbCard | null>(null);
  const [detailCard, setDetailCard] = useState<BlurbCard | null>(null);
  const [menuCard, setMenuCard] = useState<BlurbCard | null>(null);
  // The corner toast shows a short word (message) and reads the full sentence (label); seq
  // restarts its 5 s timer when the same message shows twice.
  type FeedUndo =
    | { message: string; label: string; kind: 'topic'; previous: { followed: string[]; hidden: string[] } }
    | { message: string; label: string; kind: 'source'; previous: string[] }
    | { message: string; label: string; kind: 'follow'; slug: string }
    | { message: string; label: string; kind: 'fewer'; card: BlurbCard }
    | { message: string; label: string; kind: 'report' }
    | { message: string; label: string; kind: 'signal'; revert: () => void };
  const [undo, setUndoState] = useState<(FeedUndo & { seq: number }) | null>(null);
  const toastSeq = useRef(0);
  const setUndo = useCallback((u: FeedUndo | null) => setUndoState(u ? { ...u, seq: ++toastSeq.current } : null), []);
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
  const fineSelected = flags.topics && isFineTopic(category) ? category : null;
  const visible = useCallback(
    (cards: BlurbCard[]) => {
      let out = withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources);
      if (flags.signals) out = withoutMuted(out, signals); // A-22 muted companies and fine topics
      if (flags.topics) {
        out = out.filter((c) => laneVisible(c, mode, signals.optIn)); // A-12 / D-121 opt-in lanes
        // With the Tech/AI lane on, the plain Tech chip folds into it, so Tech/AI shows both (D-231).
        const techMerged = fineSelected === 'tech-ai' && signals.optIn.includes('tech-ai');
        if (fineSelected) out = out.filter((c) => matchesFine(c, fineSelected) || (techMerged && c.category === 'tech'));
      }
      return out;
    },
    [hidden, hiddenSources, flags, signals, mode, fineSelected],
  );
  const local = acct.localPrefs;
  // For you stays locked until 3 stories have been read or reacted to, or one topic or company is followed (forYouGate.ts).
  const [seenList, setSeenList] = useState(() => readSeen(store));
  // "Clear data on this device" / delete: forget the For you history and the dismissed prompt at once.
  useEffect(
    () =>
      onStoreChange((k) => {
        if (k === SEEN_KEY) setSeenList(readSeen(store));
        if (k === PROMPT_KEY) setPromptHidden(store.get(PROMPT_KEY) === '1');
      }),
    [],
  );
  const gate = forYouProgress({
    reacted: Object.entries(local.reactions).map(([id, v]) => ({ id, category: v.topic })),
    seen: seenList,
    // One followed topic, company or source opens For you at once (M9 F4).
    followed: local.follows.topics.length + local.follows.tickers.length + local.follows.sources.length + (acct.viewPrefs?.followed.length ?? 0),
  });
  const locked = forYou && !gate.ready;
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSeenCandidate = useCallback((c: BlurbCard) => {
    if (seenTimer.current) clearTimeout(seenTimer.current);
    seenTimer.current = setTimeout(() => setSeenList(recordSeen(store, c)), FOR_YOU_SEEN_MS);
  }, []);
  useEffect(() => () => { if (seenTimer.current) clearTimeout(seenTimer.current); }, []);
  const rankPage = useCallback((cards: BlurbCard[]) => (flags.onboarding ? interestsFirst(rankLocal(cards, local), signals.interests) : rankLocal(cards, local)), [local, flags, signals.interests]);
  const { state, loadMore, retry, rerank } = useFeed(
    api,
    { mode: locked ? 'top' : mode, category: forYou || fineSelected ? null : category, user: acct.user?.id ?? null },
    acct.account,
    visible,
    signedIn ? undefined : rankPage,
    targetAhead(confidence({ reactions: Object.keys(local.reactions).length, topics: local.follows.topics.length + (acct.viewPrefs?.followed.length ?? 0), sources: local.follows.sources.length, tickers: local.follows.tickers.length, favorites: (acct.viewPrefs?.followed.length ?? 0), accountSignals: signedIn ? Object.keys(acct.reactions).length : 0 })),
  );
  // Load speed: the extra first-page pulls (tab heads) and the wide side column wait until the first
  // cards are on screen (or the request ended), so the first page gets the connection to itself.
  const firstPaintDone = state.items.length > 0 || state.done || !!state.error;
  const heads = useFeedHeads(api, acct.account, acct.user?.id ?? null, fineSelected ? null : category, visible, focused && firstPaintDone, mode);
  // What the pager shows right now (after all re-ordering), for the view's slot.
  const shownRef = useRef<BlurbCard[]>([]);
  const surfaceRef = useRef<ShadowSurface | null>(null);
  const queuePosition = useRef(0);
  useEffect(() => { rerank(local, queuePosition.current, signedIn); }, [local, signedIn, rerank]);
  const showSources = useCallback((c: BlurbCard) => setSheetCard(c), []);
  const openDetail = useCallback((c: BlurbCard) => setDetailCard(c), []);

  // For you: one muted line per card from the reader's own choices ("Because you follow NWND"). Signed in, the server's
  // reason on the card wins; signed out the device's follows and likes decide (lib/feed/reasonLine.ts).
  const forYouReason = useCallback(
    (c: BlurbCard) => reasonText(cardReasonFor(c, signedIn ? null : local), categories),
    [signedIn, local, categories],
  );
  const items = visible(state.items);
  const pagerKey = `${mode}|${category ?? 'all'}`;
  const queuePositions = useRef<Record<string, number>>({});
  const headId = mode === 'latest' ? null : heads?.[mode];
  const position = queuePositions.current[pagerKey] ?? 0;
  const reshown = useMemo(() => new Set(state.seenIds), [state.seenIds]);
  const pagerItems = mode === 'latest' ? latestOrder(items, position, reshown) : position === 0 ? promoteHead(items, headId) : items;
  shownRef.current = pagerItems;
  surfaceRef.current = surfaceForTab(locked ? 'top' : mode);
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
  const baseChips = favoritesFirst(withoutHidden(categories, hidden), followed);
  const chipCategories = useMemo(() => {
    if (!flags.topics) return baseChips;
    // A-12: the six macro topics (and any opted-in lane) follow the categories; the reader's interests come first.
    const extra = fineChips(signals.optIn).filter((c) => !signals.mutedTopics.includes(c.slug));
    // Opted in to Tech/AI: that chip covers Tech too, so the two never sit side by side.
    const base = signals.optIn.includes('tech-ai') ? baseChips.filter((c) => c.slug !== 'tech') : baseChips;
    return [...base, ...favoritesFirst(extra, signals.interests)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags.topics, categories, hidden, followed.join('|'), signals.optIn, signals.interests, signals.mutedTopics]);
  const allNames = flags.topics ? [...categories, ...fineChips(['crypto', 'tech-ai'])] : categories;
  useEffect(() => {
    if (category && hidden.includes(category)) setCategory(null);
  }, [category, hidden]);

  const hideTopic = useCallback(
    (c: BlurbCard) => {
      setMenuCard(null);
      const topic = categoryName(c.category, categories);
      acct
        .hideTopic(c.category)
        .then((previous) => {
          const t = cornerToastText('hideTopic', topic);
          setUndo({ message: t.text, label: t.label, kind: 'topic', previous });
        })
        .catch(() => setUndo(null));
    },
    [acct, categories, setUndo],
  );
  const toggleCardFollow = useCallback((card: BlurbCard) => {
    const isFollowed = followedTopics.includes(card.category);
    setFollowOverrides((current) => ({ ...current, [card.category]: !isFollowed }));
    followsState.toggleTopic(card.category);
    const topic = categoryName(card.category, categories);
    const t = cornerToastText(isFollowed ? 'unfollow' : 'follow', topic);
    setUndo({ message: t.text, label: t.label, kind: 'follow', slug: card.category });
  }, [followedTopics, followsState, categories, setUndo]);
  const hideSource = useCallback(
    (_c: BlurbCard, key: string) => {
      setMenuCard(null);
      acct
        .hideSource(key)
        .then((previous) => {
          const t = cornerToastText('hideSource', sourceName(key));
          setUndo({ message: t.text, label: t.label, kind: 'source', previous });
        })
        .catch(() => setUndo(null));
    },
    [acct, setUndo],
  );
  // "Fewer like this" = a dislike for the card (a no-op when it is already disliked); Undo takes it back.
  const fewerLikeThis = useCallback(
    (c: BlurbCard) => {
      setMenuCard(null);
      if (acct.reactions[c.id] !== 'dislike') acct.react(c, 'dislike');
      const t = cornerToastText('dislike');
      setUndo({ message: 'Fewer like this', label: t.label, kind: 'fewer', card: c });
    },
    [acct, setUndo],
  );
  const reportCard = useCallback(
    (c: BlurbCard, reason: ReportReason) => {
      setMenuCard(null);
      api.reportBlurb(c.id, reason).then((r) => {
        const text = reportToast(r);
        setUndo({ message: r.ok ? 'Reported' : 'Not sent', label: text, kind: 'report' }); // the corner pill is narrow: short word visible, full sentence spoken
      });
    },
    [api, setUndo],
  );
  // A-22 (flag `signals`): save for later, mute a company, mute a fine topic. Each shows a corner toast with Undo.
  const signalToast = useCallback(
    (message: string, label: string, revert: () => void) => {
      setMenuCard(null);
      setUndo({ message, label, kind: 'signal', revert });
    },
    [setUndo],
  );
  const menuSignals = flags.signals
    ? {
        saved: menuCard ? isSaved(signals, menuCard.id) : false,
        onSave: (c: BlurbCard) => {
          const was = isSaved(signals, c.id);
          updateSignals((s) => toggleSaved(s, c));
          signalToast(was ? 'Removed' : 'Saved', was ? 'Removed from saved.' : 'Saved for later. Find it in Account, Saved and signals.', () => updateSignals((s) => toggleSaved(s, c)));
        },
        muteTicker: (c: BlurbCard) => (c.tickers[0] ? { symbol: c.tickers[0].symbol, name: c.tickers[0].name || c.tickers[0].symbol } : null),
        onMuteTicker: (_c: BlurbCard, symbol: string) => {
          updateSignals((s) => (s.mutedTickers.includes(symbol) ? s : toggleMutedTicker(s, symbol)));
          signalToast('Muted', `Muted ${symbol}. No more cards about it.`, () => updateSignals((s) => (s.mutedTickers.includes(symbol) ? toggleMutedTicker(s, symbol) : s)));
        },
        muteTopic: (c: BlurbCard) => {
          const t = fineTopicsOf(c).find((x) => (MACRO_FINE as readonly string[]).includes(x));
          return t ? { slug: t, name: FINE_NAMES[t] } : null;
        },
        onMuteTopic: (_c: BlurbCard, slug: string) => {
          updateSignals((s) => (s.mutedTopics.includes(slug) ? s : toggleMutedTopic(s, slug)));
          signalToast('Muted', `Muted ${FINE_NAMES[slug as keyof typeof FINE_NAMES] ?? slug}. You can undo it in Saved and signals.`, () => updateSignals((s) => (s.mutedTopics.includes(slug) ? toggleMutedTopic(s, slug) : s)));
        },
      }
    : undefined;
  const undoHide = useCallback(() => {
    if (undo?.kind === 'signal') undo.revert();
    if (undo?.kind === 'fewer' && acct.reactions[undo.card.id] === 'dislike') acct.react(undo.card, 'dislike'); // pressing again clears it
    if (undo?.kind === 'topic') void acct.restoreTopics(undo.previous).catch(() => undefined);
    if (undo?.kind === 'source') void acct.saveSources(undo.previous).catch(() => undefined);
    if (undo?.kind === 'follow') {
      const currentlyFollowed = followedTopics.includes(undo.slug);
      setFollowOverrides((current) => ({ ...current, [undo.slug]: !currentlyFollowed }));
      followsState.toggleTopic(undo.slug);
    }
    setUndo(null);
  }, [acct, undo, followedTopics, followsState, setUndo]);
  const clearUndo = useCallback(() => setUndo(null), [setUndo]);

  const { noteCards, trackView, react, trackDwell, trackDwellOnExit, trackOpenDetail } = acct;

  // ---- Time spent on cards (signed in only) ----
  // The clock runs for the card on screen and pauses while the tab is hidden, a
  // sheet or menu is open, or another screen is on top. Detail time is sent as
  // 'open_detail' instead. Sending is fire and forget.
  const dwell = useRef(new DwellTimer());
  const sendDwell = useCallback((r: { cardId: string; ms: number } | null) => r && trackDwell(r.cardId, r.ms), [trackDwell]);
  const onActiveCard = useCallback(
    (c: BlurbCard) => {
      trackView(c, shadowContext(surfaceRef.current, shownRef.current, c.id));
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

  // ---- B-06 Since yesterday (flag `since`) ----
  const [visit] = useState(() => (flags.since ? startVisit(store) : null));
  useEffect(() => {
    if (!flags.since) return;
    const t = setInterval(() => touchVisit(store), 5 * 60 * 1000);
    const onHide = () => touchVisit(store);
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(t);
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
    };
  }, [flags.since]);
  // The pill counts with the same loader and filters as the /since page, so the two numbers are equal.
  const sinceFrom = useMemo(() => (visit ? sinceStart(visit) : 0), [visit]);
  const sinceAll = useSinceCards(flags.since && !!visit && mode === 'latest', sinceFrom);
  const sinceCount = flags.since && visit && mode === 'latest' && sinceAll.done ? sinceAll.items.length : 0;

  // ---- A-17 three-question setup (flag `onboarding`): once, after the tour, skippable ----
  useEffect(() => {
    // A feed URL typed or shared on its own (a tab and no t) is never interrupted: setup waits for the next plain visit.
    // After the tour on such a URL (dl=1) setup runs once and hands the requested tab back (setupNext).
    const bareDeepLink = !!params.tab && !params.t;
    if (flags.onboarding && focused && signals.setup === null && hasSeenTutorial(store) && !bareDeepLink) {
      router.replace((params.dl && params.tab ? `/setup?next=${params.tab}` : '/setup') as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flags.onboarding, focused, signals.setup, params.t]);

  const first = items.length === 0;
  let body;
  if (locked) body = <ForYouWarmup progress={gate} onBack={() => setMode('top')} />;
  else if (first && state.error) body = <ErrorState message={state.error} onRetry={retry} />;
  else if (first && (state.loading || !state.done)) body = <CardSkeleton wide={wide} />;
  else if (first) {
    body = (
      <EmptyState
        title={forYou ? 'Your topics are quiet' : category ? `No ${categoryName(category, allNames)} stories right now` : 'No stories yet'}
        message={forYou ? 'Nothing new in your topics right now. Trending has the big market and economy stories.' : category ? 'Nothing new in this topic lately. Try All, or another topic.' : 'No cards yet. Check back soon.'}
        actionLabel={forYou ? 'Show Trending' : category ? 'Show all categories' : undefined}
        onAction={forYou ? () => setMode('top') : category ? () => setCategory(null) : undefined}
      />
    );
  } else {
    body = (
      <FeedPager
        // A new tab or topic is a new list: start it fresh (the pager freezes the order it shows).
        key={pagerKey}
        items={pagerItems}
        timeLabel={mode === 'latest' ? 'added' : undefined}
        config={config}
        categories={categories}
        loadingMore={state.loading}
        done={state.done}
        reshownIds={reshown}
        onEndReached={loadMore}
        onShowSources={showSources}
        onOpenDetail={openDetail}
        wide={wide}
        reactions={acct.reactions}
        onReact={react}
        onQueuePosition={(i) => { queuePosition.current = i; queuePositions.current[pagerKey] = i; }}
        followedTopics={followedTopics}
        onToggleTopicFollow={toggleCardFollow}
        reasonFor={forYou ? forYouReason : undefined}
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

  const sincePill =
    sinceCount > 0 ? (
      <Pressable
        onPress={() => router.navigate('/since' as never)}
        accessibilityRole="link"
        testID="since-pill"
        style={[styles.prompt, styles.promptNarrow, { backgroundColor: p.dataSoft }]}
      >
        <Text style={[styles.promptText, styles.sincePillText, { color: p.dataInk }]}>
          {sincePillText(sinceCount, visit?.prev ?? null, sinceFrom)}
        </Text>
      </Pressable>
    ) : null;

  // Guests: one quiet line under the chips, dismissible. Never blocks the feed.
  const expired = acct.notice === SIGN_IN_AGAIN_MESSAGE; // not "Your account was deleted."
  const prompt =
    !signedIn && ((!promptHidden && !shortPhone) || expired) ? (
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

  // A-17: the topics picked in setup are named here ('Because you picked Rates and Labor'), since the server only knows categories.
  const pickedLine = flags.onboarding ? pickedReason(signals) : null;
  // For you: the chips don't apply; show what it is built from instead.
  const forYouLine = forYou ? (
    <View style={[styles.forYouLine, !wide && styles.promptNarrow, wide && styles.forYouWide]}>
      <Text style={[styles.forYouText, { color: p.muted }]} numberOfLines={wide ? 6 : 3}>
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
      {pickedLine ? (
        <Text style={[styles.forYouText, { color: p.muted }]} testID="picked-reason">
          {pickedLine}
        </Text>
      ) : null}
      {/* Own row with 44 px tall links (R-402): on a 360 px phone the old one-line version cut the hint to
          "Like cards o..." and left two 16-18 px tap targets. */}
      <View style={styles.forYouLinks}>
        <Pressable onPress={() => router.navigate((followed.length ? '/account' : flags.onboarding ? '/setup?next=for_you' : '/following') as never)} accessibilityRole="link" style={styles.forYouLink}>
          <Text style={[styles.forYouEdit, { color: p.accentInk }]}>{followed.length ? 'Edit topics' : 'Pick topics'}</Text>
        </Pressable>
        {!signedIn ? (
          <Pressable onPress={() => router.navigate('/signin' as never)} accessibilityRole="link" style={styles.forYouLink}>
            <Text style={[styles.forYouSync, { color: p.muted }]}>Sign in to sync across devices</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  ) : null;

  // Under ~1180 px the right column would squeeze the card, so it steps aside (and its
  // two RPCs are not called).
  const asideFits = wide && width >= ASIDE_MIN_WIDTH;
  const aside = useAsideData(api, asideFits && firstPaintDone);
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
      notice
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
          {/* Short phones (under 700 px tall): the ticker steps aside so a data card's change and
              agency citation fit on screen; Numbers stays reachable from Brief ("See all numbers"). */}
          {shortPhone ? null : (
            <View style={[styles.ticker, { borderBottomColor: p.border }]}>
              <NumbersTicker api={api} config={config} />
            </View>
          )}
          {tinyHeight ? null : chips}
          {prompt}
        </>
      )}
      {/* One page heading for screen readers; each card headline is a level-2 heading under it. */}
      <Text role="heading" aria-level={1} style={styles.srOnly}>{`Element: ${mode === 'latest' ? 'Latest' : forYou ? 'For you' : 'Trending'} stories`}</Text>
      {/* Above the card on every width, so it is on screen without scrolling the left rail (R-4xx). */}
      {sincePill}
      {inlineError}
      {/* Target of the "Skip to content" link: the cards (components/shell/SkipLink.tsx). */}
      <View style={styles.fill} nativeID={SKIP_TARGET_ID}>{body}</View>
      <SourcesSheet card={sheetCard} config={config} onClose={() => setSheetCard(null)} />
      <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
      <CardMenu
        card={menuCard}
        categories={categories}
        onHideTopic={hideTopic}
        onFewer={fewerLikeThis}
        onReport={reportCard}
        onHideSource={sourcesSupported ? hideSource : undefined}
        signals={menuSignals}
        onClose={() => setMenuCard(null)}
      />
      <UndoToast
        message={undo?.message ?? null}
        label={undo?.label}
        token={undo?.seq}
        // A report confirmation has no Undo: a top bar, so it never hides the source name in the card footer (run 3b).
        placement={undo?.kind === 'report' ? 'top' : 'corner'}
        wide={wide}
        onUndo={undoHide}
        showUndo={undo?.kind !== 'report'}
        onDone={clearUndo}
      />
    </Shell>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  header: { flexDirection: 'row', alignItems: 'flex-end', height: MOBILE_HEADER_HEIGHT, paddingLeft: 16, paddingRight: 12, borderBottomWidth: 1 },
  brand: { height: MOBILE_HEADER_HEIGHT - 1, justifyContent: 'center', marginRight: 6 },
  tabs: { flexShrink: 1, marginBottom: -1 }, // the active underline sits on the header's bottom rule
  ticker: { height: 44, borderBottomWidth: 1, justifyContent: 'center', overflow: 'hidden' },
  inlineError: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, marginTop: 6 },
  prompt: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 14, paddingRight: 0, minHeight: 44 },
  promptWide: { marginTop: 16, paddingLeft: 12, minHeight: 0 },
  promptNarrow: { marginHorizontal: 16, marginTop: 8 },
  promptMain: { flex: 1, minHeight: 44, justifyContent: 'center' },
  promptText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  promptClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  forYouLine: { flexDirection: 'column', alignItems: 'flex-start', gap: 0, minHeight: 36 },
  forYouLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, alignItems: 'center' },
  forYouLink: { minHeight: 44, justifyContent: 'center' },
  forYouWide: { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingHorizontal: 12 },
  forYouText: { alignSelf: 'stretch', fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
  forYouEdit: { fontFamily: fonts.sansSemi, fontSize: 14 },
  sincePillText: { flex: 1, paddingVertical: 10 },
  forYouSync: { fontFamily: fonts.sans, fontSize: 13, textDecorationLine: 'underline' },
});
