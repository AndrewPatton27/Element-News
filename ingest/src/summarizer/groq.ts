// Groq (free tier) summarizer: the fallback after Gemini. OpenAI-compatible
// chat-completions API. Same prompt, same draft shape and same retry handling as
// gemini.ts. Only public-domain and SEC filing text is sent (the chain checks the
// license before any provider is called).
// Inputs: SummarizeInput and the API key (Authorization header only).
// Outputs: an unvalidated SummaryDraft; RateLimitedError on 429, ProviderError otherwise.

import { config, groqDailyCap, groqMinIntervalMs } from '../config.ts';
import { fetchAllowed, type FetchLike } from '../allowlist.ts';
import { AI_CATEGORY_SLUGS } from '../validate.ts';
import { buildPrompt, ProviderError, RateLimitedError, RELEVANCE_RUBRIC } from './gemini.ts';
import type { Summarizer, SummaryDraft } from '../types.ts';

type ResponseFormat = 'json_schema' | 'json_object';

/** OpenAI-style JSON schema for the draft (strict: every key required, no extras). */
export const GROQ_JSON_SCHEMA = {
  name: 'news_card',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: `At most ${config.headlineMaxChars} characters.` },
      body: { type: ['string', 'null'], description: `2 or 3 sentences, at most ${config.bodyMaxWords} words.` },
      category: { type: 'string', enum: [...AI_CATEGORY_SLUGS] },
      event_type: { type: ['string', 'null'] },
      tickers: { type: 'array', items: { type: 'string' } },
      everyday_relevance: { type: 'integer', description: `1 to 5. ${RELEVANCE_RUBRIC}` },
      detail: {
        type: 'object',
        description: `In-depth version: ${config.detail.minParagraphs}-${config.detail.maxParagraphs} short paragraphs (<= ${config.detail.maxWords} words in total) and ${config.detail.minKeyPoints}-${config.detail.maxKeyPoints} key points (<= ${config.detail.keyPointMaxWords} words each).`,
        properties: {
          paragraphs: { type: 'array', items: { type: 'string' } },
          key_points: { type: 'array', items: { type: 'string' } },
        },
        required: ['paragraphs', 'key_points'],
        additionalProperties: false,
      },
    },
    required: ['headline', 'body', 'category', 'event_type', 'tickers', 'everyday_relevance', 'detail'],
    additionalProperties: false,
  },
};

/**
 * The schema sent to Groq. With maxLength on, the headline also carries a JSON-schema maxLength.
 * Off by default: whether Groq's strict mode accepts maxLength is UNVERIFIED, and a 400 would cost
 * a second request (the json_object retry) on every card.
 */
export function groqJsonSchema(withMaxLength: boolean): typeof GROQ_JSON_SCHEMA {
  if (!withMaxLength) return GROQ_JSON_SCHEMA;
  const s = structuredClone(GROQ_JSON_SCHEMA);
  (s.schema.properties.headline as Record<string, unknown>).maxLength = config.headlineMaxChars;
  return s;
}

/** Parses model output that should be a JSON object; tolerates code fences or text around it. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ }
    }
    throw new ProviderError('groq: reply is not JSON');
  }
}

/**
 * Groq summarizer (chat completions). Sends a shorter slice of the source text (token limit),
 * asks for json_schema output and falls back once to json_object if Groq rejects the schema.
 */
export function createGroqSummarizer(opts: {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
  minIntervalMs?: number;
  dailyCap?: number;
}): Summarizer {
  const model = opts.model ?? config.groq.model;
  let lastScoreCall = 0;

  async function call(prompt: string, format: ResponseFormat) {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_completion_tokens: config.groq.maxCompletionTokens,
      response_format: format === 'json_schema'
        ? { type: 'json_schema', json_schema: groqJsonSchema(config.groq.schemaMaxLength) }
        : { type: 'json_object' },
    };
    if (config.groq.reasoningEffort) body.reasoning_effort = config.groq.reasoningEffort;
    return fetchAllowed(config.groq.endpoint, {
      kind: 'api',
      method: 'POST',
      fetchImpl: opts.fetchImpl,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },  // key in a header, never in the URL
      body: JSON.stringify(body),
    });
  }

  return {
    name: 'groq',
    usesAi: true,
    model,
    dailyCap: opts.dailyCap ?? groqDailyCap(),
    minIntervalMs: opts.minIntervalMs ?? groqMinIntervalMs(),
    async generate(prompt: string): Promise<string> {
      for (let attempt = 0; ; attempt++) {
        const wait = lastScoreCall + config.reportCard.scoreMinIntervalMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastScoreCall = Date.now();
        const res = await fetchAllowed(config.groq.endpoint, { kind: 'api', method: 'POST', fetchImpl: opts.fetchImpl,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1,
            max_completion_tokens: config.reportCard.scoreMaxTokens, response_format: { type: 'json_object' } }) });
        if (res.status === 429 && attempt < config.reportCard.scoreMax429Retries) {
          await new Promise(r => setTimeout(r, res.retryAfterMs ?? config.reportCard.scoreMinIntervalMs));
          continue;
        }
        if (res.status === 429) throw new RateLimitedError('groq');
        if (res.status < 200 || res.status >= 300) throw new ProviderError(`groq scorer HTTP ${res.status}`);
        try { const x = JSON.parse(res.text)?.choices?.[0]?.message?.content; if (typeof x !== 'string') throw 0; return x; }
        catch { throw new ProviderError('groq scorer returned invalid JSON envelope'); }
      }
    },
    async summarize(input): Promise<SummaryDraft> {
      // Tokens per minute are Groq's binding limit: send a shorter slice of the (already licensed) text.
      const prompt = buildPrompt({ ...input, text: input.text.slice(0, config.groq.sourceTextMaxChars) });
      let format: ResponseFormat = config.groq.responseFormat;
      let res = await call(prompt, format);
      // Structured output not accepted for this model/request: retry once in plain JSON mode.
      if (res.status === 400 && format === 'json_schema' && /response_format|json_schema|schema/i.test(res.text)) {
        format = 'json_object';
        res = await call(prompt, format);
      }
      if (res.status === 429) throw new RateLimitedError('groq');
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(`groq: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
      let choice: { message?: { content?: string | null }; finish_reason?: string } | undefined;
      try {
        choice = JSON.parse(res.text)?.choices?.[0];
      } catch {
        throw new ProviderError('groq: response is not JSON');
      }
      const text = choice?.message?.content;
      if (!text) throw new ProviderError(`groq: empty response${choice?.finish_reason ? ` (finish_reason ${choice.finish_reason})` : ''}`);
      return parseJsonLoose(text) as SummaryDraft;   // shape is checked by the validator
    },
  };
}
