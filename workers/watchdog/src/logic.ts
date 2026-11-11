// Pure watchdog logic (no I/O): what is wrong, which sources to re-trigger, and text clean-up for alerts.
// Inputs: the JSON from api.feed_status() and api.ops_status() and the current time.
// Outputs: a list of problems (one per kind), the sources to re-trigger, and sanitized strings.

export const STALE_HOURS = 3;
export const QUIET_HOURS = 24;
export const QUIET_HOURS_WEEKEND = 48;
export const EXPECTED_JOBS = 22;                   // 15 before M9 + bls, beadata, eia, auctions, fomc + element-prune-reports + element-prune-subscribe-attempts
export const AI_WARN_FRACTION = 0.8;
export const DB_WARN_MB = 400;
/** Supply floors (setting `supply_floor_cards_24h`, `supply_floor_cards_market_hour`; the Worker vars SUPPLY_FLOOR_CARDS_24H / SUPPLY_FLOOR_CARDS_MARKET_HOUR override them). 0 = check off. */
export const SUPPLY_FLOOR_CARDS_24H = 10;            // 2 x the 30-day median of 5 cards a day (D-114, R-254)
export const SUPPLY_FLOOR_CARDS_MARKET_HOUR = 0;     // off until the readout is rerun
export interface SupplyFloors { cards24h: number; cardsMarketHour: number }
export const DEFAULT_SUPPLY_FLOORS: SupplyFloors = { cards24h: SUPPLY_FLOOR_CARDS_24H, cardsMarketHour: SUPPLY_FLOOR_CARDS_MARKET_HOUR };
export const RETRIGGER_EVERY_HOURS = 6;
export const RETRIGGER_COUNT = 4;
/** Same order as pg_cron's hourly schedule (supabase/migrations/20261019050000_cron_schedule.sql). */
export const SOURCES = ['macro', 'fed', 'bea', 'fedreg', 'sec', 'wiki', 'cpsc', 'usgs', 'nasa'] as const;

export interface FeedStatus { last_published_at: string | null; last_ok_run_at: string | null; delayed: boolean }
export interface AiRow { provider: string; used: number; cap: number; reserve?: number; at_cap_3_days?: boolean }
export interface OpsStatus {
  now?: string;
  jobs: number | null;
  cron_failures_24h: number | null;
  http_non2xx_24h: number | null;
  hung_open: number;
  killed_24h: number;
  model_missing: number;
  ai: AiRow[];
  db_size_mb: number | null;
  /** Cards published in the last 24 h / 60 min (api.ops_status since 20261129000000_supply_ops.sql); absent on an older database. */
  cards_24h?: number | null;
  cards_1h?: number | null;
}

export type Kind = 'stale' | 'quiet' | 'jobs' | 'cron' | 'hung' | 'model' | 'ai' | 'db' | 'supply' | 'supabase';
export const ALL_KINDS: readonly Kind[] = ['stale', 'quiet', 'jobs', 'cron', 'hung', 'model', 'ai', 'db', 'supply', 'supabase'];

export interface Problem { kind: Kind; title: string; detail: string }

/** Removes anything that looks like a key, token, uuid or long opaque string, then cuts to 200 characters. */
export function sanitize(text: unknown, max = 200): string {
  let s = String(text ?? '');
  s = s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')                                   // JWTs
    .replace(/\b(?:sb_(?:secret|publishable)_|ghp_|gho_|ghs_|github_pat_|hc_|sk-)[\w-]+/gi, '[redacted]')   // known key prefixes
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')  // uuids (user ids, check ids)
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[redacted]')                                  // any long opaque string
    .replace(/[\r\n]+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const hoursSince = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 3_600_000 : null;
};

/** Quiet-content window: 48 h from Saturday 00:00 UTC through Monday 12:00 UTC, 24 h otherwise. */
export function quietThresholdHours(now: Date): number {
  const d = now.getUTCDay();   // 0 Sunday .. 6 Saturday
  const weekend = d === 6 || d === 0 || (d === 1 && now.getUTCHours() < 12);
  return weekend ? QUIET_HOURS_WEEKEND : QUIET_HOURS;
}

/** True during US market hours in New York: Mon-Fri, 10:00-16:59 ET, so the last 60 minutes sit inside the 09:30-16:00 session. DST handled by Intl. */
export function isMarketHourEt(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return !['Sat', 'Sun'].includes(wd) && hour >= 10 && hour <= 16;
}

/** Parses a floor from a Worker var: a whole number of 0 or more, else the default. */
export function parseFloor(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && /^\d{1,4}$/.test(v.trim()) ? Number(v.trim()) : typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Every current problem, at most one per kind. `ops` or `feed` null = that call failed (the 'supabase' kind covers it). */
export function evaluate(feed: FeedStatus | null, ops: OpsStatus | null, now: Date, supabaseError?: string, floors: SupplyFloors = DEFAULT_SUPPLY_FLOORS): Problem[] {
  const out: Problem[] = [];
  if (!feed || !ops) {
    out.push({
      kind: 'supabase', title: 'Supabase did not answer',
      detail: `feed_status ${feed ? 'ok' : 'failed'}, ops_status ${ops ? 'ok' : 'failed'}${supabaseError ? `: ${sanitize(supabaseError)}` : ''}. The project may be paused (Dashboard, Restore) or a key/token changed.`,
    });
  }
  if (feed) {
    if (feed.delayed) {
      const h = hoursSince(feed.last_ok_run_at, now);
      out.push({
        kind: 'stale', title: 'Pipeline stale: no clean run in 3 hours',
        detail: `last clean run ${h === null ? 'never' : `${h.toFixed(1)} h ago`}, last card ${hoursSince(feed.last_published_at, now)?.toFixed(1) ?? 'never'} h ago.`,
      });
    }
    const q = hoursSince(feed.last_published_at, now);
    const limit = quietThresholdHours(now);
    if (q !== null && q > limit) {
      out.push({ kind: 'quiet', title: `No new card in ${limit} hours`, detail: `newest card is ${q.toFixed(1)} h old. News can be quiet, so check the sources before acting.` });
    }
  }
  if (ops) {
    if (ops.jobs !== null && ops.jobs !== EXPECTED_JOBS) {
      out.push({ kind: 'jobs', title: `Cron jobs: ${ops.jobs} of ${EXPECTED_JOBS}`, detail: 'Re-apply the cron migrations (20261019050000_cron_schedule.sql, 20261111000000_finance_sources_cron.sql, 20261112000000_ranking_v3.sql), or update EXPECTED_JOBS if a job was added on purpose.' });
    }
    const cron = ops.cron_failures_24h ?? 0, http = ops.http_non2xx_24h ?? 0;
    if (cron > 0 || http > 0) {
      out.push({ kind: 'cron', title: 'Cron or function call failures', detail: `last 24 h: ${cron} failed cron runs, ${http} non-2xx function replies (net._http_response).` });
    }
    if (ops.hung_open + ops.killed_24h > 0) {
      out.push({ kind: 'hung', title: 'Hung or killed runs', detail: `${ops.hung_open} open for over 10 minutes, ${ops.killed_24h} marked killed in the last 24 h. See ingest.run_log.` });
    }
    if (ops.model_missing > 0) {
      out.push({ kind: 'model', title: 'An AI model was retired', detail: `${ops.model_missing} runs in 24 h used the fallback model. Put a new model ID in ingest/src/config.ts and redeploy both functions.` });
    }
    const aiBad = ops.ai.filter((a) => a.cap > 0 && (a.used / a.cap >= AI_WARN_FRACTION || a.at_cap_3_days));
    if (aiBad.length) {
      out.push({
        kind: 'ai', title: 'AI quota high',
        detail: aiBad.map((a) => `${sanitize(a.provider, 30)} ${a.used}/${a.cap}${a.at_cap_3_days ? ' (at the cap 3 days in a row)' : ''}`).join('; '),
      });
    }
    if (ops.db_size_mb !== null && ops.db_size_mb > DB_WARN_MB) {
      out.push({ kind: 'db', title: 'Database size', detail: `${ops.db_size_mb} MB of the 500 MB free tier.` });
    }
    // Supply floor: one problem, 24 h floor first. A missing count (older database) skips the check.
    const c24 = ops.cards_24h, c1 = ops.cards_1h;
    if (floors.cards24h > 0 && typeof c24 === 'number' && c24 < floors.cards24h) {
      out.push({ kind: 'supply', title: `Card supply low: ${c24} cards in 24 hours`, detail: `floor is ${floors.cards24h} cards in 24 h (2 x the 30-day median). Run node scripts/supply-readout.mjs to see which source or gate is limiting.` });
    } else if (floors.cardsMarketHour > 0 && typeof c1 === 'number' && c1 < floors.cardsMarketHour && isMarketHourEt(now)) {
      out.push({ kind: 'supply', title: `Card supply low: ${c1} cards in the last market hour`, detail: `floor is ${floors.cardsMarketHour} cards per market hour. Run node scripts/supply-readout.mjs (market_hour_gaps_14d).` });
    }
  }
  return out;
}

/** Rotating sample of RETRIGGER_COUNT sources: the start moves each 6 h slot, so every source gets its turn. */
export function pickSources(now: Date): string[] {
  const slot = Math.floor(now.getTime() / (RETRIGGER_EVERY_HOURS * 3_600_000));
  return Array.from({ length: RETRIGGER_COUNT }, (_, i) => SOURCES[(slot * RETRIGGER_COUNT + i) % SOURCES.length]!);
}

/** Re-trigger only in the first cron run of each 6-hour block (hours 0, 6, 12, 18 UTC), so at most once per 6 h without stored state. */
export function retriggerDue(now: Date): boolean {
  return now.getUTCHours() % RETRIGGER_EVERY_HOURS === 0;
}
