// SEC 8-K page text for the AI: the primary document and, for an earnings filing (Item 2.02),
// the EX-99.1 press-release exhibit that holds the real figures.
// All requests go through the injected fetchText (the allowlist: www.sec.gov is a page host, same
// rate limiter and cache as every other page). A missing or failing exhibit never stops the card;
// the primary document alone is used and a line is logged.
// Inputs: a fetchText function, the 8-K RawItem and a log function.
// Outputs: plain text (exhibit first, then a capped slice of the primary document).

import { config } from './config.ts';
import { filingText, findExhibitUrl, findPrimaryDocUrl } from './sources/sec.ts';
import type { RawItem } from './types.ts';

type FetchText = (url: string, kind: 'page' | 'api', ttlMinutes: number) => Promise<string>;

/** true if the filing has an item (Item 2.02) whose press-release exhibit should be read. */
export function wantsExhibit(it: Pick<RawItem, 'items'>): boolean {
  const want = config.secExhibit.items as readonly string[];
  return (it.items ?? []).some((i) => want.includes(i.number));
}

/** Filing index -> primary document text, plus the EX-99.1 exhibit for earnings filings. */
export async function secFilingPageText(fetchText: FetchText, it: RawItem, log: (line: string) => void = () => {}): Promise<string> {
  const index = await fetchText(it.url, 'page', config.cacheTtlMinutes);
  const doc = findPrimaryDocUrl(index, it.url);
  const primary = doc ? filingText(await fetchText(doc, 'page', config.cacheTtlMinutes)) : '';
  if (!wantsExhibit(it)) return primary;
  const exhibitUrl = findExhibitUrl(index, it.url);
  if (!exhibitUrl) {
    log(`no EX-99.1 press release on the filing index (primary document only): ${it.title}`);
    return primary;
  }
  try {
    const exhibit = filingText(await fetchText(exhibitUrl, 'page', config.cacheTtlMinutes));   // capped like the primary document
    if (!exhibit) return primary;
    return [exhibit, primary.slice(0, config.secExhibit.primaryMaxChars)].filter(Boolean).join('\n\n');
  } catch (e) {
    log(`EX-99.1 press release unavailable (primary document only): ${it.title}: ${(e as Error).message}`);
    return primary;
  }
}
