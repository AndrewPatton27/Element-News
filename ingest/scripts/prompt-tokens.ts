// Offline prompt-size estimate: prints the instruction size (no source text) of the saved sum-v6 prompts
// versus the current builder, as characters and estimated tokens. No network, no keys.
// Estimate = characters / CHARS_PER_TOKEN. The ratio was measured on real Gemini calls (usageMetadata):
// sum-v6 prompt 7,015 chars = 1,672 tokens (4.20), sum-v7 draft 12,995 chars = 3,061 tokens (4.24).
// Run: node --experimental-strip-types ingest/scripts/prompt-tokens.ts
// Inputs: ingest/test/fixtures/prompt-baseline/v6-*.txt and v6-schema.json (saved sum-v6 output), the three fixture items.
// Outputs: a table on stdout; `promptTokenReport()` for the test.

import { readFileSync } from 'node:fs';
import { buildPrompt, RESPONSE_SCHEMA } from '../src/summarizer/gemini.ts';
import { parseSec8kAtom, secEntryToItem, parseTickerExchangeJson } from '../src/sources/sec.ts';
import { fedItemToItem, parseRss } from '../src/sources/fed.ts';
import type { RawItem } from '../src/types.ts';

export const CHARS_PER_TOKEN = 4.2;
export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

const here = (p: string) => new URL(p, import.meta.url);
const fixture = (n: string) => readFileSync(here(`../src/fixtures/${n}`), 'utf8');

export interface PromptTokenRow { kind: string; v6Chars: number; v7Chars: number; v6Tokens: number; v7Tokens: number; delta: number }

/** One row per prompt kind (plain, earnings, safety), schema included in both columns. */
export function promptTokenReport(): PromptTokenRow[] {
  const tickers = parseTickerExchangeJson(fixture('sec-company-tickers-exchange.json'));
  const gopro = secEntryToItem(parseSec8kAtom(fixture('sec-8k-item-2.02.atom.xml'))[0], tickers)!;
  const fed = fedItemToItem(parseRss(fixture('fed-press-monetary.rss.xml'))[0]);
  const items: [string, RawItem][] = [['plain', fed], ['earnings', gopro], ['safety', { ...fed, category: 'safety' } as RawItem]];
  const v6Schema = readFileSync(here('../test/fixtures/prompt-baseline/v6-schema.json'), 'utf8').length;
  const v7Schema = JSON.stringify(RESPONSE_SCHEMA).length;
  return items.map(([kind, item]) => {
    const v6Chars = readFileSync(here(`../test/fixtures/prompt-baseline/v6-${kind}.txt`), 'utf8').length + v6Schema;
    const v7Chars = buildPrompt({ item, text: '' }).length + v7Schema;
    return { kind, v6Chars, v7Chars, v6Tokens: estimateTokens(v6Chars), v7Tokens: estimateTokens(v7Chars), delta: estimateTokens(v7Chars) - estimateTokens(v6Chars) };
  });
}

if (process.argv[1]?.includes('prompt-tokens')) {
  console.log('prompt tokens without source text (estimate = chars / 4.2, schema included)');
  console.log('kind      v6 chars  v7 chars  v6 tokens  v7 tokens  delta');
  for (const r of promptTokenReport()) {
    console.log(`${r.kind.padEnd(9)} ${String(r.v6Chars).padStart(8)}  ${String(r.v7Chars).padStart(8)}  ${String(r.v6Tokens).padStart(9)}  ${String(r.v7Tokens).padStart(9)}  ${String(r.delta).padStart(5)}`);
  }
}
