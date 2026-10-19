// ingest-source: ONE ingest source per call (macro, fed, bea, fedreg, sec, wiki, cpsc, usgs, nasa),
// the cloud version of one slice of `node src/main.ts --once` (ingest/src/main.ts live path).
// The pipeline is ingest/src/pipeline.ts runOnce({ only: [source], limit: workCap }), unchanged:
// allowlisted fetchers and parsers, topic filter, license gate, Gemini -> Groq -> template chain with
// the validator, the report-card scorer when REPORT_CARD_PROTOCOL=1, and the service-role publisher.
// Added around it (see _shared): the database AI counter (caps across runs), a time budget (no new item
// after softMs = 100 s, no AI call that could end after hardMs = 140 s, 150 s is the platform limit),
// a work cap (default 5 new items), and one ingest.run_log row. Optional `finish`: refresh Trending and
// purge old ML rows afterwards (the last source of each hour does this).
// Inputs: options { source, work_cap, finish }, env, optional fakes for tests.
// Outputs: RunSummary JSON (counts, stop reason, last log lines; no keys, no source text).

import {
  buildProviders, createSupabasePublisher, fetchAllowed, SOURCE_NAMES, runOnce, wikimediaUserAgent,
  type Deps, type FetchLike, type Publisher, type RunStats, type SourceName, type Summarizer,
} from '../_shared/ingest.ts';
import { createTimeBudget, guardFetch, guardPublisher, type TimeBudget } from '../_shared/budget.ts';
import { describeFunctionEnv, truthy, type FunctionEnv } from '../_shared/env.ts';
import { createServiceRpc, type Rpc } from '../_shared/rpc.ts';
import { buildRunSummary, runLogPayload, type RunSummary } from '../_shared/runSummary.ts';
import { createUsageTracker, rpcUsageStore, withUsage, type UsageStore } from '../_shared/usage.ts';

export const DEFAULT_WORK_CAP = 5;
export const MAX_WORK_CAP = 20;

export interface IngestOptions {
  source: SourceName;
  workCap: number;
  finish: boolean;
  /** tests only: skip the run-log row */
  noRunLog?: boolean;
}

/** Parses the request options. Throws on an unknown source or a bad work_cap. */
export function parseIngestOptions(o: Record<string, unknown>): IngestOptions {
  const source = String(o.source ?? '');
  if (!(SOURCE_NAMES as readonly string[]).includes(source)) throw new Error(`source must be one of ${SOURCE_NAMES.join(', ')}`);
  const cap = o.work_cap === undefined || o.work_cap === '' ? DEFAULT_WORK_CAP : Number(o.work_cap);
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_WORK_CAP) throw new Error(`work_cap must be a whole number from 1 to ${MAX_WORK_CAP}`);
  return { source: source as SourceName, workCap: cap, finish: truthy(o.finish) };
}

export interface IngestDeps {
  env: FunctionEnv;
  fetchImpl?: FetchLike;                 // tests: fake network for fetchAllowed
  fetchText?: Deps['fetchText'];         // tests: fixture fetcher (replaces the live one)
  publisher?: Publisher;                 // tests / dry run: in-memory publisher
  providers?: Summarizer[];              // tests: fake providers (default: from the keys)
  rpc?: Rpc;
  usageStore?: UsageStore;
  budget?: TimeBudget;
  now?: () => number;
  clock?: () => Date;                    // the pipeline's "now" (fixtures need a fixed day)
}

/** Live fetcher: like ingest/src/main.ts liveFetcher, but never caches to disk (Edge Functions have none). */
export function liveFetchText(env: FunctionEnv, fetchImpl?: FetchLike): Deps['fetchText'] {
  const ua = env.secUserAgent ?? '';
  const wikiUa = wikimediaUserAgent(ua) ?? ua;
  const host = new URL(env.supabaseUrl).hostname;
  return async (url, kind) => {
    const r = await fetchAllowed(url, {
      kind, userAgent: new URL(url).hostname === 'en.wikipedia.org' ? wikiUa : ua,
      extraHosts: [host], cacheTtlMinutes: 0, fetchImpl,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return r.text;
  };
}

export async function handleIngestSource(deps: IngestDeps, opts: IngestOptions): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budget = deps.budget ?? createTimeBudget({ now });
  const log: string[] = [];
  const say = (s: string) => { log.push(s); console.log(s); };
  const env = deps.env;
  const rpc = deps.rpc ?? createServiceRpc({ url: env.supabaseUrl, key: env.serviceKey, fetchImpl: deps.fetchImpl });
  const tracker = await createUsageTracker(deps.usageStore ?? rpcUsageStore(rpc));
  for (const e of tracker.errors) say(`warning: ${e}`);

  let stats: RunStats | undefined;
  let error: string | null = null;
  const guarded = guardPublisher(
    deps.publisher ?? createSupabasePublisher({ url: env.supabaseUrl, key: env.serviceKey, fetchImpl: deps.fetchImpl }),
    budget, opts.workCap,
  );
  try {
    if ((opts.source === 'sec' || opts.source === 'wiki') && !env.secUserAgent && !deps.fetchText) {
      throw new Error('SEC_USER_AGENT is not set ("<app name> <contact email>"); SEC and Wikipedia need it');
    }
    const base = deps.providers ?? buildProviders({ geminiApiKey: env.geminiApiKey, groqApiKey: env.groqApiKey }, { fetchImpl: deps.fetchImpl }).providers;
    const providers = base.map((p) => withUsage(p, tracker, p.dailyCap ?? 0, (w) => budget.aiAllowed(w)));
    say(`ingest-source ${opts.source}: work cap ${opts.workCap}, soft ${budget.softMs} ms, hard ${budget.hardMs} ms; summarizers ${providers.map((p) => p.name).join(' -> ')}; ${describeFunctionEnv(env)}`);
    const pipelineDeps: Deps = {
      fetchText: guardFetch(deps.fetchText ?? liveFetchText(env, deps.fetchImpl), budget),
      publisher: guarded.publisher,
      providers,
      counter: tracker.counter,
      fredApiKey: env.fredApiKey,
      now: deps.clock?.() ?? new Date(startedAt),
      log: say,
      reportCard: env.reportCard ? { enabled: true } : undefined,
    };
    stats = await runOnce(pipelineDeps, { only: [opts.source], limit: opts.workCap });
    if (opts.finish) await finishRun(guarded.publisher, say);
  } catch (e) {
    error = (e as Error).message;
    say(`error: ${error}`);
  }
  if (guarded.counts.deferredTime || guarded.counts.deferredCap) {
    say(`stopped early (${guarded.counts.stoppedBy}): ${guarded.counts.deferredTime + guarded.counts.deferredCap} items left for the next run`);
  }
  const run = buildRunSummary({
    source: opts.source, startedAt, finishedAt: now(), stats, guard: guarded.counts,
    aiCalls: tracker.totalTaken(), aiDenied: tracker.denied, error, log,
  });
  if (!opts.noRunLog) {
    try { await rpc('log_run', { p: runLogPayload(run) }); } catch (e) { console.log(`warning: run log not written: ${(e as Error).message}`); }
  }
  return run;
}

/** End of the hour: Trending refresh and ML purge, like ingest/src/main.ts after a run. Never throws. */
export async function finishRun(publisher: Publisher, log: (s: string) => void): Promise<void> {
  try { if (publisher.refreshTrending) log(`trending refreshed: ${JSON.stringify(await publisher.refreshTrending())}`); }
  catch (e) { log(`warning: trending refresh failed (${(e as Error).message})`); }
  try { if (publisher.mlPurge) log(`ml purge: ${JSON.stringify(await publisher.mlPurge())}`); }
  catch (e) { log(`warning: ml purge failed (${(e as Error).message})`); }
}
