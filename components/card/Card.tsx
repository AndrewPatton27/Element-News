// One feed card (design Mobile-Final / Web-Final): badge and meta, headline,
// (numbers), body, facts (Agency / Type / Published, on phones too), tickers, then
// the source row and a footer: small print on the left, like / dislike / share icon
// buttons on the right. The disclaimer appears once per card: under the card on
// phones, in the footer line on wide web (components/cardFooter.ts). No images,
// no prices. Link-out cards (reserved, the parser skips them in v1) have their
// own layout from the Feed-LinkOut draft. Swiping to react lives in FeedPager.

import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { router } from 'expo-router';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { addedLabel, cardTime, categoryName, clampHeadline, eventLabel } from '../../lib/shared/format';
import { cardLabels, disclaimerText, primarySource, shareAlikeCredit } from '../../lib/shared/labels';
import { OPEN_DETAIL_HINT, cardDetail } from '../../lib/shared/detail';
import { openUrl } from '../../lib/shared/openUrl';
import { usePalette } from '../../lib/theme/useTheme';
import type { Palette } from '../../lib/theme/theme';
import { fonts, radius } from '../../lib/theme/theme';
import { DataFacts } from './DataCard';
import { ExternalIcon, InfoIcon, NumbersIcon, PulseIcon, ShareIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';
import type { Feedback } from '../../lib/account/accountLogic';
import { Disclaimer, ShareAlikeLine } from './Labels';
import { SourceRow } from './SourceChip';
import { useFollowedStories } from '../../lib/following/useFollowedStories';
import { footerLabels, linkOutCredit, linkOutDelay, shareUrl } from './cardFooter';
import { shareStory } from '../../lib/shared/useCardActions';
import { tip } from '../../lib/theme/tooltip';
import { msSinceSwipeEnd, shouldOpenDetail, wasCardSwiped, type PointerPoint } from '../../lib/feed/swipeLogic';

interface Props {
  card: BlurbCard;
  timeLabel?: 'added'; // Latest tab: show "Added X ago" (published_at) instead of the event time
  config: AppConfig | null;
  categories: Category[];
  onShowSources: (card: BlurbCard) => void;
  onOpenDetail?: (card: BlurbCard) => void; // tap on the card body
  onMore?: (card: BlurbCard) => void; // "â‹¯" options (signed in only)
  onNext?: () => void;
  wide?: boolean;
  compact?: boolean; // short screens: smaller type so the card fits
  peek?: boolean; // phones: show the edge of the next card under this one
  reaction?: Feedback; // signed in: this user's like/dislike
  onReact?: (card: BlurbCard, pressed: Feedback) => void; // signed in only
  followedTopic?: boolean;
  onToggleTopicFollow?: (card: BlurbCard) => void;
}

type BadgeIcon = typeof SparkleIcon;

// Feed-LinkOut badge colours. Not in the palette; fine while DARK_MODE_ENABLED is false.
const LINK_OUT_BADGE = { bg: '#E9ECF3', fg: '#2D3A5C' };

// Share the card's /b/<id> page: the Web Share sheet where the browser has one, else
// copy the link. Returns the toast text, or null when the system sheet handled it.
const shareCard = shareStory;

function badgeFor(card: BlurbCard, p: Palette): { text: string; bg: string; fg: string; Icon: BadgeIcon | null } {
  if (card.kind === 'data') return { text: 'New data', bg: p.dataSoft, fg: p.dataInk, Icon: NumbersIcon };
  if (card.kind === 'link_out') return { text: 'From the publisher', bg: LINK_OUT_BADGE.bg, fg: LINK_OUT_BADGE.fg, Icon: ExternalIcon };
  // Drew: no "Summary" tag on AI-written cards (the AI label in the footer already says so).
  if (card.ai.generated) return { text: '', bg: p.accentSoft, fg: p.accentInk, Icon: null };
  return { text: 'From the source', bg: p.surfaceMuted, fg: p.inkSoft, Icon: null };
}

// The badge wording, shared with the top-stories list.
export function badgeLabel(card: BlurbCard): string {
  if (card.kind === 'data') return 'New data';
  return card.ai.generated ? '' : 'From the source';
}

// Summary cards: Agency / Type / Published, only the ones we have.
function factsFor(card: BlurbCard): { label: string; value: string }[] {
  if (card.kind !== 'summary') return [];
  const src = primarySource(card);
  if (!src) return [];
  const out: { label: string; value: string }[] = [];
  out.push({ label: src.kind === 'news' ? 'Source' : 'Agency', value: src.name });
  const type = src.doc_label ?? eventLabel(card.event_type);
  if (type) out.push({ label: 'Type', value: type });
  out.push({ label: 'Published', value: cardTime(card) });
  return out;
}

// "World Â· 2 h ago", or "Recalls & Safety Â· Recall Â· 2 h ago" when the event adds something.
function metaLine(card: BlurbCard, categories: Category[], timeLabel?: 'added'): string {
  const category = categoryName(card.category, categories);
  if (card.kind === 'link_out') return [category, linkOutDelay(card.freshness?.delayed_hours)].filter(Boolean).join(' · ');
  const event = eventLabel(card.event_type);
  const parts = [category];
  if (event && !category.toLowerCase().includes(event.toLowerCase())) parts.push(event);
  // Same label the detail sheet shows (lib/format cardTime), so the two never disagree.
  parts.push(timeLabel === 'added' ? addedLabel(card) || cardTime(card) : cardTime(card));
  return parts.join(' · ');
}

export function Card(props: Props) {
  const { card, timeLabel, config, categories, onShowSources, onOpenDetail, onNext, wide, compact, peek, reaction, onReact, onMore, followedTopic, onToggleTopicFollow } = props;
  const p = usePalette();
  const pressStart = useRef<{ point: PointerPoint | null; at: number } | null>(null);
  const recordPressStart = (x?: number, y?: number) => {
    pressStart.current = { point: Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null, at: Date.now() };
  };
  const detailPressIn = (event: { nativeEvent: { pageX?: number; pageY?: number } }) =>
    recordPressStart(event.nativeEvent.pageX, event.nativeEvent.pageY);
  const detailMouseDown = (event: { pageX: number; pageY: number }) => recordPressStart(event.pageX, event.pageY);
  const openDetailFromPress = (event: { nativeEvent: { pageX?: number; pageY?: number } }) => {
    const start = pressStart.current;
    pressStart.current = null;
    const up = Number.isFinite(event.nativeEvent.pageX) && Number.isFinite(event.nativeEvent.pageY)
      ? { x: event.nativeEvent.pageX!, y: event.nativeEvent.pageY! }
      : null;
    const duration = start ? Date.now() - start.at : 0;
    if (wasCardSwiped(card.id)) return;
    if (shouldOpenDetail(start?.point ?? null, up, duration, msSinceSwipeEnd())) onOpenDetail?.(card);
  };
  const labels = cardLabels(card, config);
  const credit = shareAlikeCredit(card, config);
  const badge = badgeFor(card, p);
  const reactFn = typeof onReact === 'function' ? onReact : undefined;
  const linkOut = card.kind === 'link_out';
  // The disclaimer lands in exactly one slot (footer line on wide, under the card on phones).
  const small = footerLabels(linkOut ? null : labels.aiLabel, disclaimerText({ disclaimer: labels.disclaimer }), !!wide);

  const hasDetail = !linkOut && cardDetail(card) !== null;
  const opensDetail = !!onOpenDetail && hasDetail;
  // A malformed ticker from the server is skipped, not shown as an empty chip.
  const validTickers = card.tickers.filter((t) => t && typeof t.symbol === 'string' && t.symbol !== '');
  // Design size is 28 on phones (48 on wide); long headlines and short screens step down.
  // A narrow wide column (small desktop window) steps the wide headline down too.
  // A short desktop window (card under 660 px tall) tightens padding, gaps and type so
  // the sources, labels and disclaimer still fit without scrolling.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const tight = !!wide && box.h > 0 && box.h < 660;
  const wideSize = tight ? 40 : box.w > 0 && box.w < 600 ? 38 : card.headline.length > 80 ? 42 : 48;
  // Feed-Data / Feed-LinkOut drafts: data and link-out cards get 24 px padding, 16 px
  // gaps and a 32 px headline on phones (summary cards keep Mobile-Final's 20 / 14 / 28).
  const roomy = !wide && !compact && card.kind !== 'summary';
  const phoneSize = compact ? 24 : card.headline.length > 80 ? (roomy ? 28 : 26) : roomy ? 32 : 28;
  const headlineSize = wide ? wideSize : phoneSize;
  const headlineTrack = wide ? 0.025 : roomy ? 0.015 : 0.02;
  const headlineLead = wide ? 1.07 : linkOut ? 1.12 : 1.1;
  // Agency / Type / Published, on every layout (only the values we have).
  const facts = factsFor(card);

  // Share: system sheet or copy-link, with a short toast.
  const shareable = shareUrl(card.share_path, null) !== null;
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  const storyFollows = useFollowedStories();
  const storyFollowed = storyFollows.isFollowed(card.id);
  const onToggleStory = () => setToast(storyFollows.toggle(card.id, card) ? 'Following this story' : 'Stopped following this story');
  const onShare = () => {
    shareCard(card)
      .then(setToast)
      .catch(() => setToast('Could not share.'));
  };

  // Screen readers get the swipe reactions (and paging) as actions on the card body.
  const a11yActions = [
    ...(reactFn ? [{ name: 'like', label: 'Like' }, { name: 'dislike', label: 'Dislike' }] : []),
    ...(onNext ? [{ name: 'next', label: 'Next card' }] : []),
  ];
  const onA11yAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if ((name === 'like' || name === 'dislike') && reactFn) reactFn(card, name);
    else if (name === 'next') onNext?.();
  };

  const headline = (
    <Text
      numberOfLines={linkOut ? 6 : compact ? 3 : 4}
      style={[
        styles.headline,
        { color: p.ink, fontSize: headlineSize, lineHeight: headlineSize * headlineLead, letterSpacing: -headlineSize * headlineTrack, maxWidth: wide ? 820 : undefined },
      ]}
      accessibilityRole="header"
    >
      {/* link-out headlines are shown word for word (200-character cap, rule 7) */}
      {linkOut ? card.headline.slice(0, 200) : clampHeadline(card.headline)}
    </Text>
  );

  // Mobile-Final / Web-Final footer: small print on the left, a right-aligned row of
  // 44 px icon buttons (like, dislike, share). Wide web keeps its keyboard hint.
  const showNextHint = !!wide && !!onNext;
  const footer =
    small.footer || reactFn || shareable || showNextHint ? (
      <View style={[styles.footer, wide && styles.footerWide, compact && styles.footerCompact, { borderTopColor: p.divider }]}>
        <Text style={[styles.footerText, wide && { fontSize: 13 }, compact && styles.footerTextCompact, { color: p.muted }]}>{small.footer ?? ''}</Text>
        <View style={[styles.actions, (wide || compact) && { gap: compact ? 0 : 4 }]}>
          {reactFn ? (
            <>
              <ReactButton kind="like" on={reaction === 'like'} onPress={() => reactFn(card, 'like')} />
              <ReactButton kind="dislike" on={reaction === 'dislike'} onPress={() => reactFn(card, 'dislike')} />
            </>
          ) : null}
          <Pressable
            onPress={onToggleStory}
            accessibilityRole="button"
            accessibilityLabel={storyFollowed ? 'Following this story, double tap to stop' : 'Follow this story'}
            {...tip(storyFollowed ? 'Following this story (click to stop)' : 'Follow this story')}
            accessibilityState={{ selected: storyFollowed }}
            aria-pressed={storyFollowed}
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <PulseIcon color={storyFollowed ? p.accent : p.ink} size={22} />
          </Pressable>
          {shareable ? (
            <Pressable
              onPress={onShare}
              accessibilityRole="button"
              accessibilityLabel="Share"
              {...tip('Share this story')}
              style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <ShareIcon color={p.ink} size={22} />
            </Pressable>
          ) : null}
        </View>
        {showNextHint ? (
          <Pressable onPress={onNext} accessibilityRole="button" accessibilityLabel="Next card" style={styles.next}>
            <Text style={[styles.nextText, { fontSize: 14 }, { color: p.muted }]}>Next: press ↓ or scroll</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null;

  const src = primarySource(card);
  return (
    <View style={styles.wrap}>
      <View
        onLayout={wide ? (e) => setBox({ w: Math.round(e.nativeEvent.layout.width), h: Math.round(e.nativeEvent.layout.height) }) : undefined}
        style={[styles.card, wide && styles.cardWide, tight && styles.cardTight, compact && styles.cardCompact, roomy && styles.cardRoomy, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <View style={styles.meta}>
          {badge.text ? (
            <View style={[styles.badge, { backgroundColor: badge.bg }]}>
              {badge.Icon ? <badge.Icon color={badge.fg} size={14} /> : null}
              <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.text}</Text>
            </View>
          ) : (
            <View />
          )}
          <View style={styles.metaRight}>
            {/* No "Updated" badge: every rewrite pass sets updated_at, so it said nothing (audit C1). */}
            <Text style={[styles.metaText, wide && { fontSize: 14 }, { color: p.muted }]}>{metaLine(card, categories, timeLabel)}</Text>
            {onMore ? (
              <Pressable onPress={() => onMore(card)} accessibilityRole="button" accessibilityLabel="More options for this card" style={styles.moreBtn}>
                <Text style={[styles.moreDots, { color: p.muted }]}>⋯</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {linkOut ? (
          <>
            {src ? <Text style={[styles.publisher, { color: p.inkSoft }]}>{src.name}</Text> : null}
            {headline}
            <View style={styles.spacer} />
            {src ? (
              <Pressable
                onPress={() => openUrl(src.url, card.id)}
                accessibilityRole="link"
                accessibilityLabel={`Read on the publisher's site, ${src.name}. Opens the original.`}
                style={({ pressed }) => [styles.readBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
              >
                <Text style={[styles.readText, { color: p.onAccent }]}>Read on the publisher&apos;s site</Text>
                <ExternalIcon color={p.onAccent} />
              </Pressable>
            ) : null}
            <Text style={[styles.footerText, styles.linkOutCredit, { color: p.muted }]}>
              {linkOutCredit(card.attribution)} · Headline and link only; Element adds no summary here.
            </Text>
          </>
        ) : (
          <>
            {/* Only this middle part may shrink (and clip); the source row and footer below
                never do, so they are always visible. Tapping it opens the detail sheet, but
                only when the card has detail. The hint is part of the label because
                react-native-web drops accessibilityHint. */}
            <ScrollView
              style={styles.middleScroll}
              contentContainerStyle={[styles.middleContent, compact && styles.middleContentCompact]}
              scrollEnabled={!!compact}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
            <Pressable
              onPress={opensDetail ? openDetailFromPress : undefined}
              onPressIn={opensDetail ? detailPressIn : undefined}
              onTouchStart={opensDetail ? detailPressIn : undefined}
              {...(Platform.OS === 'web' ? { onMouseDown: detailMouseDown } as any : {})}
              disabled={!opensDetail && a11yActions.length === 0}
              accessible={opensDetail || a11yActions.length > 0}
              accessibilityRole={opensDetail ? 'button' : undefined}
              accessibilityLabel={opensDetail ? `${card.headline}. ${OPEN_DETAIL_HINT}` : a11yActions.length > 0 ? card.headline : undefined}
              accessibilityActions={a11yActions.length > 0 ? a11yActions : undefined}
              onAccessibilityAction={a11yActions.length > 0 ? onA11yAction : undefined}
              style={[styles.middlePressable, wide && { gap: tight ? 12 : 20 }, compact && { gap: 8 }, roomy && { gap: 16 }]}
            >
              {headline}

              {card.kind === 'data' ? <DataFacts card={card} config={config} compact={compact} /> : null}

              {/* On phones a two-number data card has no room for its template sentence, which only
                  restates the numbers; it stays readable in the detail sheet. */}
              {card.body && !(card.kind === 'data' && card.macro.length > 1 && !wide) ? (
                <Text
                  numberOfLines={wide ? undefined : compact ? undefined : 8}
                  style={[
                    styles.body,
                    wide && styles.bodyWide,
                    tight && { fontSize: 18, lineHeight: 27 },
                    compact && styles.bodyCompact,
                    roomy && card.kind === 'data' && styles.bodyData,
                    { color: card.kind === 'data' ? p.inkBody : p.inkSoft },
                  ]}
                >
                  {card.body}
                </Text>
              ) : null}

              {wide && facts.length > 0 ? (
                <View style={[styles.facts, wide && styles.factsWide, compact && styles.factsCompact, { borderColor: p.divider }]}>
                  {facts.map((f) => (
                    <View key={f.label} style={styles.fact}>
                      <Text style={[styles.factLabel, wide && { fontSize: 12 }, { color: p.muted }]}>{f.label}</Text>
                      <Text style={[styles.factValue, wide && { fontSize: 16 }, { color: p.ink }]} numberOfLines={1}>
                        {f.value}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {validTickers.length > 0 ? (
                <View style={styles.tickers}>
                  {validTickers.map((t, i) => (
                    <Text
                      key={`${t.symbol}-${i}`}
                      style={[styles.ticker, { color: p.inkSoft, borderColor: p.borderStrong }]}
                      accessibilityLabel={`${t.name}, ticker ${t.symbol}`}
                    >
                      {t.symbol}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Pressable>
            </ScrollView>

            {/* empty space collects here, so the sources and footer sit at the bottom */}
            <View style={styles.spacer} />

            <View style={styles.sourceBlock}>
              {opensDetail ? (
                <Pressable onPress={openDetailFromPress} onPressIn={detailPressIn} onTouchStart={detailPressIn} {...(Platform.OS === 'web' ? { onMouseDown: detailMouseDown } as any : {})} accessibilityRole="button" accessibilityLabel={`More detail. ${OPEN_DETAIL_HINT}`} style={styles.more}>
                  <Text style={[styles.moreText, { color: p.accentInk }]}>More detail ›</Text>
                </Pressable>
              ) : null}
              <SourceRow card={card} onShowAll={() => onShowSources(card)} wide={wide} />
              {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
            </View>
          </>
        )}

        {footer}
      </View>
      {toast ? (
        <View style={styles.toastDock} pointerEvents="none">
          <Text style={[styles.toast, { backgroundColor: p.ink, color: p.bg }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
            {toast}
          </Text>
        </View>
      ) : null}
      {/* the edge of the next card peeking out below, as in the design (phone layout only) */}
      {wide ? null : <View style={[styles.stack, { backgroundColor: p.surface, borderColor: p.border, opacity: peek ? 1 : 0 }]} />}
      {small.below ? (
        <View style={styles.below}>
          <Disclaimer text={small.below} center />
        </View>
      ) : null}
    </View>
  );
}

// "More like this" / "Less like this" as 44 px icon buttons. Pressed state = tinted
// circle + outline + check mark + aria-pressed, never colour alone. Pressing again undoes it.
function ReactButton({ kind, on, onPress }: { kind: Feedback; on: boolean; onPress: () => void }) {
  const p = usePalette();
  const like = kind === 'like';
  const Icon = like ? ThumbUpIcon : ThumbDownIcon;
  const color = on ? p.accentInk : p.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={like ? 'More like this' : 'Less like this'}
      {...tip(like ? 'Like this story' : 'Dislike this story')}
      aria-pressed={on}
      style={({ pressed }) => [
        styles.react,
        { borderColor: on ? p.accent : 'transparent', backgroundColor: on ? p.accentSoft : 'transparent', opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Icon color={color} size={on ? 18 : 22} />
      {on ? <Text style={[styles.reactCheck, { color }]}>✓</Text> : null}
    </Pressable>
  );
}

// Tap targets are real 44 px boxes: react-native-web's Pressable ignores hitSlop. The negative
// margins hand the extra height back to the layout, so compact cards still fit.
const styles = StyleSheet.create({
  wrap: { flex: 1 },
  card: { flex: 1, borderWidth: 1, borderRadius: radius.card, padding: 20, gap: 14, overflow: 'hidden' },
  cardCompact: { padding: 16, gap: 10 }, // short screens: less air so the body text still fits
  cardRoomy: { padding: 24, gap: 16 }, // phone data and link-out cards (Feed-Data / Feed-LinkOut)
  cardTight: { paddingVertical: 26, paddingHorizontal: 36, gap: 12 },
  cardWide: { paddingVertical: 40, paddingHorizontal: 44, gap: 20 },
  stack: { height: 10, marginHorizontal: 28, borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  below: { paddingTop: 6, paddingHorizontal: 4 },
  meta: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' },
  moreBtn: { minWidth: 44, minHeight: 44, marginVertical: -8, marginHorizontal: -6, alignItems: 'center', justifyContent: 'center' },
  moreDots: { fontSize: 20, lineHeight: 22 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  badgeText: { fontFamily: fonts.sansSemi, fontSize: 13 },
  metaText: { fontFamily: fonts.sans, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  headline: { fontFamily: fonts.serif },
  body: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 },
  bodyWide: { fontSize: 20, lineHeight: 31, maxWidth: 720 },
  bodyCompact: { fontSize: 15, lineHeight: 21 },
  bodyData: { fontSize: 18, lineHeight: 27 }, // Feed-Data body
  factsCompact: { paddingVertical: 8 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1 },
  factsWide: { columnGap: 28, rowGap: 10, paddingVertical: 14 },
  fact: { gap: 2, flexShrink: 1 },
  factLabel: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.33, textTransform: 'uppercase' },
  factValue: { fontFamily: fonts.sansSemi, fontSize: 15 },
  tickers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ticker: { fontFamily: fonts.sansMedium, fontSize: 13, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 3 },
  middleScroll: { flexShrink: 1, minHeight: 0 },
  middleContent: { flexGrow: 1 },
  middleContentCompact: { gap: 8 },
  middlePressable: { gap: 14 },
  spacer: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0 },
  more: { alignSelf: 'flex-start', minHeight: 44, marginTop: -8, marginBottom: -6, justifyContent: 'center' },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  sourceBlock: { gap: 8, flexShrink: 0 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTopWidth: 1, paddingTop: 6, marginHorizontal: -8, paddingLeft: 8, flexShrink: 0 },
  footerWide: { borderTopWidth: 0, paddingTop: 0, gap: 12, marginHorizontal: 0, paddingLeft: 0 },
  footerCompact: { flexDirection: 'column', alignItems: 'stretch', gap: 0, paddingTop: 4 },
  footerTextCompact: { flex: 0, width: '100%', fontSize: 12, lineHeight: 15 },
  aboutBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  footerText: { flex: 1, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  linkOutCredit: { flex: 0, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { width: 44, height: 44, marginVertical: -2, alignItems: 'center', justifyContent: 'center' },
  react: { flexDirection: 'row', width: 44, height: 44, marginVertical: -2, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 1 },
  reactCheck: { fontFamily: fonts.sansSemi, fontSize: 12 },
  next: { minHeight: 44, marginVertical: -2, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  nextText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  toastDock: { position: 'absolute', left: 0, right: 0, bottom: 72, alignItems: 'center', paddingHorizontal: 24 },
  toast: { fontFamily: fonts.sansMedium, fontSize: 14, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12, overflow: 'hidden' },
  publisher: { fontFamily: fonts.sansSemi, fontSize: 15 },
  readBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 52, borderRadius: radius.md },
  readText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
