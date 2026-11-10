// Companies: browse the companies Element covers, grouped by sector, with each one's recent card
// count. Companies you follow come first (the same follow list as Following). A filter box narrows
// the list (ticker, name, typo-tolerant). Tapping a company opens its page (app/company/[ticker].tsx).
// News only: Element shows no prices.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { groupCompanies, type CompanySummary } from '../lib/companies/companyLogic';
import { useFollows } from '../lib/following/useFollows';
import { useAppData } from '../lib/shared/appData';
import { disclaimerText } from '../lib/shared/labels';
import { usePalette, useWide } from '../lib/theme/useTheme';
import { fonts, font } from '../lib/theme/theme';
import { ScreenShell } from '../components/shell/ScreenShell';
import { TopicChip } from '../components/feed/TopicPicker';
import { CompanyRow } from '../components/companies/CompanyRow';

export default function CompaniesScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config } = useAppData();
  const { follows, toggleTicker } = useFollows();
  const [list, setList] = useState<CompanySummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setList(null);
    api.companies.directory().then((l) => { setList(l); setFailed(l.length === 0); }, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  const withCards = (list ?? []).filter((c) => c.card_count > 0).length;
  // Show every company when none has recent cards (a new install), else only the ones with news.
  const onlyWithCards = !all && withCards > 0;
  const sections = useMemo(
    () => groupCompanies(list ?? [], follows.tickers, { onlyWithCards: onlyWithCards && !query.trim(), query }),
    [list, follows.tickers, onlyWithCards, query],
  );
  const days = list?.[0]?.days ?? 30;

  return (
    <ScreenShell tab="search" title="Companies" meta={wide && list ? `${list.length} companies` : undefined} onBack={() => (router.canGoBack() ? router.back() : router.navigate('/search'))}>
      <Text style={[styles.intro, wide && styles.introWide, { color: p.inkBody }]}>
        Cards grouped by the company they are about. Counts cover the last {days} days. Element shows news, not prices.
      </Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Filter by name or ticker"
        placeholderTextColor={p.muted}
        accessibilityLabel="Filter companies by name or ticker"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={40}
        style={[styles.input, { color: p.ink, borderColor: p.borderStrong, backgroundColor: p.surface }, { outlineStyle: 'none' } as object]}
      />
      {withCards > 0 && !query.trim() ? (
        <View style={styles.toggles} accessibilityRole="radiogroup">
          <TopicChip label="With recent cards" on={!all} onPress={() => setAll(false)} />
          <TopicChip label="All companies" on={all} onPress={() => setAll(true)} />
        </View>
      ) : null}

      {list === null && !failed ? (
        <View style={styles.state} accessibilityLiveRegion="polite"><ActivityIndicator color={p.accent} /><Text style={{ color: p.muted }}>Loading companies…</Text></View>
      ) : failed ? (
        <View style={styles.state} accessibilityRole="alert">
          <Text style={[styles.head, { color: p.ink }]}>Could not load companies</Text>
          <Pressable onPress={load} accessibilityRole="button" style={[styles.retry, { backgroundColor: p.accent }]}><Text style={{ color: p.onAccent, fontFamily: fonts.sansSemi }}>Try again</Text></Pressable>
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={[styles.head, { color: p.ink }]}>No company matches “{query.trim()}”</Text>
          <Text style={[styles.help, { color: p.muted }]}>Try a ticker like AAPL or a name like Costco.</Text>
        </View>
      ) : (
        sections.map((s) => (
          <View key={s.key} style={styles.section}>
            <Text accessibilityRole="header" aria-level={2} style={[styles.label, { color: p.muted }]}>{s.label} · {s.companies.length}</Text>
            <View style={[styles.grid, wide && styles.gridWide]}>
              {s.companies.map((c) => (
                <View key={c.ticker} style={wide ? styles.cellWide : undefined}>
                  <CompanyRow company={c} followed={follows.tickers.includes(c.ticker)} onToggleFollow={toggleTicker} />
                </View>
              ))}
            </View>
          </View>
        ))
      )}
      <Text style={[styles.footer, { color: p.muted }]}>{disclaimerText(config)}</Text>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 20, paddingHorizontal: 4 },
  introWide: { fontSize: font.body, lineHeight: 24, maxWidth: 680, paddingHorizontal: 0 },
  input: { height: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, fontFamily: fonts.sans, fontSize: 16 },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  section: { gap: 8 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 4, paddingTop: 6 },
  grid: { gap: 8 },
  gridWide: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  cellWide: { width: '49%' },
  state: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16 },
  head: { fontFamily: fonts.serif, fontSize: 22, textAlign: 'center' },
  help: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  retry: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, justifyContent: 'center' },
  footer: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingTop: 4 },
});
