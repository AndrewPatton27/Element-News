// One-off macro history backfill:  node src/main.ts --backfill-macro [--weeks 16]
// api.number_trends (the web Trends charts) needs ~12 weekly points per series, but the normal
// macro run stores only the latest reading. This fetches FRED history for the enabled series and
// writes each reading through the same api.upsert_macro path (idempotent: keyed on series + date).
// Writes the Numbers-panel rows only: it NEVER publishes data cards for old readings.
// Inputs: Deps (fetcher, publisher, FRED key, clock, log) and { weeks }.
// Outputs: BackfillStats (readings written per series); rows via deps.publisher.upsertMacro.

import { aiDailyCap, config, groqDailyCap } from './config.ts';
import { runOnce, SOURCE_NAMES, type Deps, type RunStats, type SourceName } from './pipeline.ts';
import { buildObservation, fredUrl, parseFredObservations, SERIES, type Frequency, type Point } from './sources/macro.ts';

export interface BackfillOptions {
  weeks?: number;                          // history window; default config.backfillWeeksDefault
  pauseMs?: number;                        // pause between FRED requests (default config.backfillPauseMs; tests pass 0)
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillStats {
  weeks: number;
  series: Record<string, number>;          // readings written per series
  written: number;
  failed: number;
}

/** Wide enough fetch window: the history asked for plus 800 days so CPI year-over-year exists for every kept month. */
export function backfillFetchDays(weeks: number): number {
  return weeks * 7 + 800;
}

/**
 * How many of the newest readings to write. Daily and weekly series: every reading in the last
 * `weeks` weeks. Monthly: at least 14 months (the chart shows 12). Quarterly: at least 8 quarters.
 */
export function selectBackfillPoints(freq: Frequency, points: Point[], weeks: number): Point[] {
  if (points.length === 0) return [];
  const newest = points[points.length - 1].date;
  if (freq === 'daily' || freq === 'weekly') {
    const cutoff = new Date(new Date(`${newest}T00:00:00Z`).getTime() - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
    return points.filter((p) => p.date >= cutoff);
  }
  const n = freq === 'monthly' ? Math.max(14, Math.ceil(weeks / 4.345)) : Math.max(8, Math.ceil(weeks / 13));
  return points.slice(-n);
}

/** Fetch history for each enabled series and upsert one observation per reading. A failing series is logged and skipped. */
export async function runBackfill(deps: Deps, opts: BackfillOptions = {}): Promise<BackfillStats> {
  const weeks = opts.weeks ?? config.backfillWeeksDefault;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 520) throw new Error('--weeks needs a whole number from 1 to 520');
  const stats: BackfillStats = { weeks, series: {}, written: 0, failed: 0 };
  if (!deps.fredApiKey) { deps.log('backfill: FRED_API_KEY not set, nothing to do'); return stats; }
  const pause = opts.pauseMs ?? config.backfillPauseMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = new Date(deps.now.getTime() - backfillFetchDays(weeks) * 86_400_000).toISOString().slice(0, 10);

  let first = true;
  for (const id of config.macroSeries) {
    if ((config.forbiddenSeries as readonly string[]).includes(id)) { deps.log(`backfill: ${id}: forbidden series, skipped`); continue; }
    const info = SERIES[id];
    if (!info) { deps.log(`backfill: ${id}: unknown series, skipped`); continue; }
    if (!first && pause > 0) await sleep(pause);                    // stay far under FRED's 120 requests/minute
    first = false;
    try {
      const url = new URL(fredUrl(id, start));
      url.searchParams.set('api_key', deps.fredApiKey);              // never logged: errors print the host only
      const all = parseFredObservations(await deps.fetchText(url.toString(), 'api', 0));
      const keep = selectBackfillPoints(info.frequency, all, weeks);
      const firstKept = keep.length ? keep[0].date : '';
      let n = 0;
      for (const p of keep) {
        // history up to this reading, so change/prev and year-over-year match what the live run stored on that day
        const upTo = all.slice(0, all.findIndex((q) => q.date === p.date) + 1);
        const obs = buildObservation(id, upTo);
        if (!obs || obs.obs_date < firstKept) continue;
        await deps.publisher.upsertMacro(obs);
        n++;
      }
      stats.series[id] = n;
      stats.written += n;
      deps.log(`backfill: ${id}: ${n} readings (${keep.length ? `${keep[0].date} to ${keep[keep.length - 1].date}` : 'none'})`);
    } catch (e) {
      stats.failed++;
      deps.log(`backfill: ${id}: ${(e as Error).message}`);
    }
  }
  return stats;
}

// ---- card backfill:  node src/main.ts --backfill-cards [--days 7] [--limit N] [--only a,b] --------------------
// Re-runs the normal ingest (same dedupe, relevance gate, validation, publish) over the last `days` days of
// every news source, in rounds, until a round adds nothing or the AI budget is gone. Items already handled
// are skipped, so it is safe to repeat. Cards keep their source date (published_at/sort_at), so they sort
// into the past, not to "now". Macro and treasury data cards are excluded (they only describe the latest reading).

export interface CardBackfillOptions {
  days?: number;                           // default config.cardBackfill.daysDefault
  limit?: number;                          // items summarized per round (default config.cardBackfill.limitPerRound)
  only?: SourceName[];                     // default: every news source
  maxRounds?: number;                      // default config.cardBackfill.maxRounds
}

export interface CardBackfillStats {
  days: number;
  rounds: number;
  published: number;
  stoppedBy: 'no_new_cards' | 'ai_budget' | 'max_rounds';
  perRound: RunStats[];
}

/** News sources only (no data-card sources). */
export function newsSources(): SourceName[] {
  const skip = [...config.cardBackfill.excludeSources, ...config.cardBackfill.defaultSkipSources] as readonly string[];
  return SOURCE_NAMES.filter((n) => !skip.includes(n));
}

/** AI calls left today across the providers in this run (gemini + groq; template costs nothing). */
export function aiCallsLeft(deps: Pick<Deps, 'providers' | 'counter'>): number {
  let left = 0;
  for (const p of deps.providers) {
    if (p.name === 'gemini') left += Math.max(0, aiDailyCap() - deps.counter.used('gemini'));
    if (p.name === 'groq') left += Math.max(0, groqDailyCap() - deps.counter.used('groq'));
  }
  return left;
}

export async function runCardBackfill(deps: Deps, opts: CardBackfillOptions = {}): Promise<CardBackfillStats> {
  const cb = config.cardBackfill;
  const days = opts.days ?? cb.daysDefault;
  if (!Number.isInteger(days) || days < 1 || days > cb.daysMax) throw new Error(`--days needs a whole number from 1 to ${cb.daysMax}`);
  const only = opts.only?.length ? opts.only : newsSources();
  const bad = only.filter((n) => (cb.excludeSources as readonly string[]).includes(n));
  if (bad.length) throw new Error(`--backfill-cards does not take data-card sources: ${bad.join(', ')}`);
  const limit = opts.limit ?? cb.limitPerRound;
  const maxRounds = opts.maxRounds ?? cb.maxRounds;
  const stats: CardBackfillStats = { days, rounds: 0, published: 0, stoppedBy: 'max_rounds', perRound: [] };
  // Feeds with a short own window (Fed speeches 30 d, SEC press 14 d) are widened to the backfill window for this run only.
  const saved = { speech: config.fedSpeechMaxAgeDays, press: config.secPressMaxAgeDays };
  (config as { fedSpeechMaxAgeDays: number }).fedSpeechMaxAgeDays = Math.max(saved.speech, days);
  (config as { secPressMaxAgeDays: number }).secPressMaxAgeDays = Math.max(saved.press, days);
  try { return await backfillRounds(deps, only, limit, maxRounds, days, stats); }
  finally { (config as { fedSpeechMaxAgeDays: number }).fedSpeechMaxAgeDays = saved.speech; (config as { secPressMaxAgeDays: number }).secPressMaxAgeDays = saved.press; }
}

async function backfillRounds(deps: Deps, only: SourceName[], limit: number, maxRounds: number, days: number, stats: CardBackfillStats): Promise<CardBackfillStats> {
  const cb = config.cardBackfill;
  const usesAi = deps.providers.some((p) => p.name === 'gemini' || p.name === 'groq');

  for (let round = 1; round <= maxRounds; round++) {
    const left = aiCallsLeft(deps);
    // Stop before the chain falls through to template cards just because the AI quota ran out.
    if (usesAi && left <= cb.aiReserve) {
      deps.log(`backfill-cards: AI budget used (${left} calls left, reserve ${cb.aiReserve}); stopping`);
      stats.stoppedBy = 'ai_budget';
      return stats;
    }
    const budget = usesAi ? Math.min(limit, left - cb.aiReserve) : limit;
    const r = await runOnce(deps, { only, limit: budget, maxItemAgeDays: days });
    stats.rounds = round;
    stats.perRound.push(r);
    stats.published += r.published;
    deps.log(`backfill-cards: round ${round}: ${r.published} published, ${r.skipped} skipped, ${r.failed} failed`);
    if (r.published === 0 && r.ai === 0 && r.template === 0) { stats.stoppedBy = 'no_new_cards'; return stats; }   // AI-rejected rounds still moved the queue forward
  }
  return stats;
}

/**
 * Counter that starts from the cloud's AI usage today (api.ai_usage_get) so a laptop backfill respects the same caps,
 * and writes its own calls back with api.ai_usage_take when `flush` runs (so the cloud runs see them).
 */
export async function sharedAiCounter(url: string, serviceKey: string, fetchImpl: typeof fetch = fetch): Promise<{ counter: Deps['counter']; flush: () => Promise<number> }> {
  const call = async (name: string, body: unknown) => {
    const r = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`rpc ${name}: HTTP ${r.status}`);
    return r.json() as Promise<unknown>;
  };
  const start = (await call('ai_usage_get', {})) as Record<string, number>;
  const added = new Map<string, number>();
  const counter: Deps['counter'] = {
    used: (p) => (start[p] ?? 0) + (added.get(p) ?? 0),
    add: (p) => added.set(p, (added.get(p) ?? 0) + 1),
  };
  const caps: Record<string, number> = { gemini: aiDailyCap(), groq: groqDailyCap() };
  const flush = async () => {
    let n = 0;
    for (const [p, c] of added) for (let i = 0; i < c; i++) { if (await call('ai_usage_take', { p_provider: p, p_cap: caps[p] ?? 1_000_000 }) === true) n++; }
    added.clear();
    return n;
  };
  return { counter, flush };
}
