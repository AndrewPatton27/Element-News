// Environment, caller check and request parsing shared by the Edge Functions. Pure (the Deno entry
// files pass Deno.env.get in), so Node tests cover it.
// Env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase into every Edge
// Function (names starting with SUPABASE_ cannot be set as custom secrets). Custom secrets:
// GEMINI_API_KEY, GROQ_API_KEY, FRED_API_KEY, SEC_USER_AGENT; optional REPORT_CARD_PROTOCOL=1.
// Outputs: FunctionEnv (key values are never logged; describe() prints [set]/[missing] only).

export type EnvGet = (name: string) => string | undefined;

const PLACEHOLDER = /your|example|xxx|<|>|changeme|placeholder/i;
const clean = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t && !PLACEHOLDER.test(t) ? t : null;
};

export interface FunctionEnv {
  supabaseUrl: string;
  serviceKey: string;
  /** key for the public read RPCs (api.daily_brief / api.weekly_brief); falls back to the service key */
  readKey: string;
  geminiApiKey: string | null;
  groqApiKey: string | null;
  fredApiKey: string | null;
  blsApiKey: string | null;        // optional: switches the BLS source to API v2 (500 requests/day)
  beaApiKey: string | null;
  beaDataEnabled: boolean;         // BEA_DATA_ENABLED=1 turns the BEA data source on
  secUserAgent: string | null;
  reportCard: boolean;
}

/** Reads the environment; throws (without any key value) if the Supabase URL or service key is missing. */
export function readFunctionEnv(get: EnvGet): FunctionEnv {
  const supabaseUrl = (clean(get('SUPABASE_URL')) ?? '').replace(/\/$/, '');
  const serviceKey = clean(get('SUPABASE_SERVICE_ROLE_KEY')) ?? '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) throw new Error('SUPABASE_URL is missing or not https://<ref>.supabase.co');
  if (serviceKey.length < 20) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing');
  const ua = clean(get('SEC_USER_AGENT'));
  return {
    supabaseUrl,
    serviceKey,
    readKey: clean(get('SUPABASE_ANON_KEY')) ?? serviceKey,
    geminiApiKey: clean(get('GEMINI_API_KEY')),
    groqApiKey: clean(get('GROQ_API_KEY')),
    fredApiKey: clean(get('FRED_API_KEY')),
    blsApiKey: clean(get('BLS_API_KEY')),
    beaApiKey: clean(get('BEA_API_KEY')),
    beaDataEnabled: (get('BEA_DATA_ENABLED') ?? '').trim() === '1',
    secUserAgent: ua && /\S+@\S+\.\S+/.test(ua) ? ua : null,
    reportCard: (get('REPORT_CARD_PROTOCOL') ?? '').trim() === '1',
  };
}

export function describeFunctionEnv(e: FunctionEnv): string {
  const s = (v: string | null) => (v ? '[set]' : '[missing]');
  return `GEMINI_API_KEY=${s(e.geminiApiKey)} GROQ_API_KEY=${s(e.groqApiKey)} FRED_API_KEY=${s(e.fredApiKey)} BEA_API_KEY=${s(e.beaApiKey)} BLS_API_KEY=${s(e.blsApiKey)} SEC_USER_AGENT=${s(e.secUserAgent)} REPORT_CARD_PROTOCOL=${e.reportCard ? 1 : 0}`;
}

/** Length-independent string compare (the token is a secret). */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Only the scheduler (pg_cron + pg_net, key from Vault), the watchdog Worker or Drew may run a function: the
 * bearer token must equal the project's service-role key, or the function secret CRON_SECRET (at least 24
 * characters; it can only start these two functions, which is why the Worker holds it instead of the
 * service-role key). A CRON_SECRET bearer is not a JWT, so deploy both functions with --no-verify-jwt;
 * this check is then the gate (see supabase/functions/functions.md).
 */
export function isAuthorized(authorization: string | null | undefined, get: EnvGet): boolean {
  const key = (get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  const cron = (get('CRON_SECRET') ?? '').trim();
  const m = /^Bearer\s+(\S+)$/i.exec((authorization ?? '').trim());
  if (!m) return false;
  return (key.length >= 20 && sameSecret(m[1], key)) || (cron.length >= 24 && sameSecret(m[1], cron));
}

/** Reads a JSON object body; an empty or bad body counts as {} (the query string can carry the options too). */
export async function readOptions(req: Request): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URL(req.url).searchParams) out[k] = v;
  if (req.method === 'POST') {
    try {
      const body = await req.text();
      const j = body ? JSON.parse(body) : {};
      if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(out, j);
    } catch { /* bad JSON: query options only */ }
  }
  return out;
}

export const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
