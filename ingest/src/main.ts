// CLI.  node src/main.ts [--dry-run] [--once | --loop | --rewrite] [--only sec,fed,...] [--limit N] [--json]
//   --dry-run  read fixtures from src/fixtures, no network, no keys, publish nothing
//   --once     one run (default)
//   --loop     run every config.pollIntervalMinutes until stopped (Ctrl+C)
//   --rewrite  redo published cards written with an older prompt/template version, in place
//              (--limit = max cards; with --dry-run: the cards in src/fixtures/rewrite-cards.json)
//   --backfill-macro  one-off: FRED history for the Trends charts via api.upsert_macro (no data cards);
//              --weeks N = weeks of history (default 16); with --dry-run: DGS10 fixture only
//   --only     comma-separated subset of sources (macro, fed, bea, fedreg, sec, wiki, cpsc, usgs, nasa)
//   --limit    max news items summarized per run (default 20)
//   --json     with --dry-run: print the card payloads as JSON
//   --fix-category <card-id> <slug>   re-file one card (service role; api.set_card_category)
//   --audit-cards [--apply]   score live cards against the report card (dry run unless --apply)
//   REPORT_CARD_PROTOCOL=1   env flag: score each new AI card with Groq before publishing (off by default)
//   --brief-summary [--kind daily|weekly|both] [--force] [--dry-run] [--no-ai]   AI summary of the brief, once per day/week (mailCli.ts)
//   --send-briefs [--send] [--dry-run]   confirmation + scheduled brief emails; outbox files unless --send and the provider env vars (mailCli.ts)
// Inputs: command-line flags and, for live runs, .env / process.env (keys are never printed).
// Outputs: log lines on stdout, cards published to Supabase (live) or printed (dry run); exit code.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllowed } from './allowlist.ts';
import { config, describeEnv, fedRegisterUrls, readEnv } from './config.ts';
import { runOnce, SOURCE_NAMES, type Deps, type SourceName } from './pipeline.ts';
import { runBackfill } from './backfill.ts';
import { runRewrite } from './rewrite.ts';
import { runAudit, groqRevision } from './audit.ts';
import { isMailCommand, mailMain } from './mailCli.ts';
import type { RevisableCard } from './types.ts';
import { createDryRunPublisher, createSupabasePublisher } from './publish.ts';
import { fileCounter, memoryCounter } from './summarizer/chain.ts';
import { buildProviders } from './summarizer/providers.ts';
import { templateSummarizer } from './summarizer/template.ts';
import { cpscUrl } from './sources/cpsc.ts';
import { nasaFeedUrl } from './sources/nasa.ts';
import { wikimediaUserAgent, wikiFeedUrl } from './sources/wiki.ts';

export interface Args {
  dryRun: boolean;
  loop: boolean;
  only: SourceName[];
  limit: number;
  json: boolean;
  rewrite: boolean;
  backfillMacro: boolean;
  weeks: number;
}

/** Parses CLI flags (see the header). Throws on an unknown option, an unknown --only source or a bad --limit. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, loop: false, only: [], limit: 20, json: false, rewrite: false, backfillMacro: false, weeks: config.backfillWeeksDefault };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--once') a.loop = false;
    else if (k === '--loop') a.loop = true;
    else if (k === '--json') a.json = true;
    else if (k === '--rewrite') a.rewrite = true;
    else if (k === '--backfill-macro') a.backfillMacro = true;
    else if (k === '--weeks') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 520) throw new Error('--weeks needs a whole number from 1 to 520');
      a.weeks = n;
    }
    else if (k === '--only') {
      const v = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of v) if (!(SOURCE_NAMES as readonly string[]).includes(s)) throw new Error(`--only: unknown source "${s}" (use ${SOURCE_NAMES.join(', ')})`);
      a.only = v as SourceName[];
    } else if (k === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error('--limit needs a whole number');
      a.limit = n;
    } else throw new Error(`unknown option: ${k}`);
  }
  return a;
}

// ---- dry-run fixtures ----------------------------------------------------------------

const FIXTURES = new URL('./fixtures/', import.meta.url);
/** The dry run's clock: the fixtures are from this day. */
export const DRY_NOW = new Date('2026-10-17T21:00:00Z');
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Maps live URLs to local fixture files. Unknown URLs fail like a network error. */
export function fixtureFetcher(): Deps['fetchText'] {
  return async (url) => {
    if (url === config.feeds.sec8k) return fixture('sec-8k-feed.atom.xml');
    if (url === config.secTickersUrl) return fixture('sec-company-tickers-watch.json');
    if (url === config.secSubmissionsUrl.replace('{cik}', '0000320193')) return fixture('sec-submissions-CIK0000320193.json');
    if ((config.feeds.fedRss as readonly string[]).includes(url)) return fixture('fed-press-monetary.rss.xml');
    if (url === config.feeds.beaRss) return fixture('bea-releases.rss.xml');
    if (url === wikiFeedUrl(DRY_NOW)) return fixture('wiki-featured-2026-10-17.json');
    if (url === wikiFeedUrl(DRY_NOW, 1)) return fixture('wiki-featured-2026-10-16.json');
    if (url === wikiFeedUrl(DRY_NOW, 2)) return '{"tfa":{},"mostread":{}}';          // a past day without a `news` list = no items
    if (url === cpscUrl(DRY_NOW)) return fixture('cpsc-recalls-2026-10-03.json');
    if (url === config.usgs.url) return fixture('usgs-significant-week.geojson');
    if (url === config.nasa.feedUrl) return fixture('nasa-news-release.rss.xml');
    if (url === nasaFeedUrl(2)) return fixture('nasa-news-release-page2.rss.xml');
    const fr = fedRegisterUrls();
    if (url === fr[0]) return fixture('fedreg-agencies.json');
    if (url === fr[1]) return fixture('fedreg-significant.json');
    if (/www\.sec\.gov\/Archives\/.+-index\.htm$/.test(url)) return fixture('sec-filing-index.html');
    if (/www\.sec\.gov\/Archives\/.+\/primary-8k\.htm$/.test(url)) return fixture('sec-primary-8k.html');
    if (/www\.sec\.gov\/Archives\/.+\/ex99-1\.htm$/.test(url)) return fixture('sec-exhibit-99-1.html');
    if (/www\.federalreserve\.gov\/newsevents\/pressreleases\//.test(url)) return fixture('fed-press-release.html');
    if (url.startsWith(config.feeds.fredObservations) && new URL(url).searchParams.get('series_id') === 'DGS10') {
      return fixture('fred-DGS10-observations.json');
    }
    throw new Error(`no fixture for ${new URL(url).hostname}${new URL(url).pathname}`);
  };
}

// ---- live fetcher -----------------------------------------------------------------------

function liveFetcher(userAgent: string, supabaseHost: string): Deps['fetchText'] {
  // Wikimedia requires its own User-Agent format; the contact comes from SEC_USER_AGENT.
  const wikiUa = wikimediaUserAgent(userAgent) ?? userAgent;
  return async (url, kind, ttl) => {
    const r = await fetchAllowed(url, {
      kind,
      userAgent: new URL(url).hostname === 'en.wikipedia.org' ? wikiUa : userAgent,
      extraHosts: [supabaseHost],
      cacheTtlMinutes: kind === 'page' ? ttl : 0,          // API responses (with keys in URLs) are never cached to disk
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return r.text;
  };
}

function loadDotEnv(): void {
  for (const p of ['.env', '../.env']) {
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* ignore malformed file; readEnv reports what is missing */ }
      return;
    }
  }
}

/**
 * Recompute the Trending boosts after a run. Never fails the run: if the database does not have
 * the RPC yet (older migration) or the call errors, it logs one line and moves on.
 */
export async function refreshTrendingSafely(publisher: Deps['publisher'], log: (s: string) => void): Promise<void> {
  if (!publisher.refreshTrending) return;
  try {
    const r = await publisher.refreshTrending();
    log(`trending refreshed: ${JSON.stringify(r)}`);
  } catch (e) {
    log(`warning: trending refresh failed (${(e as Error).message}); cards are still published`);
  }
}

/** `--fix-category <id> <slug>`: re-files one card through api.set_card_category. Returns the process exit code. */
export async function fixCategory(argv: string[], publisher: Pick<Deps['publisher'], 'setCardCategory'>, log: (s: string) => void = console.log): Promise<number> {
  const [flag, id, slug] = argv;
  if (argv.length !== 3 || flag !== '--fix-category' || !id || !slug) throw new Error('usage: --fix-category <card-id> <category-slug> (no other options)');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('--fix-category: the card id must be a UUID');
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(slug)) throw new Error('--fix-category: the category must be a slug such as "markets"');
  if (!publisher.setCardCategory) throw new Error('publisher does not support set_card_category');
  const r = await publisher.setCardCategory(id, slug);
  log(`fix-category: ${r.status} ${r.id} -> ${r.category}`);
  return r.status === 'updated' ? 0 : 1;
}

/**
 * CLI entry point. Dry run: fixtures, template summarizer, in-memory publisher. Live: reads the
 * environment, builds the provider chain and the Supabase publisher, then runs once, in a loop,
 * or --rewrite. Returns the process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  if (isMailCommand(argv)) return mailMain(argv);          // --brief-summary / --send-briefs (see mailCli.ts)
  if (argv.includes('--fix-category')) {
    loadDotEnv();
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('--fix-category needs EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (api.set_card_category is a service-role RPC)');
    return fixCategory(argv, createSupabasePublisher({ url, key }));
  }
  if (argv.includes('--audit-cards')) {
    const allowed = new Set(['--audit-cards','--apply','--no-gemini']);
    for (const flag of argv) if (!allowed.has(flag)) throw new Error(`unknown audit option: ${flag}`);
    if (argv.filter(x=>x==='--apply').length > 1 || argv.filter(x=>x==='--audit-cards').length > 1) throw new Error('duplicate audit option');
    loadDotEnv();
    const apply = argv.includes('--apply');
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!url || !key || !groqKey) throw new Error('audit needs EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY and GROQ_API_KEY');
    const reader = createSupabasePublisher({url,key});
    if (!reader.auditCards) throw new Error('publisher does not support card audit');
    const cards = await reader.auditCards();
    if (apply && !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('--apply needs SUPABASE_SERVICE_ROLE_KEY (revise_blurb and set_story_link are service-role RPCs)');
    const writer = apply ? createSupabasePublisher({url,key:process.env.SUPABASE_SERVICE_ROLE_KEY!}) : reader;
    if (!writer.reviseBlurb) throw new Error('publisher does not support revise_blurb');
    await runAudit({cards,apply,noGemini:argv.includes('--no-gemini'),groqKey,revise:(c,r)=>groqRevision(groqKey,c,r),write:p=>writer.reviseBlurb!(p),hide:(id,note)=>writer.reviseBlurb!({id,action:'hide',note}),link:(id,related,kind)=>writer.setStoryLink?.(id,related,kind) ?? Promise.resolve()});
    return 0;
  }
  const args = parseArgs(argv);
  const log = (s: string) => console.log(s);

  if (args.rewrite && args.loop) throw new Error('--rewrite cannot be combined with --loop');
  if (args.backfillMacro && (args.rewrite || args.loop)) throw new Error('--backfill-macro cannot be combined with --rewrite or --loop');
  if (args.dryRun) {
    const dry = createDryRunPublisher(args.rewrite ? (JSON.parse(fixture('rewrite-cards.json')) as { cards: RevisableCard[] }).cards : []);
    const deps: Deps = {
      fetchText: fixtureFetcher(),
      publisher: dry.publisher,
      providers: [templateSummarizer],                       // no keys in a dry run: template cards only
      counter: memoryCounter(),
      fredApiKey: 'dry-run',                                  // fixture fetcher ignores it
      now: DRY_NOW,                                           // fixtures are from this day
      log,
    };
    if (args.backfillMacro) {
      const bs = await runBackfill(deps, { weeks: args.weeks, pauseMs: 0 });
      log(`dry run backfill: ${JSON.stringify(bs)}`);
      if (args.json) console.log(JSON.stringify(dry.macro, null, 2));
      return 0;
    }
    if (args.rewrite) {
      const rs = await runRewrite(deps, { limit: args.limit });
      log(`dry run rewrite: ${JSON.stringify(rs)}`);
      if (args.json) console.log(JSON.stringify(dry.revisions, null, 2));
      return 0;
    }
    const stats = await runOnce(deps, { only: args.only, limit: args.limit });
    await refreshTrendingSafely(deps.publisher, log);
    log(`dry run: ${JSON.stringify(stats)}`);
    if (args.json) console.log(JSON.stringify({ cards: dry.cards, macro: dry.macro }, null, 2));
    return 0;
  }

  loadDotEnv();
  const env = readEnv(process.env);
  log(`ingest starting: ${describeEnv(env)}`);
  const { providers, skipped } = buildProviders(env);
  log(`summarizers: ${providers.map((p) => p.name).join(' -> ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`);
  const deps: Deps = {
    fetchText: liveFetcher(env.secUserAgent, new URL(env.supabaseUrl).hostname),
    publisher: createSupabasePublisher({ url: env.supabaseUrl, key: env.supabaseServiceRoleKey }),
    providers,
    counter: fileCounter('state/ai-usage.json'),
    fredApiKey: env.fredApiKey,
    now: new Date(),
    log,
    reportCard: process.env.REPORT_CARD_PROTOCOL === '1' ? { enabled: true } : undefined,   // write -> score -> revise-once protocol, off by default
  };
  if (args.backfillMacro) {
    const bs = await runBackfill(deps, { weeks: args.weeks });
    log(`backfill finished: ${JSON.stringify(bs)}`);
    return bs.failed > 0 ? 1 : 0;
  }
  if (args.rewrite) {
    const rs = await runRewrite(deps, { limit: args.limit });
    log(`rewrite finished: ${JSON.stringify(rs)}`);
    return 0;
  }
  do {
    deps.now = new Date();
    const stats = await runOnce(deps, { only: args.only, limit: args.limit });
    await refreshTrendingSafely(deps.publisher, log);
    log(`run finished ${deps.now.toISOString()}: ${JSON.stringify(stats)}`);
    if (args.loop) await new Promise((r) => setTimeout(r, config.pollIntervalMinutes * 60_000));
  } while (args.loop);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); },
  );
}
