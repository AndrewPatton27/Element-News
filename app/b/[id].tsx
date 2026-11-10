// The shared-card page /b/<id>: what a Share link opens. Loads the one card (api.card, the anonymous
// api.card_by_id RPC) and shows it as a standalone view: topic, headline, source line, key points, the
// in-depth text, the sources, then the AI notice AND the disclaimer inside the view (rule 5, D-80: no feed
// strip here), like / dislike / follow / share (D-63), and an "Open Element" link to the feed. Unknown or
// unpublished cards get a friendly "not found". In production the Pages Function functions/b/[id].ts serves
// this same app shell with the card's link-preview tags. No images (rule 9).

import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { BlurbCard } from '../../contract/types.ts';
import { useAppData } from '../../lib/shared/appData';
import { categoryName } from '../../lib/shared/format';
import { userMessage } from '../../lib/api/errors';
import { isCardId } from '../../lib/share/sharePage';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, radius } from '../../lib/theme/theme';
import { ScreenShell } from '../../components/shell/ScreenShell';
import { DetailBody } from '../../components/card/DetailBody';
import { DetailActions } from '../../components/card/DetailActions';
import { AiLabel, Disclaimer } from '../../components/card/Labels';
import { aiNoticeText, disclaimerText } from '../../lib/shared/labels';

type Load = { status: 'loading' } | { status: 'ready'; card: BlurbCard } | { status: 'missing' } | { status: 'error'; message: string };

export default function SharedCardScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ id?: string }>();
  const raw = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = isCardId(raw) ? raw.toLowerCase() : null;
  const { api, config, categories } = useAppData();
  const [load, setLoad] = useState<Load>(id ? { status: 'loading' } : { status: 'missing' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) { setLoad({ status: 'missing' }); return; }
    let alive = true; // a late answer for an earlier id is dropped
    setLoad({ status: 'loading' });
    api.card(id).then(
      (card) => { if (alive) setLoad(card ? { status: 'ready', card } : { status: 'missing' }); },
      (err) => { if (alive) setLoad({ status: 'error', message: userMessage(err) }); },
    );
    return () => { alive = false; };
  }, [api, id, attempt]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = load.status === 'ready' ? `${load.card.headline} · Element` : 'Element';
  }, [load]);

  const openApp = useCallback(() => router.navigate('/'), []);
  const back = () => (router.canGoBack() ? router.back() : router.navigate('/'));
  const openLink = (
    <Pressable onPress={openApp} accessibilityRole="link" accessibilityLabel="Open Element" style={[styles.open, { backgroundColor: p.accent }]}>
      <Text style={[styles.openText, { color: p.onAccent }]}>Open Element</Text>
    </Pressable>
  );

  return (
    <ScreenShell tab="feed" title="Shared story" onBack={back}>
      {load.status === 'ready' ? (
        <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Text style={[styles.meta, { color: p.accentInk }]} numberOfLines={1}>
            {categoryName(load.card.category, categories)}
          </Text>
          <DetailBody card={load.card} config={config} headingLevel={2} alwaysAiNotice />
          <View style={styles.actions}>
            <DetailActions card={load.card} />
          </View>
        </View>
      ) : load.status === 'loading' ? (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={[styles.help, { color: p.muted }]}>Loading the story…</Text>
        </View>
      ) : load.status === 'error' ? (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={[styles.head, { color: p.ink }]}>We could not load this story</Text>
          <Text style={[styles.help, { color: p.muted }]}>{load.message}</Text>
          <Pressable onPress={() => setAttempt((n) => n + 1)} accessibilityRole="button" style={[styles.button, { borderColor: p.borderStrong, backgroundColor: p.surface }]}>
            <Text style={{ color: p.ink, fontFamily: fonts.sansSemi, fontSize: 15 }}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={[styles.head, { color: p.ink }]} accessibilityRole="header" aria-level={2}>This story is not available</Text>
          <Text style={[styles.help, { color: p.muted }]}>
            The link may be mistyped, or the story was taken down. The latest business and market news is on the feed.
          </Text>
        </View>
      )}
      {load.status === 'ready' ? null : (
        // No card on screen: the page still states both notices (About states them too).
        <View style={styles.labels}>
          <AiLabel text={aiNoticeText(config)} />
          <Disclaimer text={disclaimerText(config)} />
        </View>
      )}
      <View style={styles.openRow}>{openLink}</View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.tile, paddingTop: 18, paddingHorizontal: 18, gap: 18, overflow: 'hidden', maxWidth: 720, width: '100%', alignSelf: 'center' },
  meta: { fontFamily: fonts.sansSemi, fontSize: 14, letterSpacing: 0.2 },
  actions: { marginHorizontal: -18 },
  state: { alignItems: 'center', gap: 10, paddingVertical: 36, paddingHorizontal: 16 },
  head: { fontFamily: fonts.serif, fontSize: 22, textAlign: 'center' },
  help: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 520 },
  button: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  labels: { alignItems: 'center', gap: 2 },
  openRow: { alignItems: 'center', paddingVertical: 8 },
  open: { minHeight: 48, paddingHorizontal: 28, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  openText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
