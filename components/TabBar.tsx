// The five main places (design: docs/design/mobile/Mobile-Final.dc.html nav):
// Feed / Brief / Search / Following / Me. Phones show them as the bottom bar
// (TabBar). Wide web shows only Brief / Search / Following as top-bar links
// (TopNavLinks, design Web-Final); Feed and Me live elsewhere there (see below).
// Me opens /account on phones, signed in or not (guests get device settings).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { usePalette } from '../lib/useTheme';
import { fonts, font, TAB_BAR_MIN_HEIGHT, TOP_BAR_HEIGHT } from '../lib/theme';
import { BriefIcon, FeedIcon, PersonIcon, PulseIcon, SearchIcon } from './Icons';

// Which screen is showing. numbers and about are not tabs (no tab lights up);
// account is the signed-in "Me" page.
export type Tab = 'feed' | 'brief' | 'search' | 'following' | 'me' | 'numbers' | 'about' | 'account';
export type MainTab = 'feed' | 'brief' | 'search' | 'following' | 'me';

export type Href = '/' | '/brief' | '/search' | '/following' | '/numbers' | '/about' | '/account' | '/signin';

interface MainItem {
  key: MainTab;
  label: string;
  href: Href;
  Icon: typeof FeedIcon;
}

export function mainTabs(signedIn: boolean): MainItem[] {
  return [
    { key: 'feed', label: 'Feed', href: '/', Icon: FeedIcon },
    { key: 'brief', label: 'Brief', href: '/brief', Icon: BriefIcon },
    { key: 'search', label: 'Search', href: '/search', Icon: SearchIcon },
    { key: 'following', label: 'Following', href: '/following', Icon: PulseIcon },
    { key: 'me', label: 'Me', href: '/account', Icon: PersonIcon },
  ];
}

// The tab to light up for a screen (null: none, e.g. Numbers and About).
export function mainTabFor(active: Tab): MainTab | null {
  if (active === 'account' || active === 'me') return 'me';
  if (active === 'numbers' || active === 'about') return null;
  return active;
}

export function go(href: Href) {
  router.navigate(href as never); // typed routes regenerate on the next `expo start`
}

// Phones: the bottom bar.
export function TabBar({ active, signedIn }: { active: Tab; signedIn: boolean }) {
  const p = usePalette();
  const current = mainTabFor(active);
  return (
    <View
      style={[styles.bar, { backgroundColor: p.surface, borderTopColor: p.border }]}
      accessibilityRole="tablist"
      aria-label="Main"
    >
      {mainTabs(signedIn).map(({ key, label, href, Icon }) => {
        const on = key === current;
        const color = on ? p.accent : p.muted;
        return (
          <Pressable
            key={key}
            onPress={() => go(href)}
            accessibilityRole="tab"
            accessibilityLabel={label}
            aria-selected={on}
            style={styles.item}
          >
            <Icon color={color} strokeWidth={on ? 1.9 : 1.8} />
            <Text style={{ color, fontSize: font.small, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Wide web (design Web-Final "More" nav): Brief / Search / Following only. Feed is the
// wordmark and the Trending / Latest tabs; Me is the account entry on the right
// (AccountEntry in Shell.tsx); Numbers is the ticker strip. Underline on the current one.
export const WEB_LINK_KEYS: MainTab[] = ['brief', 'search', 'following'];

export function TopNavLinks({ active, signedIn }: { active: Tab; signedIn: boolean }) {
  const p = usePalette();
  const current = mainTabFor(active);
  return (
    <View style={styles.links} aria-label="More">
      {mainTabs(signedIn).filter((t) => WEB_LINK_KEYS.includes(t.key)).map(({ key, label, href }) => {
        const on = key === current;
        return (
          <Pressable
            key={key}
            onPress={() => go(href)}
            accessibilityRole="link"
            accessibilityState={{ selected: on }}
            style={[styles.link, { borderBottomColor: on ? p.accent : 'transparent' }]}
          >
            <Text style={{ color: on ? p.ink : p.muted, fontSize: font.nav, fontFamily: on ? fonts.sansSemi : fonts.sansMedium }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, paddingTop: 6, paddingBottom: 10, paddingHorizontal: 8 },
  item: { flex: 1, minHeight: TAB_BAR_MIN_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: 2 },
  links: { flexDirection: 'row', gap: 4 },
  link: { height: TOP_BAR_HEIGHT, paddingHorizontal: 12, justifyContent: 'center', borderBottomWidth: 3, borderTopWidth: 3, borderTopColor: 'transparent' },
});
