// The ONE place where the Edge Functions import the ingest code (ingest/src, plain TypeScript with
// only node: built-ins and no npm packages, so it runs unchanged on Deno).
// Every other file in supabase/functions imports ingest code through this file, so if the deploy
// bundler cannot reach files outside supabase/functions, only these paths change.
// Do not edit ingest/ from here: it belongs to the ingest script.
// Inputs/outputs: re-exports only.

export { config, aiDailyCap, groqDailyCap } from '../../../ingest/src/config.ts';
export { fetchAllowed, AllowlistError, type FetchLike } from '../../../ingest/src/allowlist.ts';
export { runOnce, SOURCE_NAMES, type Deps, type RunStats, type SourceName } from '../../../ingest/src/pipeline.ts';
export { createSupabasePublisher, createDryRunPublisher, type Publisher } from '../../../ingest/src/publish.ts';
export { buildProviders } from '../../../ingest/src/summarizer/providers.ts';
export { templateSummarizer } from '../../../ingest/src/summarizer/template.ts';
export { memoryCounter, type UsageCounter } from '../../../ingest/src/summarizer/chain.ts';
export { wikimediaUserAgent } from '../../../ingest/src/sources/wiki.ts';
export {
  buildTextModels, fetchBrief, runBriefSummary, isRpcMissing, RpcMissingError,
  type BriefInput, type BriefKind, type SummaryJobOutcome, type TextModel,
} from '../../../ingest/src/briefSummary.ts';
export { createMailRpc } from '../../../ingest/src/mailRpc.ts';
export type { Summarizer } from '../../../ingest/src/types.ts';
