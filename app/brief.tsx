// Brief screen: the daily and weekly brief (designs Mobile-Brief, Mobile-Final-2, Web-Brief,
// Web-Weekly). A Daily / Weekly toggle; headline stories, category sections, key numbers and,
// for the weekly brief, the movers (12-week charts). Each story opens the same DetailSheet as
// the feed. Topics and sources the reader hid stay out, like in the feed. The back end may not
// have the brief yet (the client then returns an empty one), so empty and error states matter.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { BlurbCard } from '../contract/types.ts';
import type { Api } from '../lib/api/api.ts';
import { useAppData } from '../lib/shared/appData';
import { useAccount } from '../lib/account/accountContext';
import { withoutHidden } from '../lib/account/accountLogic';
import {
  briefCards,
  briefDate,
  briefDateLabel,
  briefFooter,
  briefIsEmpty,
  briefView,
  dayLabelShort,
  feedTopicHref,
  generatedLine,
  headlineLabel,
  SECTION_PREVIEW,
  toBriefData,
  tokenParam,
  type BriefData,
  type BriefMode,
} from '../lib/brief/briefLogic';
import { userMessage } from '../lib/api/errors';
import { isRenderableKind, noticesFor } from '../lib/shared/labels';
import { withoutHiddenSources } from '../lib/sources/sourceKeys';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { MOBILE_HEADER_HEIGHT, fonts, space } from '../lib/theme/theme';
import { BriefEmpty, BriefMeta, BriefTabs } from '../components/brief/BriefChrome';
import { BriefMarkets } from '../components/numbers/BriefMarkets';
import { BriefMovers, BriefNumbers } from '../components/numbers/BriefNumbers';
import { BriefSignup } from '../components/account/BriefSignup';
import { BriefManage } from '../components/account/BriefSignupManage';
import { BriefStories } from '../components/brief/BriefStories';
import { BriefSummary } from '../components/brief/BriefSummary';
import { NumbersTicker } from '../components/numbers/NumbersTicker';
import { DetailSheet } from '../components/card/DetailSheet';
import { ScreenShell } from '../components/shell/ScreenShell';
import { Shell, Wordmark } from '../components/shell/Shell';
import { ErrorState, LoadingState } from '../components/shell/States';

// A brief older than this is fetched again when the reader comes back to the tab.
const STALE_MS = 10 * 60_000;

interface Slot {
  data: BriefData | null;
  loading: boolean; // a request is in flight
  error: string | null;
  loadedAt: number;
}
const EMPTY_SLOT: Slot = { data: null, loading: false, error: null, loadedAt: 0 };

// Daily and weekly are kept apart, so switching back and forth does not refetch.
function useBrief(api: Api, mode: BriefMode) {
  const [slots, setSlots] = useState<Record<BriefMode, Slot>>({ daily: EMPTY_SLOT, weekly: EMPTY_SLOT });
  const seq = useRef<Record<BriefMode, number>>({ daily: 0, weekly: 0 });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    (m: BriefMode) => {
      const id = ++seq.current[m]; // a newer request for the same brief wins
      setSlots((s) => ({ ...s, [m]: { ...s[m], loading: true, error: null } }));
      const request = m === 'daily' ? api.dailyBrief() : api.weeklyBrief();
      request
        .then((raw) => {
          if (alive.current && id === seq.current[m]) setSlots((s) => ({ ...s, [m]: { data: toBriefData(raw), loading: false, error: null, loadedAt: Date.now() } }));
        })
        .catch((e: unknown) => {
          if (alive.current && id === seq.current[m]) {
            setSlots((s) => ({ ...s, [m]: { ...s[m], loading: false, error: userMessage(e, 'Could not load the brief.') } }));
          }
        });
    },
    [api],
  );

  const slot = slots[mode];
  const needsLoad = slot.data === null && !slot.loading && slot.error === null;
  useEffect(() => {
    if (needsLoad) load(mode);
  }, [needsLoad, load, mode]);

  // Back on this tab after a while: fetch fresh content quietly.
  const loadedAt = slot.loadedAt;
  const busy = slot.loading;
  useFocusEffect(
    useCallback(() => {
      if (loadedAt > 0 && !busy && Date.now() - loadedAt > STALE_MS) load(mode);
    }, [loadedAt, busy, load, mode]),
  );

  const refresh = useCallback(() => load(mode), [load, mode]);
  return { slot, refresh };
}

export default function BriefScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config, categories } = useAppData();
  const acct = useAccount();
  const signedIn = acct.user !== null;
  const [mode, setMode] = useState<BriefMode>('daily');
  const [detailCard, setDetailCard] = useState<BlurbCard | null>(null);
  // brief?manage=<token> (the link in every brief email) opens the small manage card.
  const params = useLocalSearchParams<{ manage?: string | string[] }>();
  const manageToken = tokenParam(params.manage);
  const [manageOpen, setManageOpen] = useState(true);
  const { slot, refresh } = useBrief(api, mode);
  const { data, loading, error } = slot;

  // The same hidden topics / sources the feed uses.
  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const visible = useCallback(
    (cards: BlurbCard[]) => withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources),
    [hidden, hiddenSources],
  );

  const { trackOpenDetail } = acct;
  useEffect(() => {
    if (detailCard && signedIn) trackOpenDetail(detailCard);
  }, [detailCard, signedIn, trackOpenDetail]);

  const view = data ? briefView(data, categories, visible, (c) => isRenderableKind(c.kind)) : null;
  const unfiltered = data ? briefView(data, categories, undefined, (c) => isRenderableKind(c.kind)) : null;
  const refreshing = loading && data !== null;
  const goFeed = () => router.navigate('/' as never);
  const goNumbers = () => router.navigate('/numbers' as never);
  const goAccount = () => router.navigate('/account' as never);
  const goTopic = (slug: string) => router.navigate(feedTopicHref(slug) as never);

  const signup = <BriefSignup api={api} initialKind={mode} wide={wide} />;
  const closeManage = () => {
    setManageOpen(false);
    router.setParams({ manage: '' });
  };
  const manageCard =
    manageToken && manageOpen ? <BriefManage api={api} token={manageToken} wide={wide} onClose={closeManage} /> : null;
  const switchTabs = <BriefTabs mode={mode} onChange={setMode} wide={wide} />;

  let body;
  if (!data && error) {
    body = <ErrorState title="Could not load the brief" message={error} onRetry={refresh} />;
  } else if (!data || !view || !unfiltered) {
    body = (
      <View style={styles.center}>
        <LoadingState label={`Loading your ${mode} brief…`} />
      </View>
    );
  } else if (briefIsEmpty(view)) {
    const hiddenAll = !briefIsEmpty(unfiltered);
    body = (
      <>
        <BriefEmpty mode={mode} hidden={hiddenAll} onRefresh={refresh} onFeed={goFeed} onSettings={goAccount} />
        {signup}
      </>
    );
  } else {
    const label = headlineLabel(mode, data.window_hours);
    const stories = (
      <>
        <BriefSummary summary={view.summary} mode={mode} config={config} wide={wide} />
        <BriefStories
          label={label}
          right={wide ? undefined : dayLabelShort(briefDate(data))}
          cards={view.headlines}
          categories={categories}
          config={config}
          onOpen={setDetailCard}
          wide={wide}
          ranked
          showTeaser={mode === 'daily'}
        />
        <BriefMarkets
          cards={view.marketCards}
          numbers={view.marketNumbers}
          total={view.marketsTotal}
          notices={noticesFor(config, 'numbers_panel')}
          categories={categories}
          config={config}
          onOpen={setDetailCard}
          onSeeAll={() => goTopic('markets')}
          wide={wide}
        />
        {view.sections.map((s) => (
          <BriefStories
            key={s.category}
            label={s.title}
            cards={s.cards}
            categories={categories}
            config={config}
            onOpen={setDetailCard}
            wide={wide}
            preview={SECTION_PREVIEW}
            total={s.total}
            onSeeAll={() => goTopic(s.slug)}
          />
        ))}
      </>
    );
    const numbers = <BriefNumbers facts={view.numbers} notices={noticesFor(config, 'numbers_panel')} onAll={goNumbers} wide={wide} />;
    const movers = mode === 'weekly' ? <BriefMovers movers={view.movers} wide={wide} /> : null;
    body = wide ? (
      <View style={styles.columns}>
        <View style={styles.main}>{stories}</View>
        <View style={styles.aside}>
          {movers}
          {numbers}
          {signup}
        </View>
      </View>
    ) : (
      <>
        {stories}
        {movers}
        {numbers}
        {signup}
      </>
    );
  }

  const inlineError =
    data && error ? (
      <Text onPress={refresh} accessibilityRole="button" style={[styles.inlineError, { color: p.dataInk, backgroundColor: p.dataSoft }]}>
        Could not refresh the brief. Tap to retry.
      </Text>
    ) : null;
  const meta = data ? <BriefMeta line={generatedLine(data)} refreshing={refreshing} onRefresh={refresh} /> : null;
  const footerText = briefFooter(view ? briefCards(view) : [], config);
  const footer = footerText ? <Text style={[styles.footer, { color: p.muted }]}>{footerText}</Text> : null;

  if (wide) {
    return (
      <ScreenShell tab="brief" title={mode === 'weekly' ? 'Weekly brief' : 'Daily brief'} meta={briefDateLabel(mode, data)}>
        {switchTabs}
        {manageCard}
        {meta}
        {inlineError}
        {body}
        {footer}
        <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
      </ScreenShell>
    );
  }

  // Phones: the header carries the wordmark and the Daily / Weekly tabs (Mobile-Brief).
  return (
    <Shell active="brief" bare>
      <View style={[styles.header, { backgroundColor: p.surface, borderBottomColor: p.border }]}>
        <View style={styles.brand}>
          <Wordmark size={22} />
        </View>
        {switchTabs}
      </View>
      {mode === 'weekly' ? (
        <View style={[styles.strip, { borderBottomColor: p.border }]}>
          <NumbersTicker api={api} config={config} />
        </View>
      ) : null}
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} colors={[p.accent]} />}
      >
        {manageCard}
        {meta}
        {inlineError}
        {body}
        {footer}
      </ScrollView>
      <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
    </Shell>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  strip: { borderBottomWidth: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-end', height: MOBILE_HEADER_HEIGHT, paddingLeft: 16, paddingRight: 12, borderBottomWidth: 1 },
  brand: { height: MOBILE_HEADER_HEIGHT - 1, justifyContent: 'center', marginRight: 6 },
  scroll: { paddingHorizontal: space.page, paddingTop: 14, paddingBottom: space.md, gap: 18 },
  center: { minHeight: 260 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 36 },
  main: { flex: 1, minWidth: 0 },
  aside: { width: 320, gap: 16 },
  inlineError: { alignSelf: 'flex-start', overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, fontFamily: fonts.sansSemi, fontSize: 14 },
  footer: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingTop: 4 },
});
