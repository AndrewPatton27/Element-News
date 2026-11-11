// sum-v7 text checks for AI drafts (no network, no dependencies besides config):
//   style:         spelled-out dates, field labels and record dumps, doubled direction words, a headline that
//                  starts with a bare verb or ends in "...", "pts", label-style key points
//   speculation:   could / might / likely / expected to ... when the source text does not use the word
//   relative_time: today / yesterday / this week ... when the source text does not use the word
// All checks are single passes over the draft (O(draft size)). Template and data cards never come through here.
// Inputs: the draft parts and the licensed source text. Outputs: error strings (shown to the model on the retry).

import { config } from './config.ts';

export interface DraftParts {
  headline?: string | null;
  body?: string | null;
  paragraphs?: readonly string[];
  keyPoints?: readonly string[];
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty';
// "two thousand twenty-six", "November five". Month names are case-sensitive so the modal "may" cannot match.
const SPELLED_DATE = /\btwo thousand\b/i;
// A month and a number word that ends a clause ("November five, ...") is a spelled date; "in March two analysts" is not.
const SPELLED_MONTH_DATE = new RegExp(`\\b(?:${MONTHS})\\s+(?:${NUMBER_WORDS})(?=\\s*(?:[,.;]|$))`);
// "From:", "Published:", "Title:" and so on at the start of the text, a line or a sentence; "Filed with the SEC on" starting a sentence.
const FIELD_LABEL = /(?:^|\n|\.\s)(?:From|Published|Title|Company|Main topic):|(?:^|\n|\.\s)Filed with the SEC on\b/;
// "fell 18% down to", "rose 5% up by": one direction word is enough.
const DOUBLED_DIRECTION = /\b(?:fell|falls?|dropped|drops?|declined?|declines|decreased?|decreases|slid|slides?|sank|sinks?|rose|rises?|increased?|increases|climbed|climbs?|grew|grows?|jumped|jumps?|surged?|surges)\s+(?:\S+\s+){0,2}?(?:down|up)\s+(?:to|by)\b/i;
const BARE_VERB_HEADLINE = /^(?:Reports|Posts|Announces|Files|Says|Adopts)\b/;
const KEY_POINT_LABEL = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}):\s/;
const ATTRIBUTION_VERB = /\b(?:said|says|stated|states|added|noted|wrote|according)\b/i;

/** `style:` errors for a draft (card or detail). Empty list = fine. */
export function checkStyle(p: DraftParts): string[] {
  const errors: string[] = [];
  const headline = p.headline ?? '';
  const prose = [p.body ?? '', ...(p.paragraphs ?? [])].filter(Boolean);
  const keyPoints = p.keyPoints ?? [];
  const all = [headline, ...prose, ...keyPoints].filter(Boolean);

  if (all.some((t) => SPELLED_DATE.test(t) || SPELLED_MONTH_DATE.test(t))) errors.push('style: write dates and years with numerals (for example "Nov 5, 2026"), not in words');
  if ([...prose, ...keyPoints].some((t) => FIELD_LABEL.test(t))) errors.push('style: no field labels or record dumps ("From:", "Published:", "Title:", "Filed with the SEC on"); write sentences about what happened');
  for (const kp of keyPoints) {
    const m = KEY_POINT_LABEL.exec(kp);
    if (m && !ATTRIBUTION_VERB.test(m[1])) { errors.push(`style: key points are full sentences, not "Label: value" items ("${m[1]}:")`); break; }
  }
  if (all.some((t) => DOUBLED_DIRECTION.test(t))) errors.push('style: one direction word per change ("fell 18% to", never "fell 18% down to")');
  if (headline && BARE_VERB_HEADLINE.test(headline.trim())) errors.push('style: the headline must start with its subject (the company, agency or product), not a bare verb');
  if (/(?:\.\.\.|…)\s*$/.test(headline.trim())) errors.push('style: the headline must not end with "..." or cut a title short');
  if ([...prose, ...keyPoints].some((t) => /\.\.\.|…/.test(t))) errors.push('style: no "..." or cut-off titles');
  if (all.some((t) => /\bpts\b/i.test(t))) errors.push('style: write "percentage points", not "pts"');
  return errors;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

/** Does `text` contain this word or phrase (whole words)? `lowerOnly` skips capitalised forms ("May" the month vs "may"). */
function hasWord(text: string, phrase: string, lowerOnly: boolean): boolean {
  return new RegExp(`(?:^|[^A-Za-z])${esc(phrase)}(?=$|[^A-Za-z])`, lowerOnly ? '' : 'i').test(text);
}

/** Words in the draft that the source text does not use (shared by the speculation and relative-time checks). */
function wordsNotInSource(draftText: string, sourceText: string, list: readonly string[], skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const w of list) {
    if (skip.has(w)) continue;
    const lowerOnly = w === 'may';                           // "May" (the month) is not the modal verb
    if (hasWord(draftText, w, lowerOnly) && !hasWord(sourceText, w, lowerOnly)) out.push(w);
  }
  return out;
}

/** `speculation:` errors: could, might, likely, expected to ... that the source does not say itself. */
export function checkSpeculation(draftText: string, sourceText: string): string[] {
  return wordsNotInSource(draftText, sourceText, config.speculationWords, new Set()).map((w) => `speculation: "${w}" is not in the source; do not guess or predict`);
}

/** `relative_time:` errors: today, yesterday, this week ... that the source does not say itself. `allow` = the words a brief may use for its own span. */
export function checkRelativeTime(draftText: string, sourceText: string, allow: readonly string[] = []): string[] {
  return wordsNotInSource(draftText, sourceText, config.relativeTimeWords, new Set(allow)).map((w) => `relative_time: "${w}" is not in the source; use the dates or periods the source gives`);
}
