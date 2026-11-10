// Worst-case sample cards for stress-testing the card layout (break-ui pass, ui-polish-m8).
// Mock mode only: `?mock_data=worst` in the address swaps the first sample cards for versions
// with the longest realistic values the contract allows (90-character headlines, three numbers
// with long labels and different agencies, long source names, five tickers, long key points,
// one-word values) and the thinnest ones (a 2-word headline, no key points, no body).
// Never used with the real back end (lib/api/api.supabase.ts does not read it).

import type { BlurbCard, MacroFact } from '../../contract/types.ts';

export function wantsWorstCase(search: string | null = readSearch()): boolean {
  return /[?&]mock_data=worst(&|$)/.test(search ?? '');
}

function readSearch(): string | null {
  const loc = (globalThis as { location?: { search?: string } }).location;
  return typeof loc?.search === 'string' ? loc.search : null;
}

// 90 characters: the contract's cap for summary and data headlines.
const LONG_HEADLINE = 'Federal Reserve Bank of St. Louis revises household debt service ratio after benchmark rev';
const LONG_WORD = 'Northwind-Consolidated-Industries-Holdings';

function fact(base: MacroFact, over: Partial<MacroFact>): MacroFact {
  return { ...base, ...over };
}

export function worstCaseCards(cards: BlurbCard[]): BlurbCard[] {
  const data = cards.find((c) => c.kind === 'data' && c.macro.length > 0);
  const summary = cards.find((c) => c.kind === 'summary');
  if (!data || !summary) return cards;
  const m = data.macro[0];
  const worstData: BlurbCard = {
    ...data,
    id: `${data.id}-worst-data`,
    headline: LONG_HEADLINE.slice(0, 90),
    macro: [
      fact(m, { series_id: 'WORST1', label: '30-year fixed mortgage rate (Freddie Mac weekly)', value: '10,284.57', change: '+1,284.06 pts', direction: 'up', source_short: 'Freddie Mac via FRED' }),
      fact(m, { series_id: 'WORST2', label: 'Consumer price index, all urban consumers', value: '-12.4%', change: '-3.75%', direction: 'down', source_short: 'Bureau of Labor Statistics via FRED' }),
      fact(m, { series_id: 'WORST3', label: 'Unemployment rate', value: '4.1%', change: null, direction: null, period: 'Sep 2026', source_short: 'BLS' }),
    ],
  };
  const worstSummary: BlurbCard = {
    ...summary,
    id: `${summary.id}-worst-summary`,
    headline: `${LONG_WORD} files 8-K: chief executive and chief financial officer both resign`.slice(0, 90),
    body: `${LONG_WORD} said in a filing that its chief executive and its chief financial officer resigned on the same day, effective immediately. The board named an interim leader and said the search for permanent replacements would start this month, with a decision expected before the next earnings report.`,
    tickers: summary.tickers.length ? [...summary.tickers, ...summary.tickers, ...summary.tickers].slice(0, 5) : summary.tickers,
    sources: summary.sources.map((s, i) => (i === 0 ? { ...s, name: 'Securities and Exchange Commission (EDGAR full-text search)' } : s)),
    detail: {
      paragraphs: summary.detail?.paragraphs ?? [],
      key_points: [
        'Both the chief executive and the chief financial officer resigned on the same day, effective at once',
        'An interim leader was named by the board while a search for permanent replacements begins',
        'The company gave no reason for either departure in its filing with regulators',
        'A decision is expected before the next quarterly earnings report later this year',
      ],
    },
  };
  const thin: BlurbCard = { ...summary, id: `${summary.id}-worst-thin`, headline: 'Jo resigns', body: null, detail: null, tickers: [] };
  const rest = cards.filter((c) => c.id !== data.id && c.id !== summary.id);
  return [worstData, worstSummary, thin, ...rest];
}
