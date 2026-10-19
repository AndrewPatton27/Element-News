// Shared page wrapper for the new screens (Brief, Search, Following, Me, ...).
// Sits inside Shell, so it gets the safe area, the SAMPLE DATA banner, the bottom
// tab bar (phones) and the top bar + Numbers strip (wide web) for free.
// Phones (design Mobile-Following): a 56 px header with the wordmark on the left
// and the page title on the right, then a scrolling body (16 px sides).
// Wide web (design Web-Following): a centred column, max 1000 px, with a 44 px
// serif title row (optional meta text on the right) and 22 px between sections.

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, font, space, MOBILE_HEADER_HEIGHT, PAGE_MAX_WIDTH } from '../../lib/theme/theme';
import { ChevronLeftIcon, CloseIcon } from './Icons';
import { Shell, Wordmark } from './Shell';
import type { Tab } from './TabBar';

export interface ScreenShellProps {
  tab: Tab; // which tab lights up
  title: string;
  meta?: string; // short text beside the title, e.g. "3 stories · 2 updated"
  headerRight?: ReactNode; // replaces meta (e.g. a button)
  scroll?: boolean; // default true; false lets the screen manage its own scrolling list
  // Phone header only (Mobile-About / SignIn / CreateAccount): a back arrow, a close X, the title
  // in the wordmark style (About), or no title at all (the page has its own heading).
  onBack?: () => void;
  backLabel?: string;
  onClose?: () => void;
  brandTitle?: boolean;
  hideTitle?: boolean;
  children: ReactNode;
}

export function ScreenShell({ tab, title, meta, headerRight, scroll = true, onBack, backLabel = 'Back', onClose, brandTitle, hideTitle, children }: ScreenShellProps) {
  const p = usePalette();
  const wide = useWide();

  const right = headerRight ?? (meta ? <Text style={[styles.meta, { color: p.muted }]}>{meta}</Text> : null);

  if (wide) {
    const titleRow = (
      <View style={styles.titleRowWide}>
        <Text accessibilityRole="header" style={[styles.titleWide, { color: p.ink }]}>
          {title}
        </Text>
        {right}
      </View>
    );
    return (
      <Shell active={tab} bare>
        {scroll ? (
          <ScrollView style={styles.fill} contentContainerStyle={styles.columnWide}>
            {titleRow}
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.fill, styles.columnWide]}>
            {titleRow}
            {children}
          </View>
        )}
      </Shell>
    );
  }

  return (
    <Shell active={tab} bare noFab={Boolean(onClose)}>
      <View
        style={[
          styles.header,
          onBack && { paddingLeft: 8 },
          onClose && { paddingRight: 8 },
          { backgroundColor: p.surface, borderBottomColor: p.border },
        ]}
      >
        <View style={styles.headerLeft}>
          {onBack ? (
            <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={backLabel} style={styles.iconBtn}>
              <ChevronLeftIcon color={p.ink} size={22} strokeWidth={2} />
            </Pressable>
          ) : null}
          {brandTitle ? <Wordmark size={font.headerWordmark} text={title} /> : <Wordmark size={font.headerWordmark} />}
        </View>
        {brandTitle || hideTitle ? null : (
          <Text accessibilityRole="header" style={[styles.titleNarrow, { color: p.ink }]} numberOfLines={1}>
            {title}
          </Text>
        )}
        {onClose ? (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.iconBtn}>
            <CloseIcon color={p.ink} size={20} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
      {scroll ? (
        <ScrollView style={styles.fill} contentContainerStyle={styles.bodyNarrow}>
          {right ? <View style={styles.metaRowNarrow}>{right}</View> : null}
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, styles.bodyNarrow]}>
          {right ? <View style={styles.metaRowNarrow}>{right}</View> : null}
          {children}
        </View>
      )}
    </Shell>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    height: MOBILE_HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingLeft: 20,
    paddingRight: space.page,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleNarrow: { flexShrink: 1, fontSize: font.body, fontFamily: fonts.sansSemi },
  bodyNarrow: { paddingHorizontal: space.page, paddingTop: 14, paddingBottom: space.md, gap: 14 },
  metaRowNarrow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: space.xs },
  columnWide: {
    width: '100%',
    maxWidth: PAGE_MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.pageWide,
    paddingTop: space.pageTopWide,
    paddingBottom: space.pageBottomWide,
    gap: space.section,
  },
  titleRowWide: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.sm },
  titleWide: { fontFamily: fonts.serif, fontSize: font.pageTitle, letterSpacing: -0.88 },
  meta: { fontSize: font.nav, fontFamily: fonts.sans },
});
