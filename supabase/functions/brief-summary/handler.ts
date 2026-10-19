// brief-summary: the daily (and, when due, weekly) AI summary at the top of the Brief, once per period.
// Cloud version of `node src/main.ts --brief-summary --kind both` (ingest/src/mailCli.ts summary path).
// The job itself is ingest/src/briefSummary.ts, unchanged: read api.daily_brief / api.weekly_brief,
// skip a period that already has its summary, Gemini -> Groq -> template (each AI draft validated,
// one retry with the errors), write with the service-role api.put_brief_summary.
// Differences from the laptop: AI calls are counted in the database (usage.ts, caps shared with the
// ingest), a time budget closes the AI before the 150 s wall clock, and one ingest.run_log row is written.
// Inputs: options { kind: daily|weekly|both, force, dry_run, no_ai }, env, optional fakes for tests.
// Outputs: { ok, outcomes: [{ kind, status, for_date, model }], ai_calls, run } (no summary text, no keys).

import { buildTextModels, createMailRpc, fetchBrief, runBriefSummary, type BriefInput, type BriefKind, type FetchLike, type TextModel } from '../_shared/ingest.ts';
import { createTimeBudget, type TimeBudget } from '../_shared/budget.ts';
import { describeFunctionEnv, truthy, type FunctionEnv } from '../_shared/env.ts';
import { createServiceRpc, type Rpc } from '../_shared/rpc.ts';
import { buildRunSummary, runLogPayload, type RunSummary } from '../_shared/runSummary.ts';
import { createUsageTracker, rpcUsageStore, textModelWithUsage, type UsageStore } from '../_shared/usage.ts';

export interface BriefSummaryOptions {
  kinds: BriefKind[];
  force: boolean;
  dryRun: boolean;
  noAi: boolean;
}

/** Parses the request options. Throws on a bad kind. */
export function parseBriefOptions(o: Record<string, unknown>): BriefSummaryOptions {
  const k = o.kind ?? 'both';
  const kinds: BriefKind[] = k === 'daily' ? ['daily'] : k === 'weekly' ? ['weekly'] : k === 'both' ? ['daily', 'weekly'] : [];
  if (!kinds.length) throw new Error('kind must be daily, weekly or both');
  return { kinds, force: truthy(o.force), dryRun: truthy(o.dry_run), noAi: truthy(o.no_ai) };
}

export interface BriefSummaryDeps {
  env: FunctionEnv;
  fetchImpl?: FetchLike;            // tests: fake network
  rpc?: Rpc;                        // tests: fake service RPC (usage + run log)
  usageStore?: UsageStore;          // tests: memory store
  models?: TextModel[];             // tests: fake models (default: from the keys)
  fetchBrief?: (kind: BriefKind) => Promise<BriefInput>;
  putSummary?: (kind: BriefKind, forDate: string, text: string, model: string) => Promise<unknown>;
  budget?: TimeBudget;
  now?: () => number;
}

export interface BriefSummaryResult {
  ok: boolean;
  outcomes: Array<{ kind: BriefKind; status: string; for_date: string; model?: string }>;
  ai_calls: number;
  run: RunSummary;
}

export async function handleBriefSummary(deps: BriefSummaryDeps, opts: BriefSummaryOptions): Promise<BriefSummaryResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budget = deps.budget ?? createTimeBudget({ now });
  const log: string[] = [];
  const say = (s: string) => { log.push(s); console.log(s); };
  const env = deps.env;
  const rpc = deps.rpc ?? createServiceRpc({ url: env.supabaseUrl, key: env.serviceKey, fetchImpl: deps.fetchImpl });
  const tracker = await createUsageTracker(deps.usageStore ?? rpcUsageStore(rpc));
  for (const e of tracker.errors) say(`warning: ${e}`);

  const base = opts.noAi ? [] : (deps.models ?? buildTextModels({ geminiApiKey: env.geminiApiKey, groqApiKey: env.groqApiKey }, deps.fetchImpl));
  const models = base.map((m) => textModelWithUsage(m, tracker, (w) => budget.aiAllowed(w)));
  say(`brief summary: ${opts.kinds.join(' + ')}${opts.dryRun ? ' (dry run)' : ''}; models: ${models.map((m) => m.name).join(' -> ') || 'template only'}; ${describeFunctionEnv(env)}`);

  const mail = opts.dryRun || deps.putSummary ? null : createMailRpc({ url: env.supabaseUrl, key: env.serviceKey, fetchImpl: deps.fetchImpl });
  let outcomes: BriefSummaryResult['outcomes'] = [];
  let error: string | null = null;
  try {
    const res = await runBriefSummary({
      fetchBrief: deps.fetchBrief ?? ((kind) => fetchBrief(kind, { url: env.supabaseUrl, key: env.readKey, fetchImpl: deps.fetchImpl })),
      putSummary: opts.dryRun ? undefined : (deps.putSummary ?? ((kind, d, text, model) => mail!.putBriefSummary(kind, d, text, model))),
      models, counter: tracker.counter, now: new Date(startedAt), log: say,
    }, { kinds: opts.kinds, force: opts.force, dryRun: opts.dryRun });
    outcomes = res.map((o) => ({ kind: o.kind, status: o.status, for_date: o.for_date, model: o.model }));
  } catch (e) {
    error = (e as Error).message;
    say(`error: ${error}`);
  }

  const written = outcomes.filter((o) => o.status === 'written').length;
  const run = buildRunSummary({
    source: 'brief-summary', startedAt, finishedAt: now(),
    stats: { published: written, skipped: outcomes.length - written, failed: error ? 1 : 0 },
    guard: { itemsNew: outcomes.length, deferredTime: 0, deferredCap: 0, stoppedBy: 'done' },
    aiCalls: tracker.totalTaken(), aiDenied: tracker.denied, error, log,
  });
  if (!opts.dryRun) {
    try { await rpc('log_run', { p: runLogPayload(run) }); } catch (e) { console.log(`warning: run log not written: ${(e as Error).message}`); }
  }
  return { ok: !error, outcomes, ai_calls: run.ai_calls, run };
}
