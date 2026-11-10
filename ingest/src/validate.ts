// Validates an AI (or template) draft before it can be published.
// A draft that fails is retried once with the errors, then replaced by a
// template card. Nothing here calls the network.
// Inputs: a draft (headline, body, detail, ...) and the licensed source text it came from.
// Outputs: { ok, errors } results, the license gate (assertSummarizable) and text helpers.

import { config } from './config.ts';
import { mentionsProductCodes } from './text.ts';
import { checkRelativeTime, checkSpeculation, checkStyle } from './styleChecks.ts';

/**
 * Categories the AI may choose (Gemini/Groq schema enum, SEC tiebreak). The original 9 business
 * slugs only, so an undecided 8-K can never land in world, science or safety.
 */
export const AI_CATEGORY_SLUGS = [
  'markets', 'earnings', 'economy', 'policy', 'tech', 'deals', 'energy', 'insider', 'personal-finance',
] as const;

/** Every publishable category (contract CategorySlug). New sources set world/science/safety in code. */
export const CATEGORY_SLUGS = [...AI_CATEGORY_SLUGS, 'world', 'science', 'safety'] as const;

/** License classes whose text may be sent to the AI in this build. cc_by_sa = Wikipedia (credit + license link). */
export const SUMMARIZABLE = ['public_domain', 'company_filing', 'cc_by_sa'] as const;

/** Thrown by assertSummarizable when text of this license class may not reach the AI. */
export class NotSummarizableError extends Error {
  constructor(licenseClass: string) {
    super(`license class "${licenseClass}" may not be summarized`);
    this.name = 'NotSummarizableError';
  }
}

/** Throws unless text with this license class may be sent to the AI. */
export function assertSummarizable(licenseClass: string): void {
  if (!(SUMMARIZABLE as readonly string[]).includes(licenseClass)) {
    throw new NotSummarizableError(licenseClass);
  }
}

/** Thrown by assertPaidKeyFor when Guardian-licensed text would reach an AI key that is not paid (rule 3). */
export class PaidKeyRequiredError extends Error {
  constructor(provider: string) {
    super(`${provider}: Guardian text may only be sent to a paid AI key`);
    this.name = 'PaidKeyRequiredError';
  }
}

/** True if the item's text is Guardian-licensed (by license class or source name). */
export function isGuardianText(item: { source?: string; license_class?: string }): boolean {
  return /guardian/i.test(String(item.license_class ?? '')) || /guardian/i.test(String(item.source ?? ''));
}

/**
 * CLAUDE.md rule 3: Guardian text only goes to the PAID Gemini key. Every AI summarize() calls this before
 * any request. (The license gate above already keeps Guardian out of this build; this is the second lock.)
 */
export function assertPaidKeyFor(item: { source?: string; license_class?: string }, provider: { name: string; paidKey?: boolean }): void {
  if (isGuardianText(item) && provider.paidKey !== true) throw new PaidKeyRequiredError(provider.name);
}

export interface Draft {
  headline: string;
  body: string | null;
  category: string;
  event_type: string | null;
  tickers: string[];
  everyday_relevance?: number | null;
  detail?: { paragraphs?: unknown; key_points?: unknown } | null;
}

export interface SourceText {
  text: string;                  // the licensed source text the draft was written from
  licenseClass: string;          // 'company_filing' | 'public_domain'
  tickers?: string[];            // tickers known from filing metadata
  category?: string;             // the card's real category in code (e.g. 'safety' for CPSC recalls)
  requireFigures?: boolean;      // the card's real event_type is earnings (set in code); default: draft.event_type === 'earnings'
  checkFlow?: boolean;           // AI drafts only (the chain sets it): run the repetition, style, speculation and relative-time checks. Template/data wording is fixed and exempt.
  headline?: string;             // the card headline (validateDetail with checkFlow: the detail must not restate it)
}

export interface Result {
  ok: boolean;
  errors: string[];
}

// ---- earnings figures -------------------------------------------------------------

/** true if the text has at least one digit (a figure: dollars, percent, per-share, a count). */
export const hasFigures = (body: string | null | undefined): boolean => /\d/.test(body ?? '');

/**
 * Must the card for this item state figures? Yes when its event_type is earnings (set in code from the
 * 8-K items). An SEC filing is held to it only when it has an Item in config.earningsFigures.requiredItems
 * (2.02, results of operations); an earnings card that comes only from 4.01 (auditor change) or 4.02
 * (restatement notice) has no results table to quote.
 */
export function requiresFigures(item: { source?: string; event_type?: string | null; items?: { number: string }[] }): boolean {
  if (item.event_type !== 'earnings') return false;
  if (item.source !== 'sec_8k') return true;
  const need = config.earningsFigures.requiredItems as readonly string[];
  return (item.items ?? []).some((i) => need.includes(i.number));
}

// ---- helpers -------------------------------------------------------------------

// Form names contain digits that are not facts ("8-K", "10-Q"); drop them before number checks.
const FORM_TOKENS = /\b(?:8-K|10-K|10-Q|20-F|6-K|S-1|S-4|13D|13G|DEF 14A|Form [345])\b/gi;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Every number in `text` as a normalized string ("1,200.50" -> "1200.5"); form names like "8-K" are ignored. */
export function extractNumbers(text: string): string[] {
  const cleaned = text.replace(FORM_TOKENS, ' ');
  const out: string[] = [];
  for (const m of cleaned.match(NUMBER) ?? []) {
    const n = Number(m.replace(/,/g, '').replace(/\.$/, ''));
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

/**
 * Numbers in `text` that the source does not have. Exact match first. Then, when config.numberScaleTolerance is on,
 * a figure written with a scale word ("1.5 billion") is accepted if the source has the same value one scale step
 * away ("1,500 million", or the reverse). Percent figures and figures without a scale word stay exact; nothing is rounded.
 */
export function missingNumbers(text: string, sourceText: string): string[] {
  const src = new Set(extractNumbers(sourceText));
  const cleaned = text.replace(FORM_TOKENS, ' ');
  const out: string[] = [];
  for (const m of cleaned.matchAll(NUMBER)) {
    const n = Number(m[0].replace(/,/g, '').replace(/\.$/, ''));
    if (!Number.isFinite(n) || src.has(String(n))) continue;
    if (config.numberScaleTolerance && /^\s*(?:million|billion|trillion|thousand)/i.test(cleaned.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14))) {
      const up = String(Number((n * 1000).toPrecision(12)));
      const down = String(Number((n / 1000).toPrecision(12)));
      if (src.has(up) || src.has(down)) continue;
    }
    out.push(String(n));
  }
  return out;
}

/** Lower-case word tokens for the copy check (keeps ' % $ . inside words, curly quotes normalized). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9'%$.]+/)
    .map((w) => w.replace(/^[.']+|[.']+$/g, ''))
    .filter(Boolean);
}

const isNumberToken = (w: string) => /^[$]?\d[\d,.]*%?$/.test(w);

/**
 * Longest run of consecutive words shared by `draft` and `source`.
 * Number tokens may sit inside a run but do not count toward its length.
 */
export function longestCopiedRun(draft: string, source: string, ignorePhrases: readonly string[] = []): number {
  let src = source.toLowerCase();
  for (const p of ignorePhrases) src = src.split(p.toLowerCase()).join(' | ');
  const a = words(draft);
  const b = words(src);
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + (isNumberToken(a[i - 1]) ? 0 : 1);
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Advice phrases found in `text`. For category 'safety' (CPSC recalls) the phrases in
 * config.safetyAdviceAllowlist (e.g. "should") are permitted, so a plain safety instruction
 * like "consumers should stop using the product" is allowed; investment advice (buy, sell,
 * price target, ...) is never in that allowlist, so it stays blocked on every category.
 */
export function findAdvice(
  text: string,
  category?: string,
  blocklist: readonly string[] = config.adviceBlocklist,
): string[] {
  const allowed = category === 'safety'
    ? new Set((config.safetyAdviceAllowlist as readonly string[]).map((p) => p.toLowerCase()))
    : new Set<string>();
  const hits: string[] = [];
  for (const phrase of blocklist) {
    if (allowed.has(phrase.toLowerCase())) continue;
    const ctx = config.adviceMarketContext[phrase.toLowerCase()];
    if (ctx && !ctx.test(text)) continue;                     // e.g. "missions to the Moon": blocked only in market talk
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`, 'i').test(text)) hits.push(phrase);
  }
  return hits;
}

/** 8-K item titles may be quoted verbatim; they do not count toward the copy limit. */
const ITEM_TITLES = [
  'Entry into a Material Definitive Agreement',
  'Termination of a Material Definitive Agreement',
  'Completion of Acquisition or Disposition of Assets',
  'Results of Operations and Financial Condition',
  'Costs Associated with Exit or Disposal Activities',
  'Material Impairments',
  'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing',
  'Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review',
  'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers',
  'Regulation FD Disclosure',
  'Other Events',
  'Financial Statements and Exhibits',
];

// ---- main checks -----------------------------------------------------------------

/** Parses model output text into a Draft-shaped object, or returns errors. */
export function parseDraft(raw: string): { draft: Draft | null; errors: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { draft: null, errors: ['output is not valid JSON'] };
  }
  const errors = checkShape(obj);
  return { draft: errors.length ? null : (obj as Draft), errors };
}

/** Shape checks for a draft: headline length, body word count, category slug, event_type, tickers. Returns errors. */
export function checkShape(obj: unknown): string[] {
  const e: string[] = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return ['output is not a JSON object'];
  const d = obj as Record<string, unknown>;
  if (typeof d.headline !== 'string' || d.headline.trim() === '') e.push('headline missing');
  else if (d.headline.length > config.headlineMaxChars) e.push(`headline longer than ${config.headlineMaxChars} chars (was ${d.headline.length})`);
  if (d.body !== null && typeof d.body !== 'string') e.push('body must be a string or null');
  else if (typeof d.body === 'string' && countWords(d.body) > config.bodyMaxWords) {
    e.push(`body longer than ${config.bodyMaxWords} words (was ${countWords(d.body)})`);
  }
  if (typeof d.category !== 'string' || !(AI_CATEGORY_SLUGS as readonly string[]).includes(d.category)) {
    e.push('category is not one of the 9 slugs');
  }
  if (d.event_type !== null && d.event_type !== undefined && typeof d.event_type !== 'string') {
    e.push('event_type must be a string or null');
  } else if (typeof d.event_type === 'string' && !config.aiEventTypes.includes(d.event_type)) {
    e.push(`event_type must be one of ${config.aiEventTypes.join(', ')} or null (was "${d.event_type.slice(0, 30)}")`);
  }
  if (!Array.isArray(d.tickers) || d.tickers.some((t) => typeof t !== 'string')) e.push('tickers must be an array of strings');
  else if (d.tickers.length > config.maxTickersPerCard) e.push(`more than ${config.maxTickersPerCard} tickers`);
  return e;
}

/**
 * everyday_relevance check: when present it must be a whole number from 1 to 5. AI drafts in the
 * pipeline must carry it (required = true); template drafts never do.
 */
export function checkRelevance(d: { everyday_relevance?: unknown }, required: boolean): string[] {
  const v = d.everyday_relevance;
  if (v === undefined || v === null) return required ? ['everyday_relevance missing (whole number 1-5)'] : [];
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? [] : ['everyday_relevance must be a whole number from 1 to 5'];
}

/** Number of whitespace-separated words (0 for blank text). */
export const countWords = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Validator errors that are only about length (the safety net in trimBodyToFit may fix the body one). */
const isLengthError = (e: string): boolean => /^(headline longer than|body longer than)/.test(e);

// A period after these is not a sentence end ("U.S.", "Inc.", "Jan.", "No. 5").
const ABBREV = /(?:\b[A-Z]\.)+$|\b(?:Inc|Corp|Co|Ltd|LLC|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|vs|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/;

/** Splits text into sentences on . ! ? followed by space; skips common abbreviations and decimals. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["'”’)]?(?=\s+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (ABBREV.test(text.slice(start, end))) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Deterministic safety net for a draft whose ONLY problem is length. Never cuts inside a
 * sentence and never touches the headline: a headline over the limit means reject (null).
 * Returns the draft with the body cut after the last whole sentence that fits, or null.
 */
export function trimBodyToFit(draft: Draft, errors: string[]): Draft | null {
  if (!errors.length || !errors.every(isLengthError)) return null;
  if (errors.some((e) => e.startsWith('headline'))) return null;
  if (typeof draft.body !== 'string') return null;
  const sentences = splitSentences(draft.body);
  const kept: string[] = [];
  for (const s of sentences) {
    if (countWords([...kept, s].join(' ')) > config.bodyMaxWords) break;
    kept.push(s);
  }
  if (!kept.length || kept.length === sentences.length) return null;
  const last = kept[kept.length - 1];
  if (!/[.!?]["'”’)]?$/.test(last)) return null;   // must end on a real sentence end
  return { ...draft, body: kept.join(' ') };
}

// ---- flow and no repetition (D-58) ---------------------------------------------------

const STOP_WORDS = new Set((
  'a an the and or but nor so yet for of in on at to by up as is are was were be been being am do does did done '
  + 'has have had having it its it\'s this that these those there here then than with without from into onto over under '
  + 'about after before during while until since also just only very more most much many some any each every other '
  + 'such not can could will would may might must shall should who whom whose which what when where why how all both '
  + 'one two now new said says say their they them his her him she he you your our out off too per via'
).split(/\s+/));

/** Crude stemmer so "rises/rose-like" forms of one word match ("taxes" ~ "tax", "raised" ~ "raise"). */
function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/**
 * The content words of a text for the repetition check: lower case, stop words, numbers and words
 * shorter than config.repetition.minWordLength dropped, the rest lightly stemmed. A set (each word once).
 */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9']+/)) {
    const w = raw.replace(/'s$/, '').replace(/^'+|'+$/g, '');
    if (w.length < config.repetition.minWordLength || /\d/.test(w) || STOP_WORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Share of `a`'s words that are also in `b` (0 when `a` is empty). */
function shareIn(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

/**
 * Flow check for an AI card (rules in .kiro/steering/element-cards.md, "Flow and no repetition"):
 *  (a) the first summary sentence must not restate the headline: it fails when it starts with the
 *      headline text, or when at least config.repetition.headlineOverlapMax of the headline's content
 *      words appear in it;
 *  (b) no two summary sentences may be near-duplicates: the shorter one's content words are at least
 *      config.repetition.sentenceOverlapMax inside the other.
 * Returns error strings (they are shown to the model on the retry), [] when the card reads well.
 * Template and data cards are never passed here (their fixed wording is exempt).
 */
export function checkRepetition(headline: string, body: string | null | undefined): string[] {
  const c = config.repetition;
  const sentences = splitSentences(body ?? '');
  if (!sentences.length) return [];
  const errors: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const h = plain(headline);
  const first = plain(sentences[0]);
  const hWords = contentWords(headline);
  const fWords = contentWords(sentences[0]);
  if (h.split(' ').length >= 3 && (first === h || first.startsWith(`${h} `))) {
    errors.push('repetition: the first summary sentence starts with the headline; begin with the next most useful fact instead');
  } else if (hWords.size >= c.minHeadlineWords) {
    const share = shareIn(hWords, fWords);
    if (share >= c.headlineOverlapMax) {
      errors.push(`repetition: the first summary sentence repeats the headline (${pct(share)} of its key words, limit ${pct(c.headlineOverlapMax)}); it must add the next most useful fact instead of restating it`);
    }
  }

  const sets = sentences.map(contentWords);
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const [small, big] = sets[i].size <= sets[j].size ? [sets[i], sets[j]] : [sets[j], sets[i]];
      if (small.size < c.minSentenceWords) continue;
      const share = shareIn(small, big);
      if (share >= c.sentenceOverlapMax) {
        errors.push(`repetition: summary sentences ${i + 1} and ${j + 1} say nearly the same thing (${pct(share)} shared key words, limit ${pct(c.sentenceOverlapMax)}); each sentence must add something new`);
      }
    }
  }
  return errors;
}

/**
 * Detail version of the flow check: the first sentence of paragraph 1 and key point 1 must not restate the headline
 * (same content-word share and "starts with" rules as the body), and no key point may repeat the headline's main
 * number without adding at least two new content words. Errors start with "detail repetition:".
 */
export function checkDetailRepetition(headline: string, detail: { paragraphs: string[]; key_points: string[] }): string[] {
  const c = config.repetition;
  const errors: string[] = [];
  const h = plain(headline);
  const hWords = contentWords(headline);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const probes: [string, string | undefined][] = [
    ['paragraph 1', splitSentences(detail.paragraphs[0] ?? '')[0]],
    ['key point 1', detail.key_points[0]],
  ];
  for (const [label, text] of probes) {
    if (!text) continue;
    const t = plain(text);
    if (h.split(' ').length >= 3 && (t === h || t.startsWith(`${h} `))) {
      errors.push(`detail repetition: ${label} starts with the headline; begin with the most useful fact not yet on the card`);
    } else if (hWords.size >= c.minHeadlineWords) {
      const share = shareIn(hWords, contentWords(text));
      if (share >= c.headlineOverlapMax) errors.push(`detail repetition: ${label} repeats the headline (${pct(share)} of its key words, limit ${pct(c.headlineOverlapMax)})`);
    }
  }
  const mainNumber = extractNumbers(headline)[0];
  if (mainNumber !== undefined) {
    for (const kp of detail.key_points) {
      if (!extractNumbers(kp).includes(mainNumber)) continue;
      const fresh = [...contentWords(kp)].filter((w) => !hWords.has(w)).length;
      if (fresh < 2) { errors.push(`detail repetition: a key point repeats the headline number ${mainNumber} without a new fact: "${kp.slice(0, 40)}"`); break; }
    }
  }
  return errors;
}

/** Full validation of a draft against the licensed source text it came from. */
export function validateDraft(draft: Draft, source: SourceText): Result {
  const errors = checkShape(draft);
  if (errors.length) return { ok: false, errors };

  const text = `${draft.headline}\n${draft.body ?? ''}`;

  // 1. no advice language. The safety relaxation keys on the card's real category (source.category,
  // set in code, e.g. 'safety' for CPSC); the AI draft category is only ever one of the 9 business
  // slugs, so draft.category is used only as a fallback when the source carries no category.
  const advice = findAdvice(text, source.category ?? draft.category);
  if (advice.length) errors.push(`advice language: ${advice.join(', ')}`);

  // A card with event_type earnings whose body has no digit is rejected (reason no_figures).
  // Items filed under 4.01 or 4.02 only are exempt (config.earningsFigures); the real event_type is
  // set in code (source.requireFigures), the draft's own event_type is the fallback for direct calls.
  if ((source.requireFigures ?? draft.event_type === 'earnings') && !hasFigures(draft.body)) {
    errors.push('no_figures: an earnings card must state real figures (a number from the source) in the body');
  }

  // 1a. flow: the summary continues the headline and no sentence repeats another (AI drafts only;
  // template wording is fixed, e.g. "X reports a change in its top leaders" / "X told the SEC about a change
  // among its top leaders", and would fail the headline-overlap test)
  if (source.checkFlow) {
    errors.push(...checkRepetition(draft.headline, draft.body));
    // 1a2. sum-v7: style (dates as numerals, no field labels, one direction word, subject-first headline, no "pts"),
    // no speculation and no relative time unless the source itself says it
    errors.push(...checkStyle({ headline: draft.headline, body: draft.body }));
    errors.push(...checkSpeculation(text, source.text), ...checkRelativeTime(text, source.text));
  }

  // 1b. no model numbers, SKUs, UPCs or lot numbers in the headline or summary (key points only)
  const codes = mentionsProductCodes(text);
  if (codes.length) errors.push(`product codes in headline or body (${codes.join(', ')}): model, SKU, UPC and lot numbers go in detail key points only`);

  // 2. every number must appear in the source
  const missing = missingNumbers(text, source.text);
  if (missing.length) errors.push(`numbers not in source: ${[...new Set(missing)].join(', ')}`);

  // 3. every ticker must appear in the source or its metadata
  const known = new Set((source.tickers ?? []).map((t) => t.toUpperCase()));
  for (const t of draft.tickers) {
    const sym = t.toUpperCase();
    if (!known.has(sym) && !new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source.text)) {
      errors.push(`ticker not in source: ${sym}`);
    }
  }

  // 4. copy limit
  const limit = config.copyLimitWords[source.licenseClass];
  if (limit === undefined) {
    errors.push(`no copy limit for license class ${source.licenseClass}`);
  } else {
    const run = longestCopiedRun(text, source.text, ITEM_TITLES);
    if (run > limit) errors.push(`copies ${run} consecutive words from the source (limit ${limit})`);
  }

  return { ok: errors.length === 0, errors };
}

// ---- in-depth detail ----------------------------------------------------------------

/** Shape and length of a detail: 2-4 paragraphs (<= 180 words together), 3-5 key points (<= 15 words each). */
export function checkDetailShape(d: unknown): string[] {
  const c = config.detail;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return ['detail is not an object'];
  const { paragraphs, key_points } = d as { paragraphs?: unknown; key_points?: unknown };
  const e: string[] = [];
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim() !== '');
  if (!strings(paragraphs)) e.push('detail.paragraphs must be a list of non-empty strings');
  else {
    const p = paragraphs as string[];
    if (p.length < c.minParagraphs || p.length > c.maxParagraphs) e.push(`detail needs ${c.minParagraphs}-${c.maxParagraphs} paragraphs (had ${p.length})`);
    const w = countWords(p.join(' '));
    if (w > c.maxWords) e.push(`detail longer than ${c.maxWords} words (was ${w})`);
  }
  if (!strings(key_points)) e.push('detail.key_points must be a list of non-empty strings');
  else {
    const k = key_points as string[];
    if (k.length < c.minKeyPoints || k.length > c.maxKeyPoints) e.push(`detail needs ${c.minKeyPoints}-${c.maxKeyPoints} key points (had ${k.length})`);
    for (const s of k) if (countWords(s) > c.keyPointMaxWords) e.push(`key point longer than ${c.keyPointMaxWords} words: "${s.slice(0, 40)}"`);
  }
  return e;
}

/**
 * Full check of an AI detail against its licensed source: shape, no advice language, every number
 * in the source, copy limit for the license (10 words filings/Wikipedia, 25 public domain).
 * `category` lets a 'safety' detail carry a plain product-safety instruction (see findAdvice).
 */
export function validateDetail(d: unknown, source: SourceText, category?: string): Result {
  const errors = checkDetailShape(d);
  if (errors.length) return { ok: false, errors };
  const { paragraphs, key_points } = d as { paragraphs: string[]; key_points: string[] };
  const text = [...paragraphs, ...key_points].join('\n');
  const advice = findAdvice(text, category);
  if (advice.length) errors.push(`detail advice language: ${advice.join(', ')}`);
  const missing = missingNumbers(text, source.text);
  if (missing.length) errors.push(`detail numbers not in source: ${[...new Set(missing)].join(', ')}`);
  if (source.checkFlow) {
    // sum-v7 (AI details only): same style, speculation and relative-time rules as the card, and the detail
    // must not restate the headline (paragraph 1, key point 1) or repeat its number without a new fact
    errors.push(...checkStyle({ paragraphs, keyPoints: key_points }));
    errors.push(...checkSpeculation(text, source.text), ...checkRelativeTime(text, source.text));
    if (source.headline) errors.push(...checkDetailRepetition(source.headline, { paragraphs, key_points }));
  }
  const limit = config.copyLimitWords[source.licenseClass];
  if (limit === undefined) errors.push(`no copy limit for license class ${source.licenseClass}`);
  else {
    // each paragraph and key point on its own, so a copied run cannot span two of them
    const run = Math.max(...[...paragraphs, ...key_points].map((t) => longestCopiedRun(t, source.text, ITEM_TITLES)));
    if (run > limit) errors.push(`detail copies ${run} consecutive words from the source (limit ${limit})`);
  }
  return { ok: errors.length === 0, errors };
}

// ---- publish payload check (mirrors api.publish_blurb) ----------------------------

export interface PublishSource {
  name: string;
  kind: string;
  url: string;
  license_class: string;
}

/** Publish-time checks (same as api.publish_blurb): >= 1 https source, no dev_only, AI cards cite only summarizable text, no link_out. */
export function validatePublish(card: { kind: string; ai_generated: boolean; sources: PublishSource[] }): Result {
  const errors: string[] = [];
  if (!Array.isArray(card.sources) || card.sources.length === 0) errors.push('card needs at least one source link');
  else {
    if (card.sources.length > config.maxSourcesPerCard) errors.push(`more than ${config.maxSourcesPerCard} sources`);
    for (const s of card.sources) {
      if (!/^https:\/\//.test(s.url ?? '')) errors.push(`source URL must be https: ${s.name}`);
      if (s.license_class === 'dev_only') errors.push('dev_only sources can never be published');
    }
    if (card.ai_generated) {
      for (const s of card.sources) {
        if (!(SUMMARIZABLE as readonly string[]).includes(s.license_class)) {
          errors.push(`AI card cites a source whose text may not be summarized: ${s.license_class}`);
        }
      }
    }
  }
  if (card.kind === 'link_out') errors.push('link_out cards are disabled in this build');
  return { ok: errors.length === 0, errors };
}
