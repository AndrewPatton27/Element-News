// Deno entry for the brief-summary Edge Function (deploy: supabase functions deploy brief-summary).
// POST (or GET) with header Authorization: Bearer <service-role key>; body {"kind":"both"} (default),
// optional "force", "dry_run", "no_ai". Scheduled daily at 10:30 UTC by
// supabase/migrations/20261019050000_cron_schedule.sql. All logic is in handler.ts (tested in Node).

import { isAuthorized, json, readFunctionEnv, readOptions, type EnvGet } from '../_shared/env.ts';
import { handleBriefSummary, parseBriefOptions } from './handler.ts';

// Deno globals, read without Deno type declarations so the repo's Node `tsc` stays clean.
const D = (globalThis as unknown as { Deno: { env: { get: EnvGet }; serve(h: (r: Request) => Promise<Response>): unknown } }).Deno;
const get: EnvGet = (k) => D.env.get(k);

D.serve(async (req: Request) => {
  if (!isAuthorized(req.headers.get('authorization'), get)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const opts = parseBriefOptions(await readOptions(req));
    const r = await handleBriefSummary({ env: readFunctionEnv(get) }, opts);
    return json(r, r.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 400);
  }
});
