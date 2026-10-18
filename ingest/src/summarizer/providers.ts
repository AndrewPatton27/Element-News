// Builds the provider list from config.providerOrder and the environment.
// An AI provider whose key is missing is skipped cleanly (the next one is used).
// Inputs: the Gemini/Groq keys (null = not set) and optional test overrides.
// Outputs: the ordered Summarizer list and a human-readable list of skipped providers.

import { config } from '../config.ts';
import type { FetchLike } from '../allowlist.ts';
import { createGeminiSummarizer } from './gemini.ts';
import { createGroqSummarizer } from './groq.ts';
import { createCodexSummarizer } from './codex.ts';
import { templateSummarizer } from './template.ts';
import type { Summarizer } from '../types.ts';

/** Providers in config.providerOrder; AI providers without a key go to `skipped` instead. */
export function buildProviders(
  keys: { geminiApiKey: string | null; groqApiKey: string | null },
  opts: { fetchImpl?: FetchLike; minIntervalMs?: number; writer?: string; codexExe?: string } = {},
): { providers: Summarizer[]; skipped: string[] } {
  const providers: Summarizer[] = [];
  const skipped: string[] = [];
  if ((opts.writer ?? process.env.INGEST_WRITER) === 'codex') {
    providers.push(createCodexSummarizer({ exe: opts.codexExe ?? process.env.CODEX_EXE ?? config.codex.exe }));
    if (keys.groqApiKey) providers.push(createGroqSummarizer({ apiKey: keys.groqApiKey, ...opts }));
    else skipped.push('groq (GROQ_API_KEY not set)');
    providers.push(templateSummarizer);
    return { providers, skipped };
  }
  for (const name of config.providerOrder) {
    if (name === 'gemini') {
      if (keys.geminiApiKey) providers.push(createGeminiSummarizer({ apiKey: keys.geminiApiKey, ...opts }));
      else skipped.push('gemini (GEMINI_API_KEY not set)');
    } else if (name === 'groq') {
      if (keys.groqApiKey) providers.push(createGroqSummarizer({ apiKey: keys.groqApiKey, ...opts }));
      else skipped.push('groq (GROQ_API_KEY not set)');
    } else if (name === 'template') {
      providers.push(templateSummarizer);
    }
  }
  return { providers, skipped };
}
