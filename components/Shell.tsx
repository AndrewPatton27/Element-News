// Page frame shared by every screen. Phones: content, then the 5-tab bottom bar
// (Feed / Brief / Search / Following / Me; components/TabBar.tsx) and a round
// "About Element" info button floating above it. Numbers is reached from the ticker.
// Wide web: a 64 px top bar (wordmark, Trending / Latest / For you, Brief / Search /
// Following links, then the account entry: the Sign in pill when signed out, or in the
// same slot a pill with the reader's initial and short email that opens /account when
// signed in; no Me icon or Me/Numbers text links), a scrolling Numbers strip (tap =
// Numbers to know), then left categories, the main column and a right aside, with the
// round About button at the bottom left (design: docs/design/web/Web-Final.dc.html).
// The SAMPLE DATA banner sits on top in mock mode.

import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { APP_NAME } from '../lib/config';
import { useAppData } from '../lib/appData';
import { useAccount } from '../lib/accountContext';
import { accountInitial, shortEmail } from '../lib/accountLabel';
import type { FeedTab } from '../lib/feedLogic';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, font, TOP_BAR_HEIGHT } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { InfoIcon } from './Icons';
import { NumbersTicker } from './NumbersTicker';
import { SampleBanner } from './SampleBanner';
import { SortToggle } from './SortToggle';
import { go, TabBar, TopNavLinks, type Tab } from './TabBar';

export type { Tab } from './TabBar';

export function Wordmark({ size = 24, text = APP_NAME }: { size?: number; text?: string }) {
  const p = usePalette();
  const label = (
    <Text style={{ fontFamily: fonts.serif, fontSize: size, letterSpacing: -size * 0.01, color: p.accent }} accessibilityRole={text === APP_NAME ? undefined : 'header'}>
      {text}
    </Text>
  );
  // The Element name in the top left of every page takes you back to the feed.
  if (text !== APP_NAME) return label;
  return (
    <Pressable onPress={() => go('/')} accessibilityRole="link" accessibilityLabel={`${APP_NAME}, back to the feed`} hitSlop={8}>
      {label}
    </Pressable>
  );
}

// Right end of the wide top bar. Design Web-Final has only the "Sign in" pill (no Me or
// Numbers links). Signed out: the pill goes to /signin. Signed in: the same slot holds a
// pill with the reader's initial and short email that opens /account. There is no separate
// Me icon; the Me page is reached from this pill (signed in) or from About (signed out).
function AccountEntry({ active, p, email }: { active: Tab; p: Palette; email: string | null }) {
  const onAccount = active === 'me' || active === 'account';
  if (email !== null) {
    return (
      <Pressable
        onPress={() => go('/account')}
        accessibilityRole="link"
        accessibilityLabel={`Account, ${email || 'signed in'}`}
        style={({ pressed }) => [
          styles.pill,
          styles.accountPill,
          { backgroundColor: onAccount ? p.accentSoft : p.surface, borderColor: onAccount ? p.accent : p.borderStrong, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.initial, { backgroundColor: p.accent }]} accessible={false}>
          <Text style={{ color: p.onAccent, fontSize: 13, fontFamily: fonts.sansSemi }}>{accountInitial(email)}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: p.ink, fontSize: 15, fontFamily: fonts.sansSemi, maxWidth: 140 }}>
          {shortEmail(email)}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={() => go('/signin')}
      accessibilityRole="button"
      style={({ pressed }) => [styles.pill, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
    >
      <Text style={{ color: p.onAccent, fontSize: 15, fontFamily: fonts.sansSemi }}>Sign in</Text>
    </Pressable>
  );
}

// Wide only. Feed passes its tab state; on other screens the tabs go back to the feed.
function TopBar({ active, p, email, signedIn, feedTab }: { active: Tab; p: Palette; email: string | null; signedIn: boolean; feedTab?: ShellProps['feedTab'] }) {
  const onChange =
    feedTab?.onChange ?? ((m: FeedTab) => router.navigate({ pathname: '/', params: { tab: m, t: String(Date.now()) } } as never));
  // Laptops (about 1280 px): tighter gaps so the bar stays on one row, also with "Account".
  const narrow = useWindowDimensions().width < 1340;
  return (
    <View style={[styles.topBar, narrow && styles.topBarTight, { backgroundColor: p.surface, borderBottomColor: p.border }]}>
      <Pressable onPress={() => go('/')} accessibilityRole="link" accessibilityLabel={`${APP_NAME}, home`}>
        <Text style={[styles.wordmark, { color: p.accent }]}>{APP_NAME}</Text>
      </Pressable>
      <SortToggle mode={feedTab ? feedTab.mode : null} onChange={onChange} wide forYou={signedIn} />
      <View style={styles.spacer} />
      <TopNavLinks active={active} signedIn={signedIn} />
      <AccountEntry active={active} p={p} email={email} />
    </View>
  );
}

interface ShellProps {
  active: Tab;
  children: ReactNode;
  left?: ReactNode; // wide only: categories column
  aside?: ReactNode; // wide only: right column
  scroll?: boolean; // wrap content in a ScrollView (Numbers, About)
  noFab?: boolean; // phones: leave out the floating About button (sign-in pages)
  bare?: boolean; // children fill the area under the bars as-is (ScreenShell does its own layout)
  feedTab?: { mode: FeedTab; onChange: (m: FeedTab) => void }; // wide only: top bar tabs (feed screen)
}

export function Shell({ active, children, left, aside, scroll, bare, noFab, feedTab }: ShellProps) {
  const p = usePalette();
  const wide = useWide();
  const { api, config } = useAppData();
  const { user } = useAccount();
  const signedIn = user !== null;

  if (wide) {
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: p.bg }]}>
        {api.sample ? <SampleBanner /> : null}
        <TopBar active={active} p={p} email={user ? user.email : null} signedIn={signedIn} feedTab={feedTab} />
        <View style={[styles.strip, { backgroundColor: p.bg, borderBottomColor: p.border }]}>
          <NumbersTicker api={api} config={config} />
        </View>
        {bare ? (
          <View style={styles.fill}>{children}</View>
        ) : scroll ? (
          <ScrollView style={styles.fill} contentContainerStyle={styles.scrollWide}>
            {children}
          </ScrollView>
        ) : (
          <View style={styles.body}>
            {left ? (
              <ScrollView style={styles.left} contentContainerStyle={styles.leftContent}>
                {left}
              </ScrollView>
            ) : null}
            <View style={styles.main}>{children}</View>
            {aside ? (
              <ScrollView style={styles.aside} contentContainerStyle={styles.asideContent}>
                {aside}
              </ScrollView>
            ) : null}
          </View>
        )}
        {active !== 'about' ? (
          <Pressable
            onPress={() => go('/about')}
            accessibilityRole="link"
            accessibilityLabel="About Element"
            style={[styles.aboutFabWide, { backgroundColor: p.surface, borderColor: p.borderStrong }]}
          >
            <InfoIcon color={p.inkSoft} size={24} />
          </Pressable>
        ) : null}
      </SafeAreaView>
    );
  }

  const content =
    scroll && !bare ? (
      <ScrollView style={styles.fill} contentContainerStyle={styles.scrollNarrow}>
        {children}
      </ScrollView>
    ) : (
      <View style={styles.fill}>{children}</View>
    );
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: p.bg }]} edges={['top', 'bottom']}>
      {api.sample ? <SampleBanner /> : null}
      {content}
      <TabBar active={active} signedIn={signedIn} />
      {active !== 'about' && active !== 'feed' && !noFab ? (
        <Pressable
          onPress={() => go('/about')}
          accessibilityRole="link"
          accessibilityLabel="About Element"
          style={[styles.aboutFabNarrow, { backgroundColor: p.surface, borderColor: p.borderStrong }]}
        >
          <InfoIcon color={p.inkSoft} size={24} />
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const fabShadow = {
  shadowColor: '#14211C',
  shadowOpacity: 0.14,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 3,
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 28,
    rowGap: 8,
    paddingHorizontal: 32,
    minHeight: TOP_BAR_HEIGHT,
    borderBottomWidth: 1,
  },
  topBarTight: { columnGap: 16, paddingHorizontal: 24 },
  wordmark: { fontFamily: fonts.serif, fontSize: 26, letterSpacing: -0.26 },
  spacer: { flex: 1 },
  pill: { minHeight: 44, paddingHorizontal: 18, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  accountPill: { flexDirection: 'row', gap: 8, borderWidth: 1, paddingLeft: 8, paddingRight: 16 },
  initial: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  strip: { height: 44, borderBottomWidth: 1, justifyContent: 'center', overflow: 'hidden' },
  body: {
    flex: 1,
    width: '100%',
    maxWidth: 1360,
    alignSelf: 'center',
    flexDirection: 'row',
    paddingHorizontal: 32,
    paddingTop: 28,
    paddingBottom: 28,
    gap: 36,
  },
  left: { flexGrow: 0, flexShrink: 0, flexBasis: 180, width: 180 },
  leftContent: { paddingBottom: 90 },
  main: { flex: 1, minWidth: 0 },
  aside: { flexGrow: 0, flexShrink: 1, flexBasis: 340, maxWidth: 340, minWidth: 280 },
  asideContent: { paddingBottom: 90 },
  scrollWide: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 32, paddingTop: 28, paddingBottom: 100, gap: 16 },
  scrollNarrow: { padding: 20, paddingTop: 24, gap: 16 },
  // The floating About button: a round icon button (Web: 48 px, left 32 / bottom 28;
  // phones: 44 px, left 16, 51 px above the tab bar).
  aboutFabWide: {
    position: 'absolute',
    left: 32,
    bottom: 28,
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    ...fabShadow,
  },
  aboutFabNarrow: {
    position: 'absolute',
    left: 16,
    bottom: 116,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    ...fabShadow,
  },
});
