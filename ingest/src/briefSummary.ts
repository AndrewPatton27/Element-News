// Brief summary: a 200-290 word, 3-4 paragraph plain-language summary of a whole daily or weekly brief, written by
// the AI ONCE per brief per day/week (never per request or per subscriber) and stored with
// api.put_brief_summary. Written ONLY from the cards and numbers inside the brief JSON.
// Chain: Gemini -> Groq -> template (same keys, models and daily caps as the card pipeline).
// Each AI draft is validated (sentence count, length, no advice words, every number in the brief,
// copy limit, no repeated sentences, sum-v7 style / speculation / relative-time rules) and retried once with the errors; a template summary built
// from the headlines is the last resort and never calls an AI.
// Inputs: the brief JSON (public RPCs api.daily_brief / api.weekly_brief), AI keys, a usage counter.
// Outputs: summary text + model name; with the service-role RPC, one row per (kind, for_date).

import { fetchAllowed, type FetchLike } from './allowlist.ts';
import { aiDailyCap, config, groqDailyCap } from './config.ts';
import { summaryDate, summaryIsCurrent } from './briefTime.ts';
import { isDailyQuota, modelFallback, ProviderError, RateLimitedError } from './summarizer/gemini.ts';
import type { UsageCounter } from './summarizer/chain.ts';
import { checkRepetition, countWords, extractNumbers, findAdvice, longestCopiedRun, splitSentences } from './validate.ts';
import { checkRelativeTime, checkSpeculation, checkStyle } from './styleChecks.ts';
import { fixProperNouns } from './text.ts';
import type { Brief, BlurbCard, MacroFact } from '../../contract/types.ts';

export type BriefKind = 'daily' | 'weekly';

/** The brief JSON as the summary job and the email need it (summary and markets are added by the 20261018040000 migration). */
export interface BriefInput extends Omit<Brief, 'markets'> {
  summary?: { text: string; generated_at: string; model: string } | null;
  markets?: { cards: BlurbCard[]; numbers: MacroFact[]; total?: number } | null;
}

// ---- reading the brief ---------------------------------------------------------------

/** Thrown when an RPC does not exist yet (the migration is not applied): callers print a message and exit 0. */
export class RpcMissingError extends Error {
  constructor(name: string) {
    super(`rpc ${name} does not exist yet (migration not applied)`);
    this.name = 'RpcMissingError';
  }
}

/** true if a PostgREST error means "no such function" (HTTP 404, or code PGRST202 / 42883). */
export function isRpcMissing(status: number, text: string): boolean {
  return status === 404 || /PGRST202|42883|Could not find the function/i.test(text);
}

/**
 * Reads api.daily_brief / api.weekly_brief with the PUBLISHABLE key (same call as the app; reads only).
 * Throws RpcMissingError if the function is not there, Error on any other failure.
 */
export async function fetchBrief(kind: BriefKind, opts: { url: string; key: string; fetchImpl?: FetchLike }): Promise<BriefInput> {
  const name = kind === 'daily' ? 'daily_brief' : 'weekly_brief';
  const host = new URL(opts.url).hostname;
  const res = await fetchAllowed(`${opts.url}/rest/v1/rpc/${name}`, {
    kind: 'api', method: 'POST', extraHosts: [host], fetchImpl: opts.fetchImpl,
    headers: { apikey: opts.key, Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Profile': 'api', 'Content-Profile': 'api' },
    body: '{}',
  });
  if (isRpcMissing(res.status, res.text)) throw new RpcMissingError(name);
  if (res.status < 200 || res.status >= 300) throw new Error(`rpc ${name}: HTTP ${res.status}`);
  let json: unknown;
  try { json = JSON.parse(res.text); } catch { throw new Error(`rpc ${name}: reply is not JSON`); }
  const b = (Array.isArray(json) ? json[0] : json) as BriefInput | null;
  if (!b || typeof b !== 'object') throw new Error(`rpc ${name}: empty reply`);
  return { ...b, headline_cards: b.headline_cards ?? [], sections: b.sections ?? [], numbers: b.numbers ?? [] };
}

/** Every card of a brief once (headlines, markets, then topic sections), de-duplicated by id. */
export function allBriefCards(brief: BriefInput): BlurbCard[] {
  const seen = new Set<string>();
  const out: BlurbCard[] = [];
  for (const c of [...(brief.headline_cards ?? []), ...(brief.markets?.cards ?? []), ...(brief.sections ?? []).flatMap((s) => s.cards ?? [])]) {
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

const oneLine = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Markets numbers first, then the brief's numbers, one entry per series. */
export function allBriefNumbers(brief: BriefInput): MacroFact[] {
  const seen = new Set<string>();
  const out: MacroFact[] = [];
  for (const n of [...(brief.markets?.numbers ?? []), ...(brief.numbers ?? [])]) {
    if (!n || seen.has(n.series_id)) continue;
    seen.add(n.series_id);
    out.push(n);
  }
  return out;
}

/**
 * The plain text the AI gets, and the text every number in the summary is checked against.
 * Only what is in the brief JSON: topic names, card headlines and short summaries, number labels, values and changes.
 */
export function briefSourceText(brief: BriefInput): string {
  const lines: string[] = [];
  const card = (c: BlurbCard) => `- ${oneLine(c.headline)}${c.body ? `. ${oneLine(c.body)}` : ''}`;
  const top = brief.headline_cards ?? [];
  if (top.length) lines.push('TOP STORIES:', ...top.map(card));
  if (brief.markets?.cards?.length) lines.push('MARKETS:', ...brief.markets.cards.map(card));
  const skip = config.mail.summarySkipSectionCategories;
  for (const s of brief.sections ?? []) {
    if (skip.includes(s.category)) continue;                   // recalls and space news: only as TOP STORIES (sum-v7)
    if (s.cards?.length) lines.push(`TOPIC ${oneLine(s.label)}:`, ...s.cards.map(card));
  }
  const nums = allBriefNumbers(brief);
  if (nums.length) {
    lines.push('NUMBERS:');
    for (const n of nums) {
      lines.push(`- ${oneLine(n.label)}: ${oneLine(n.value)}${n.change ? `, change ${oneLine(n.change)}` : ''}${n.direction ? ` (${n.direction})` : ''}${n.period ? `, ${oneLine(n.period)}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** true if the brief has nothing to summarize. */
export function briefIsEmpty(brief: BriefInput): boolean {
  return allBriefCards(brief).length === 0;
}

// ---- prompt and validation ----------------------------------------------------------------

/** The prompt for one brief. `retryErrors` are the validator errors of the previous draft. */
export function buildBriefPrompt(kind: BriefKind, source: string, retryErrors?: string[]): string {
  const c = config.mail;
  // The daily window is 24, 48 or 72 hours depending on supply (api.daily_brief), so the prompt never says "today".
  const span = kind === 'daily' ? 'the period this brief covers' : 'this week';
  const lines = [
    `You write the short summary at the top of Element's ${kind} news brief for busy everyday people interested in business, finance, stocks and investing (about 16 to 50). They know the basics but want plain words.`,
    `Write about ${c.summaryTargetWords} words (between ${c.summaryMinWords} and ${c.summaryMaxWords}) in ${c.summaryParagraphs[0]} to ${c.summaryParagraphs[1]} short paragraphs, separated by one blank line, that tell a reader what mattered in ${span}.`,
    'Use ONLY facts stated in the BRIEF below. Do not add anything from memory.',
    'STYLE: clear and direct, like a good markets newsletter: about an 8th-grade reading level, short sentences, calm neutral tone, no hype. Give any term outside everyday finance words a plain definition of a few words in parentheses (never square brackets).',
    '- ORDER (most important first): paragraph 1 = Federal Reserve decisions and the most important economic data in the BRIEF (inflation, jobs, GDP, rates), with their numbers. Paragraph 2 = market-moving news about large listed companies, one or two sentences each. Then a short paragraph on the other topics. Do NOT mention a product recall, space or science item unless it is listed under TOP STORIES; if it is, put it last.',
    '- Always mention the biggest economic numbers in NUMBERS that changed (for example GDP, payrolls, CPI, the unemployment rate) before any single company.',
    '- Cover the BREADTH of the brief: several different topics, not only the first one. Do not join unrelated items with "Meanwhile" or "In other news"; start a new sentence about the new topic.',
    '- Why it matters: only when the BRIEF states the reason or a comparison. No could, may, likely or expected to unless the BRIEF says it, and then attribute it. Name scheduled next steps only when the BRIEF gives a date.',
    '- One direction word per change ("fell 18% to"), "percentage points" not "pts", acronyms in capitals (NASA, FOMC, SEC, FCC, CPI, GDP, U.S.), proper nouns capitalised (Mars, Moon, United States), dates as numerals ("Nov 5").',
    '- Attribute claims and forecasts to who made them. No relative time words other than the brief\'s own span.',
    'HARD RULES (a summary that breaks one is rejected):',
    '- Every number you write must appear in the BRIEF exactly as written. Do not calculate new numbers. Do not write dates or times unless they are in the BRIEF.',
    '- Never give investment advice, opinions or predictions. Do not use words like buy, sell, should, recommend, price target.',
    `- Do not copy more than ${c.summaryCopyLimitWords - 2} words in a row from the BRIEF; rephrase.`,
    '- Every sentence adds something new. No filler such as "In summary" or "This means that".',
    '- Plain text only: no headings, bullets, markdown, links or quotation marks around the whole answer. Separate paragraphs with exactly one blank line.',
    'Return only the summary text.',
  ];
  if (retryErrors?.length) lines.push('', `Your previous answer was rejected for: ${retryErrors.join('; ')}. Fix these problems.`);
  lines.push('', 'BRIEF:', source);
  return lines.join('\n');
}

/** Cleans model output: trims, removes wrapping quotes, code fences and a leading label, fixes proper-noun casing (fixProperNouns). */
export function cleanSummaryText(raw: string): string {
  let t = String(raw ?? '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  t = t.replace(/^(?:summary|brief summary)\s*:\s*/i, '');
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return fixProperNouns(t.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n'));   // sum-v7: Nasa -> NASA
}

/** Validation errors for a summary against the brief text it was written from ([] = ok). */
export function validateBriefSummary(text: string, source: string): string[] {
  const c = config.mail;
  const errors: string[] = [];
  const sentences = splitSentences(text);
  if (sentences.length < c.summaryMinSentences || sentences.length > c.summaryMaxSentences) {
    errors.push(`needs ${c.summaryMinSentences} to ${c.summaryMaxSentences} sentences (had ${sentences.length})`);
  }
  const wc = countWords(text);
  if (wc > c.summaryMaxWords) errors.push(`longer than ${c.summaryMaxWords} words (was ${wc})`);
  if (wc < c.summaryMinWords) errors.push(`shorter than ${c.summaryMinWords} words (was ${wc}); aim for about ${c.summaryTargetWords}`);
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  if (paras < c.summaryParagraphs[0] || paras > c.summaryParagraphs[1]) errors.push(`needs ${c.summaryParagraphs[0]} to ${c.summaryParagraphs[1]} paragraphs separated by a blank line (had ${paras})`);
  if (/https?:\/\/|[*#`\[\]]|^\s*[-•]/m.test(text)) errors.push('plain text only: no links, markdown or bullets');
  const advice = findAdvice(text);
  if (advice.length) errors.push(`advice language: ${advice.join(', ')}`);
  const known = new Set(extractNumbers(source));
  const missing = extractNumbers(text).filter((n) => !known.has(n));
  if (missing.length) errors.push(`numbers not in the brief: ${[...new Set(missing)].join(', ')}`);
  const run = longestCopiedRun(text, source);
  if (run > c.summaryCopyLimitWords) errors.push(`copies ${run} consecutive words from the brief (limit ${c.summaryCopyLimitWords})`);
  errors.push(...checkRepetition('', text));
  // sum-v7: style, no speculation, no relative time except the brief's own span words, no "Meanwhile" stitching
  errors.push(...checkStyle({ paragraphs: text.split(/\n\s*\n/) }));
  errors.push(...checkSpeculation(text, source), ...checkRelativeTime(text, source, ['today', 'this week']));
  if (/\b(?:Meanwhile|In other news)\b/i.test(text)) errors.push('style: do not join unrelated items with "Meanwhile" or "In other news"');
  return errors;
}

// ---- template fallback ---------------------------------------------------------------------

const stripEnd = (s: string) => oneLine(s).replace(/[.!?]+$/, '');

/** Summary built straight from the headlines and topic names. No AI; used when both providers fail. */
export function templateBriefSummary(kind: BriefKind, brief: BriefInput): string {
  const span = kind === 'daily' ? 'today' : 'this week';
  const heads = (brief.headline_cards?.length ? brief.headline_cards : allBriefCards(brief)).map((c) => stripEnd(c.headline)).filter(Boolean);
  const topics = (brief.sections ?? []).filter((s) => s.cards?.length).map((s) => stripEnd(s.label)).filter(Boolean);
  const out: string[] = [];
  if (heads[0]) out.push(`The top story ${span}: ${heads[0]}.`);
  if (heads.length > 1) out.push(`Also in the news: ${heads.slice(1, 3).join('; ')}.`);
  if (topics.length > 1) out.push(`This brief covers ${topics.slice(0, 4).join(', ')}.`);
  if (!out.length) out.push(`Open the brief for the stories that mattered ${span}.`);
  return out.join('\n\n');
}

// ---- AI text models (same keys, models, endpoints and caps as the card pipeline) --------

export interface TextModel {
  name: 'gemini' | 'groq';
  model: string;
  /** true once the primary model was reported retired and the fallback took over */
  modelMissing?: boolean;
  dailyCap: number;
  generate(prompt: string): Promise<string>;
}

export function createGeminiTextModel(opts: { apiKey: string; model?: string; fetchImpl?: FetchLike }): TextModel {
  const mf = modelFallback(opts.model ?? config.gemini.model, config.gemini.fallbackModel);
  return {
    name: 'gemini', get model() { return mf.model; }, get modelMissing() { return mf.missing; }, dailyCap: aiDailyCap(),
    async generate(prompt) {
      const res = await mf.call((model) => fetchAllowed(config.gemini.endpoint.replace('{model}', model), {
        kind: 'api', method: 'POST', fetchImpl: opts.fetchImpl,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },   // key in a header, never in the URL
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: config.mail.summaryMaxTokens },
        }),
      }));
      if (res.status === 429) throw new RateLimitedError('gemini', isDailyQuota(res.text));
      if (res.status < 200 || res.status >= 300) throw new ProviderError(`gemini: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      let text: string | undefined;
      try { text = JSON.parse(res.text)?.candidates?.[0]?.content?.parts?.[0]?.text; } catch { throw new ProviderError('gemini: response is not JSON'); }
      if (!text) throw new ProviderError('gemini: empty response');
      return text;
    },
  };
}

export function createGroqTextModel(opts: { apiKey: string; model?: string; fetchImpl?: FetchLike }): TextModel {
  const mf = modelFallback(opts.model ?? config.groq.model, config.groq.alternativeModel);
  return {
    name: 'groq', get model() { return mf.model; }, get modelMissing() { return mf.missing; }, dailyCap: groqDailyCap(),
    async generate(prompt) {
      const body = (model: string): Record<string, unknown> => ({
        model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_completion_tokens: Math.max(config.mail.summaryMaxTokens, 1024),
        ...(config.groq.reasoningEffort ? { reasoning_effort: config.groq.reasoningEffort } : {}),
      });
      const res = await mf.call((model) => fetchAllowed(config.groq.endpoint, {
        kind: 'api', method: 'POST', fetchImpl: opts.fetchImpl,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },   // key in a header, never in the URL
        body: JSON.stringify(body(model)),
      }));
      if (res.status === 429) throw new RateLimitedError('groq', isDailyQuota(res.text));
      if (res.status < 200 || res.status >= 300) throw new ProviderError(`groq: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      let text: string | null | undefined;
      try { text = JSON.parse(res.text)?.choices?.[0]?.message?.content; } catch { throw new ProviderError('groq: response is not JSON'); }
      if (!text) throw new ProviderError('groq: empty response');
      return text;
    },
  };
}

/** Text models in config.providerOrder for the keys that are set (a missing key = provider skipped). */
export function buildTextModels(keys: { geminiApiKey: string | null; groqApiKey: string | null }, fetchImpl?: FetchLike): TextModel[] {
  const out: TextModel[] = [];
  for (const name of config.providerOrder) {
    if (name === 'gemini' && keys.geminiApiKey) out.push(createGeminiTextModel({ apiKey: keys.geminiApiKey, fetchImpl }));
    if (name === 'groq' && keys.groqApiKey) out.push(createGroqTextModel({ apiKey: keys.groqApiKey, fetchImpl }));
  }
  return out;
}

export interface SummaryResult {
  text: string;
  model: string;          // the AI model that wrote it, or 'template'
  ai_generated: boolean;
  log: string[];          // what happened (no text, no keys)
}

/**
 * Writes one summary: for each AI model (skipped at its daily cap) up to 2 attempts, the second with
 * the validator errors; any provider error, 429 or two rejected drafts moves on; then the template.
 */
export async function generateBriefSummary(
  kind: BriefKind,
  brief: BriefInput,
  models: TextModel[],
  counter: UsageCounter,
): Promise<SummaryResult> {
  const source = briefSourceText(brief);
  const log: string[] = [];
  for (const m of models) {
    let retryErrors: string[] | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (counter.used(m.name) >= m.dailyCap) { log.push(`${m.name}: daily cap ${m.dailyCap} reached`); break; }
      counter.add(m.name);
      let raw: string;
      try {
        raw = await m.generate(buildBriefPrompt(kind, source, retryErrors));
      } catch (e) {
        log.push(`${m.name}: ${(e as Error).name}: ${(e as Error).message}`);
        break;                                      // 429, timeout or provider error: next provider
      }
      const text = cleanSummaryText(raw);
      const errors = validateBriefSummary(text, source);
      if (!errors.length) {
        log.push(`${m.name}: ok (attempt ${attempt})`);
        return { text, model: m.model, ai_generated: true, log };
      }
      log.push(`${m.name}: rejected (attempt ${attempt}): ${errors.join('; ')}`);
      retryErrors = errors;
    }
  }
  log.push('template: used');
  return { text: templateBriefSummary(kind, brief), model: 'template', ai_generated: false, log };
}

// ---- the job -------------------------------------------------------------------------------

export interface SummaryJobDeps {
  fetchBrief(kind: BriefKind): Promise<BriefInput>;
  /** service-role api.put_brief_summary; absent in a dry run */
  putSummary?(kind: BriefKind, forDate: string, text: string, model: string): Promise<unknown>;
  models: TextModel[];
  counter: UsageCounter;
  now: Date;
  log(s: string): void;
}

export interface SummaryJobOutcome {
  kind: BriefKind;
  status: 'written' | 'dry_run' | 'exists' | 'empty' | 'missing_rpc';
  for_date: string;
  text?: string;
  model?: string;
  brief?: BriefInput;
}

/**
 * Runs the summary job for the given kinds. Idempotent: a brief that already has this day's (week's)
 * summary is skipped unless `force`. `dryRun` reads and generates but writes nothing.
 */
export async function runBriefSummary(
  deps: SummaryJobDeps,
  opts: { kinds: BriefKind[]; force?: boolean; dryRun?: boolean },
): Promise<SummaryJobOutcome[]> {
  const out: SummaryJobOutcome[] = [];
  for (const kind of opts.kinds) {
    const for_date = summaryDate(kind, deps.now);
    let brief: BriefInput;
    try {
      brief = await deps.fetchBrief(kind);
    } catch (e) {
      if (e instanceof RpcMissingError) { deps.log(`${kind}: ${e.message}; nothing to do`); out.push({ kind, status: 'missing_rpc', for_date }); continue; }
      throw e;
    }
    if (!opts.force && summaryIsCurrent(kind, brief.summary?.generated_at, deps.now)) {
      deps.log(`${kind}: summary for ${for_date} already exists, skipped (use --force to redo)`);
      out.push({ kind, status: 'exists', for_date, text: brief.summary?.text, model: brief.summary?.model, brief });
      continue;
    }
    if (briefIsEmpty(brief)) { deps.log(`${kind}: the brief has no stories, nothing to summarize`); out.push({ kind, status: 'empty', for_date, brief }); continue; }
    const r = await generateBriefSummary(kind, brief, deps.models, deps.counter);
    for (const l of r.log) deps.log(`${kind}: ${l}`);
    if (opts.dryRun || !deps.putSummary) {
      deps.log(`${kind}: dry run, nothing written (model ${r.model})`);
      out.push({ kind, status: 'dry_run', for_date, text: r.text, model: r.model, brief });
      continue;
    }
    try {
      await deps.putSummary(kind, for_date, r.text, r.model);
    } catch (e) {
      if (e instanceof RpcMissingError) { deps.log(`${kind}: ${e.message}; summary not stored`); out.push({ kind, status: 'missing_rpc', for_date, text: r.text, model: r.model, brief }); continue; }
      throw e;
    }
    deps.log(`${kind}: summary for ${for_date} stored (model ${r.model})`);
    out.push({ kind, status: 'written', for_date, text: r.text, model: r.model, brief });
  }
  return out;
}
