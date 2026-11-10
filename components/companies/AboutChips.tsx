// "About: Apple" chips on a card: which companies the card is about (server tags, or the card's
// own tickers until they load). A chip opens that company's page. News only, no prices.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BlurbCard } from '../../contract/types.ts';
import { aboutChips, companyHref } from '../../lib/companies/companyLogic';
import { useCardCompanies } from '../../lib/companies/useCardCompanies';
import { useOptionalAppData } from '../../lib/shared/appData';
import { wasCardSwiped } from '../../lib/feed/swipeLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function AboutChips({ card, wide }: { card: BlurbCard; wide?: boolean }) {
  const p = usePalette();
  const data = useOptionalAppData();
  const tags = useCardCompanies(data?.api.companies, card.id);
  const chips = aboutChips(card, tags);
  if (!chips.length) return null;
  return (
    <View style={styles.row}>
      {chips.map((c) => (
        <Pressable
          key={c.ticker}
          onPress={() => {
            if (wasCardSwiped(card.id)) return;
            router.push(companyHref(c.ticker));
          }}
          accessibilityRole="link"
          accessibilityLabel={c.a11y}
          style={styles.hit}
        >
          {({ pressed }) => (
            // 44 px tap target around a 32 px pill (react-native-web ignores hitSlop)
            <View style={[styles.chip, { borderColor: p.borderStrong, backgroundColor: pressed ? p.surfaceMuted : 'transparent' }]}>
              <Text style={[styles.text, wide && styles.textWide, { color: p.inkSoft }]} numberOfLines={1}>
                {c.label}
              </Text>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6, marginVertical: -6 },
  hit: { minHeight: 44, justifyContent: 'center', maxWidth: 260 },
  chip: { minHeight: 32, justifyContent: 'center', borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, maxWidth: 260 },
  text: { fontFamily: fonts.sansMedium, fontSize: 13 },
  textWide: { fontSize: 14 },
});
