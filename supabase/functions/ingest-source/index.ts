// Deno entry for the ingest-source Edge Function (deploy: supabase functions deploy ingest-source).
// POST with header Authorization: Bearer <service-role key> and body {"source":"fed"} (one of macro,
// fed, bea, fedreg, sec, wiki, cpsc, usgs, nasa); optional "work_cap" (1-20, default 5) and "finish"
// (refresh Trending + ML purge afterwards). This always publishes for real; the offline dry run stays
// `npm --prefix ingest run dry-run`. Scheduled hourly per source by supabase/migrations/20261019050000_cron_schedule.sql. Logic: handler.ts (tested in Node).

import { isAuthorized, json, readFunctionEnv, readOptions, type EnvGet } from '../_shared/env.ts';
import { handleIngestSource, parseIngestOptions } from './handler.ts';

// Deno globals, read without Deno type declarations so the repo's Node `tsc` stays clean.
const D = (globalThis as unknown as { Deno: { env: { get: EnvGet }; serve(h: (r: Request) => Promise<Response>): unknown } }).Deno;
const get: EnvGet = (k) => D.env.get(k);

D.serve(async (req: Request) => {
  if (!isAuthorized(req.headers.get('authorization'), get)) return json({ ok: false, error: 'unauthorized' }, 401);
  let opts;
  try {
    opts = parseIngestOptions(await readOptions(req));
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
  try {
    const run = await handleIngestSource({ env: readFunctionEnv(get) }, opts);
    return json(run, run.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
