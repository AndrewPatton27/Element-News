// One company in a list (Companies screen, Search's company row): name, ticker, sector/industry,
// recent card count, and a Follow pill (the same device follow list as Following). Tapping the
// row opens the company page. News only: no prices.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { cardCountText, companyCategoryLine, companyHref, type CompanySummary } from '../../lib/companies/companyLogic';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, radius } from '../../lib/theme/theme';
import { FollowPill } from '../following/FollowPill';

export function CompanyRow({ company, followed, onToggleFollow, showCategory = false, highlight = false }: {
  company: CompanySummary;
  followed: boolean;
  onToggleFollow: (ticker: string) => void;
  showCategory?: boolean; // sector name too (search rows; the Companies screen has sector headings)
  highlight?: boolean;    // the search row at the top
}) {
  const p = usePalette();
  const wide = useWide();
  const quiet = company.card_count === 0;
  const detail = [company.ticker, showCategory ? companyCategoryLine(company) : company.industry].filter(Boolean).join(' · ');
  return (
    <View style={[styles.row, highlight && styles.highlight, { borderColor: highlight ? p.accent : p.border, backgroundColor: p.surface }]}>
      <Pressable
        onPress={() => router.push(companyHref(company.ticker))}
        accessibilityRole="link"
        accessibilityLabel={`${company.name}, ticker ${company.ticker}. ${cardCountText(company)}. Opens the company page.`}
        style={({ pressed }) => [styles.main, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.name, wide && styles.nameWide, { color: p.ink }]} numberOfLines={1}>{company.short_name}</Text>
        <Text style={[styles.detail, { color: p.muted }]} numberOfLines={1}>{detail}</Text>
        <Text style={[styles.count, { color: quiet ? p.muted : p.accentInk }]}>{cardCountText(company)}</Text>
      </Pressable>
      <FollowPill topic={company.short_name} followed={followed} onPress={() => onToggleFollow(company.ticker)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: radius.tile, paddingVertical: 10, paddingHorizontal: 14 },
  highlight: { borderWidth: 2 },
  main: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', gap: 2 },
  name: { fontFamily: fonts.sansSemi, fontSize: 16 },
  nameWide: { fontSize: 17 },
  detail: { fontFamily: fonts.sans, fontSize: 13 },
  count: { fontFamily: fonts.sansMedium, fontSize: 13 },
});
