// Small service-role PostgREST client for the RPCs the functions add (api.ai_usage_take,
// api.ai_usage_get, api.log_run). Same headers and allowlist as ingest/src/publish.ts: the request
// goes through fetchAllowed with the Supabase host as the only extra host.
// Inputs: Supabase URL + service-role key (never logged), optional fake fetch for tests.
// Outputs: the parsed JSON reply; a non-2xx reply throws an Error with the PostgREST message (no key).

import { fetchAllowed, type FetchLike } from './ingest.ts';

export type Rpc = <T = unknown>(name: string, body: unknown) => Promise<T>;

export function createServiceRpc(opts: { url: string; key: string; fetchImpl?: FetchLike }): Rpc {
  const host = new URL(opts.url).hostname;
  const headers: Record<string, string> = {
    apikey: opts.key, 'Content-Type': 'application/json', 'Content-Profile': 'api', 'Accept-Profile': 'api',
  };
  if (opts.key.startsWith('eyJ')) headers.Authorization = `Bearer ${opts.key}`;   // legacy JWT keys; sb_secret_ keys go in apikey only
  return async <T>(name: string, body: unknown): Promise<T> => {
    const res = await fetchAllowed(`${opts.url}/rest/v1/rpc/${name}`, {
      kind: 'api', method: 'POST', headers, body: JSON.stringify(body), extraHosts: [host], fetchImpl: opts.fetchImpl,
    });
    if (res.status < 200 || res.status >= 300) {
      let msg = res.text.slice(0, 200);
      try { msg = JSON.parse(res.text).message ?? msg; } catch { /* keep raw */ }
      throw new Error(`rpc ${name}: HTTP ${res.status}: ${msg}`);
    }
    return (res.text ? JSON.parse(res.text) : null) as T;
  };
}
