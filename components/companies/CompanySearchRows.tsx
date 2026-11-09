// Company rows for the top of the Search results ("Apple Inc. · AAPL · 12 cards"). Drop-in for the
// Search screen: <CompanySearchRows query={q} />. Asks api.companies.search once the query has
// settled (250 ms), shows exact ticker/name matches (else the best prefix or typo match), and
// nothing at all when no company matches, so text search stays as it is.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { companyRowsFor, type CompanySummary } from '../../lib/companies/companyLogic';
import { useFollows } from '../../lib/following/useFollows';
import { useAppData } from '../../lib/shared/appData';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { CompanyRow } from './CompanyRow';

export function useCompanySearch(query: string, delayMs = 250): CompanySummary[] {
  const { api } = useAppData();
  const [rows, setRows] = useState<CompanySummary[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setRows([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.companies.search(q, 5).then((r) => { if (alive) setRows(companyRowsFor(r)); }, () => { if (alive) setRows([]); });
    }, delayMs);
    return () => { alive = false; clearTimeout(t); };
  }, [api, query, delayMs]);
  return rows;
}

export function CompanySearchRows({ query }: { query: string }) {
  const p = usePalette();
  const rows = useCompanySearch(query);
  const { follows, toggleTicker } = useFollows();
  if (!rows.length) return null;
  return (
    <View style={styles.wrap} accessibilityLabel="Matching companies">
      <Text style={[styles.label, { color: p.muted }]}>{rows.length === 1 ? 'Company' : 'Companies'}</Text>
      {rows.map((c, i) => (
        <CompanyRow key={c.ticker} company={c} showCategory highlight={i === 0} followed={follows.tickers.includes(c.ticker)} onToggleFollow={toggleTicker} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
});
