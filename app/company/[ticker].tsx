// One company's page (/company/AAPL): name, ticker, sector and industry, how many cards it had
// recently, a Follow pill (same device follow list as Following), then its cards newest first
// (api.company_cards, keyset paged). Cards carry their sources, AI label and disclaimer like every
// list. News only: no prices (rule 9).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { BlurbCard } from '../../contract/types.ts';
import { cardCountText, companyCategoryLine, normalizeCompanyTicker, type CompanySummary } from '../../lib/companies/companyLogic';
import { useAccount } from '../../lib/account/accountContext';
import { withoutHidden } from '../../lib/account/accountLogic';
import { withoutHiddenSources } from '../../lib/sources/sourceKeys';
import { useFollows } from '../../lib/following/useFollows';
import { usePagedCards } from '../../lib/feed/usePagedCards';
import { useAppData } from '../../lib/shared/appData';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { ScreenShell } from '../../components/shell/ScreenShell';
import { FollowingFeed } from '../../components/following/FollowingFeed';
import { FollowPill } from '../../components/following/FollowPill';
import { DetailSheet } from '../../components/card/DetailSheet';
import { SourcesSheet } from '../../components/card/SourcesSheet';

export default function CompanyScreen() {
  const p = usePalette();
  const wide = useWide();
  const params = useLocalSearchParams<{ ticker?: string }>();
  const ticker = normalizeCompanyTicker(Array.isArray(params.ticker) ? params.ticker[0] : params.ticker);
  const { api, config, categories } = useAppData();
  const acct = useAccount();
  const { follows, toggleTicker } = useFollows();
  const [company, setCompany] = useState<CompanySummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [sheetCard, setSheetCard] = useState<BlurbCard | null>(null);
  const [detailCard, setDetailCard] = useState<BlurbCard | null>(null);
  const { trackOpenDetail } = acct;
  useEffect(() => {
    if (detailCard && acct.user) trackOpenDetail(detailCard);
  }, [detailCard, acct.user, trackOpenDetail]);

  const hidden = acct.viewPrefs?.hidden ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? [];
  const visible = useCallback((cards: BlurbCard[]) => withoutHiddenSources(withoutHidden(cards, hidden), hiddenSources), [hidden, hiddenSources]);

  // The ticker on screen now: a first page that lands after the reader moved to another company
  // must not write the old company's header (P2-11). usePagedCards drops its cards by key.
  const tickerRef = useRef(ticker);
  tickerRef.current = ticker;
  useEffect(() => { setCompany(null); setMissing(false); }, [ticker]);
  const { state, loadMore, retry } = usePagedCards(
    ticker ? `company|${ticker}` : null,
    async (cursor, limit) => {
      const asked = ticker!;
      const page = await api.companies.cards(asked, cursor, limit);
      if (cursor === null && tickerRef.current === asked) {
        setCompany(page.company);
        setMissing(page.company === null);
      }
      return { items: page.items, next_cursor: page.next_cursor };
    },
    visible,
  );

  const back = () => (router.canGoBack() ? router.back() : router.navigate('/companies'));
  const title = company?.short_name ?? ticker ?? 'Company';
  const followed = !!ticker && follows.tickers.includes(ticker);

  if (!ticker || missing) {
    return (
      <ScreenShell tab="search" title="Company" onBack={back}>
        <View style={styles.state} accessibilityLiveRegion="polite">
          <Text style={[styles.head, { color: p.ink }]}>We could not find that company</Text>
          <Text style={[styles.help, { color: p.muted }]}>Element covers about 190 well-known US companies.</Text>
          <Pressable onPress={() => router.navigate('/companies')} accessibilityRole="link" style={[styles.button, { borderColor: p.borderStrong, backgroundColor: p.surface }]}>
            <Text style={{ color: p.ink, fontFamily: fonts.sansSemi, fontSize: 15 }}>Browse companies</Text>
          </Pressable>
        </View>
      </ScreenShell>
    );
  }

  return (
    // notice: the AI notice + disclaimer as the persistent line under the card area (rule 5, D-80), not a
    // footer after the list, which scrolled off screen for companies with many cards.
    <ScreenShell tab="search" title={title} meta={wide && company ? cardCountText(company) : undefined} onBack={back} notice>
      <View style={[styles.header, { borderColor: p.border, backgroundColor: p.surface }]}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={[styles.name, wide && styles.nameWide, { color: p.ink }]}>{company?.name ?? ticker}</Text>
          <Text style={[styles.sub, { color: p.muted }]}>
            {[ticker, company?.exchange, company ? companyCategoryLine(company) : null].filter(Boolean).join(' · ')}
          </Text>
          {company ? <Text style={[styles.sub, { color: p.accentInk }]}>{cardCountText(company)}</Text> : null}
        </View>
        <FollowPill topic={company?.short_name ?? ticker} followed={followed} onPress={() => toggleTicker(ticker)} />
      </View>
      <Text style={[styles.help, styles.left, { color: p.muted }]}>
        Cards about {company?.short_name ?? ticker}, newest first: SEC filings and news that names the company. Element shows news, not prices.
      </Text>
      <FollowingFeed
        items={visible(state.items)}
        state={state}
        config={config}
        categories={categories}
        reasonFor={() => null}
        onOpen={setDetailCard}
        onSources={setSheetCard}
        onMore={loadMore}
        onRetry={retry}
        empty={
          <View style={styles.state} accessibilityLiveRegion="polite">
            <Text style={[styles.head, { color: p.ink }]}>No cards yet</Text>
            <Text style={[styles.help, { color: p.muted }]}>
              Nothing about {company?.short_name ?? ticker} has been published recently.{followed ? ' New cards will show up on Following too.' : ' Follow it to see new cards on Following.'}
            </Text>
          </View>
        }
      />
      <SourcesSheet card={sheetCard} config={config} onClose={() => setSheetCard(null)} />
      <DetailSheet card={detailCard} config={config} categories={categories} onClose={() => setDetailCard(null)} />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radius.tile, paddingVertical: 14, paddingHorizontal: 18 },
  headerText: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 30 },
  nameWide: { fontSize: 34, lineHeight: 38 },
  sub: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
  state: { alignItems: 'center', gap: 10, paddingVertical: 36, paddingHorizontal: 16 },
  head: { fontFamily: fonts.serif, fontSize: 22, textAlign: 'center' },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 20, textAlign: 'center', maxWidth: 520 },
  left: { textAlign: 'left', paddingHorizontal: 4, maxWidth: 680 },
  button: { minHeight: 44, paddingHorizontal: 20, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
