// Sources a signed-in reader can switch off. Mirrors core.source_keys and
// core.source_key_of in supabase/migrations/20261017070000_trending_foryou.sql:
// data cards are 'fred'; other cards use their primary source's name. Pure.

import type { BlurbCard } from '../contract/types.ts';

export interface SourceKey {
  key: string;
  name: string;
  matchNames: string[];
}

export const SOURCE_KEYS: SourceKey[] = [
  { key: 'sec', name: 'SEC filings', matchNames: ['SEC'] },
  { key: 'fed', name: 'Federal Reserve', matchNames: ['Federal Reserve Board'] },
  { key: 'bea', name: 'Bureau of Economic Analysis', matchNames: ['U.S. Bureau of Economic Analysis'] },
  { key: 'fred', name: 'Economic numbers (FRED)', matchNames: [] },
  { key: 'fedreg', name: 'Federal Register', matchNames: ['Federal Register'] },
  { key: 'wikipedia', name: 'Wikipedia', matchNames: ['Wikipedia'] },
  { key: 'cpsc', name: 'Product recalls (CPSC)', matchNames: ['U.S. Consumer Product Safety Commission'] },
  { key: 'usgs', name: 'Earthquakes (USGS)', matchNames: ['U.S. Geological Survey'] },
  { key: 'nasa', name: 'NASA', matchNames: ['NASA'] },
];

export function sourceName(key: string): string {
  return SOURCE_KEYS.find((s) => s.key === key)?.name ?? key;
}

// The card's source key, or null when its source can't be switched off.
export function cardSourceKey(card: Pick<BlurbCard, 'kind' | 'sources'>): string | null {
  if (card.kind === 'data') return 'fred';
  const ordered = [...card.sources].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  for (const s of ordered) {
    const hit = SOURCE_KEYS.find((k) => k.matchNames.includes(s.name));
    if (hit) return hit.key;
  }
  return null;
}

export function withoutHiddenSources<T extends Pick<BlurbCard, 'kind' | 'sources'>>(cards: T[], hiddenSources: string[]): T[] {
  if (hiddenSources.length === 0) return cards;
  return cards.filter((c) => {
    const k = cardSourceKey(c);
    return k === null || !hiddenSources.includes(k);
  });
}

// Turn one source on or off. At least one source must stay on: returns null when
// the change would switch off the last one.
export function toggleSource(hiddenSources: string[], key: string, allKeys: string[] = SOURCE_KEYS.map((s) => s.key)): string[] | null {
  if (hiddenSources.includes(key)) return hiddenSources.filter((k) => k !== key);
  const next = [...hiddenSources, key];
  return allKeys.every((k) => next.includes(k)) ? null : next;
}
