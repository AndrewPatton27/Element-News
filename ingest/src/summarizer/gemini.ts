// Gemini (free tier) summarizer. Only public-domain and SEC filing text is sent
// (the chain checks the license before any provider is called).
// Inputs: SummarizeInput (item + licensed text + optional retry errors) and the API key (header only).
// Outputs: an unvalidated SummaryDraft; also exports the shared prompt builder, relevance rubric
// and the provider error classes used by groq.ts and chain.ts.

import { aiDailyCap, config, minIntervalMs } from '../config.ts';
import { fetchAllowed, type FetchLike } from '../allowlist.ts';
import { AI_CATEGORY_SLUGS, requiresFigures } from '../validate.ts';
import type { SummarizeInput, Summarizer, SummaryDraft } from '../types.ts';

/** A provider answered 429; the chain puts it in a cooldown and moves on. */
export class RateLimitedError extends Error {
  constructor(provider: string) {
    super(`${provider}: rate limited`);
    this.name = 'RateLimitedError';
  }
}

/** Any other provider failure (HTTP error, non-JSON or empty reply); the chain moves on. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Rubric for the everyday_relevance score (same words in the prompt and both JSON schemas). */
export const RELEVANCE_RUBRIC = 'Would a typical college student or young adult who does not invest notice this or be affected by it? '
  + '5 = national headline, or it changes their money, jobs and internships, student loans, rent and prices, gas, travel and airfares, '
  + 'phones and subscriptions, apps and brands they use, or taxes on a first job; 3 = a well-known company or a change some people will notice; '
  + '1 = institutional or routine paperwork (board seats, pay plans, small-bank enforcement, technical rules).';

/**
 * The prompt shared by every AI provider: writing rules and hard limits (from config), item
 * metadata, a recall-specific block for safety cards, the previous validator errors on a retry,
 * and finally the licensed source text.
 */
export function buildPrompt(input: SummarizeInput): string {
  const it = input.item;
  const lines = [
    'You write short, neutral news cards about business and the economy for college students and young adults.',
    'Use ONLY facts stated in the SOURCE TEXT. If the text is thin, say only what it says.',
    'WRITING STYLE: very easy to understand. Use plain words at about an 8th-grade reading level and short sentences. No jargon.',
    '- If a term like "convertible notes" or "restatement" cannot be avoided, explain it in a few plain words (for example "borrowed money that can turn into shares").',
    '- The headline says what happened. Body sentence 1 does NOT say it again: it continues from the headline and adds the next most useful fact (who or what is affected, how much, where, or what changes).',
    '- The last sentence says why it matters to a regular person or a student, but ONLY if that follows directly from the facts in the source. Never guess, predict prices or give advice. If it does not follow, leave it out.',
    'FLOW AND NO REPETITION (a card that breaks one of these is rejected):',
    '- The headline and the body read as ONE piece. The first body sentence picks up where the headline stops and adds the next most useful fact. It must NEVER restate the headline or reuse its wording.',
    '  Bad (do not copy, example only): headline "IRS lets people pay taxes by card" -> body "The IRS now lets people pay taxes by card. ..."',
    '  Good (example only): headline "IRS lets people pay taxes by card" -> body "Taxpayers can use a debit or credit card directly, without a third-party service. The change takes effect next year."',
    '- Every sentence adds something new. No sentence repeats an earlier one in other words, and no phrase is repeated.',
    '- No filler such as "This means that...", "In summary...", "It is important to note...".',
    '- The "detail" continues the story too: its key_points add new facts and must NOT copy or reword the body sentences.',
    `HARD LIMITS (a card that breaks one is rejected): headline at most ${config.headlineMaxChars} characters including spaces; body 2 or 3 sentences and at most ${config.bodyMaxWords} words in total.`,
    'Rules:',
    `- "headline": short and plain, at most ${config.headlineMaxChars} characters (aim for about ${config.headlineTargetChars}).`,
    '- The headline must say WHAT HAPPENED in plain words, leading with the event (for example "Earthquake", "Recall", "New rule", "Earnings", "CEO steps down").',
    '- Use sentence case in the headline: capitalise only the first word and proper nouns (names of people, companies, places, agencies, product brands, tickers). Write "Primark recalls children\'s coin purses", not "Primark Recalls Children\'s Coin Purses".',
    '- Never include model numbers, SKUs, UPCs or lot numbers in the headline or the body. If they matter, put them in "detail".key_points only.',
    '- Leave precise technical details OUT of the headline AND the body: no exact distances, compass bearings, coordinates, exact clock times, docket, item or section numbers, model numbers, or long official titles. Name the broad place or thing people recognize (the country, state, or company), not the nearest small town or precise spot.',
    '- Keep only the one or two numbers that matter most (the magnitude, the dollar amount, the percent change). Precise details (exact location, times, model or docket numbers) belong ONLY in "detail".key_points, never in the headline or the body.',
    `- "body": 2 or 3 short sentences, at most ${config.bodyMaxWords} words (aim for about ${Math.round(config.bodyMaxWords * 0.75)}), or null if the text has no facts beyond the headline. Give the big picture beyond the headline: where in broad terms, who is affected, and why it matters.`,
    '- Every number you write must appear in the source text exactly. Do not calculate new numbers.',
    '- Never give investment advice or opinions. Do not use words like buy, sell, hold, invest in, recommend, price target, guaranteed, undervalued, or overvalued.',
    '- For a product recall or safety card, give the plain safety instruction as a direct order and do NOT use the word "should": write "Stop using it and contact the company for a refund" rather than "consumers should stop using it". Phrases like stop using, contact the company, and return it for a refund are fine.',
    '- Do not copy more than 8 words in a row from the source; rephrase in your own plain words.',
    `- "category": one of ${AI_CATEGORY_SLUGS.join(', ')}.`,
    '- "event_type": one of earnings, exec_change, deal, insider, macro_release, fed, or null.',
    '- "tickers": stock symbols that appear in the source text or the metadata below, else [].',
    `- "everyday_relevance": a whole number from 1 to 5. ${RELEVANCE_RUBRIC}`,
    `- "detail": a longer, still easy version for readers who tap the card. "paragraphs": ${config.detail.minParagraphs} to ${config.detail.maxParagraphs} short paragraphs, at most ${config.detail.maxWords} words in total: what happened, the background a student needs to understand it, and what it means for regular people ONLY if that follows from the source. "key_points": ${config.detail.minKeyPoints} to ${config.detail.maxKeyPoints} short points, each at most ${config.detail.keyPointMaxWords} words. Same rules as the card. Put every fact in your OWN plain words: never copy a phrase of more than 8 words in a row from the source (break up or reword any longer run). Use ONLY numbers that appear in the source text exactly; if a number is not in the source, leave it out rather than guessing or rounding. No advice, no predictions.`,
    'Return JSON only.',
    '',
    `SOURCE: ${it.source_name}, ${it.doc_label}, ${it.published_at}`,
    it.tickers.length ? `TICKERS: ${it.tickers.map((t) => `${t.symbol} (${t.name})`).join(', ')}` : '',
    `SUGGESTED CATEGORY: ${it.category}; SUGGESTED EVENT TYPE: ${it.event_type ?? 'null'}`,
  ];
  if (it.category === 'safety') {
    lines.push(
      '',
      'THIS IS A PRODUCT-SAFETY RECALL. Tell people plainly and directly what to do, as commands, '
      + 'without the word "should": for example "Stop using it right away and contact the company for a refund." '
      + 'Say what the product is, the danger, and the fix (refund, repair, or replacement) in plain words. '
      + 'Keep investment words (buy, sell, invest in, price target) out of it.',
    );
  }
  if (requiresFigures(it)) {
    lines.push(
      '',
      'THIS IS AN EARNINGS CARD. The body MUST state the real figures from the source text, such as revenue, profit or loss, '
      + 'or earnings per share, and how they compare with a year earlier or with the company\'s own forecast if the source says so. '
      + 'A card with no number in the body is rejected. Describe what the company said about its results, never the filing itself '
      + '(no talk of exhibits, press releases, conference calls or links). If the source text has no figures, write only what it does say.',
    );
  }
  if (input.retryErrors?.length) {
    lines.push('', `Your previous answer was rejected for: ${input.retryErrors.join('; ')}. Fix these problems.`);
    if (input.retryErrors.some((e) => /^no_figures/.test(e))) {
      lines.push('Put the key figures from the source (for example revenue and profit, with the dollar amounts) in the body. Use the numbers exactly as written in the source.');
    }
    if (input.retryErrors.some((e) => /^repetition/.test(e))) {
      lines.push('Rewrite the body so its first sentence adds a NEW fact instead of repeating the headline, and no two sentences say the same thing. Do not use the headline\'s words again in sentence 1.');
    }
    if (input.retryErrors.some((e) => /longer than/.test(e))) {
      lines.push(`Write it shorter: headline at most ${config.headlineMaxChars} characters, body at most ${config.bodyMaxWords} words in 2 or 3 sentences.`);
    }
  }
  lines.push('', 'SOURCE TEXT:', input.text);
  return lines.join('\n');
}

/** Gemini structured-output schema for the draft (card + everyday_relevance + detail). */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: `At most ${config.headlineMaxChars} characters.` },
    body: { type: 'STRING', nullable: true, description: `2 or 3 sentences, at most ${config.bodyMaxWords} words.` },
    category: { type: 'STRING', enum: [...AI_CATEGORY_SLUGS] },
    event_type: { type: 'STRING', nullable: true },
    tickers: { type: 'ARRAY', items: { type: 'STRING' } },
    everyday_relevance: { type: 'INTEGER', description: `1 to 5. ${RELEVANCE_RUBRIC}` },
    detail: {
      type: 'OBJECT',
      description: `In-depth version: ${config.detail.minParagraphs}-${config.detail.maxParagraphs} short paragraphs (<= ${config.detail.maxWords} words in total) and ${config.detail.minKeyPoints}-${config.detail.maxKeyPoints} key points (<= ${config.detail.keyPointMaxWords} words each).`,
      properties: {
        paragraphs: { type: 'ARRAY', items: { type: 'STRING' } },
        key_points: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['paragraphs', 'key_points'],
    },
  },
  required: ['headline', 'body', 'category', 'event_type', 'tickers', 'everyday_relevance', 'detail'],
};

/**
 * Gemini summarizer (generateContent, JSON response schema). Daily cap and pacing default to the
 * free-tier values in config. Throws RateLimitedError on 429, ProviderError on other failures.
 */
export function createGeminiSummarizer(opts: {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
  minIntervalMs?: number;
  dailyCap?: number;
}): Summarizer {
  const model = opts.model ?? config.gemini.model;
  return {
    name: 'gemini',
    usesAi: true,
    model,
    dailyCap: opts.dailyCap ?? aiDailyCap(),
    minIntervalMs: opts.minIntervalMs ?? minIntervalMs(config.gemini.freeRpm, 5000),
    async summarize(input): Promise<SummaryDraft> {
      const url = config.gemini.endpoint.replace('{model}', model);
      const res = await fetchAllowed(url, {
        kind: 'api',
        method: 'POST',
        fetchImpl: opts.fetchImpl,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },  // key in a header, never in the URL
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1200,                // card + detail (sum-v3)
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      });
      if (res.status === 429) throw new RateLimitedError('gemini');
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(`gemini: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
      let text: string | undefined;
      try {
        text = JSON.parse(res.text)?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch {
        throw new ProviderError('gemini: response is not JSON');
      }
      if (!text) throw new ProviderError('gemini: empty response');
      return JSON.parse(text) as SummaryDraft;   // shape is checked by the validator
    },
  };
}
