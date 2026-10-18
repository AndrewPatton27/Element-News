// Service-role RPCs for the brief summary and the brief email (docs/work/spec-brief-email.md):
//   api.put_brief_summary, api.pending_confirmations, api.due_brief_subscriptions, api.mark_brief_sent.
// Plain fetch to PostgREST like publish.ts. A function that does not exist yet (migration not applied)
// raises RpcMissingError so the CLI can print a clear message and exit 0.
// Inputs: Supabase URL + service-role key (never logged). Outputs: typed rows.
// ASSUMED parameter names (p_ prefix, like the public RPCs in the spec): p_kind, p_for_date, p_text,
// p_model; p_now; p_id, p_kind, p_on_date. Change them here if the migration uses other names.

import { fetchAllowed, type FetchLike } from './allowlist.ts';
import { isRpcMissing, RpcMissingError, type BriefKind } from './briefSummary.ts';
import type { SubscriptionRow } from './briefTime.ts';

export interface MailRpc {
  putBriefSummary(kind: BriefKind, forDate: string, text: string, model: string): Promise<unknown>;
  /** pending subscriptions that still need their confirmation email */
  pendingConfirmations(): Promise<SubscriptionRow[]>;
  /** active subscriptions whose local send hour has arrived and not yet sent today / this week */
  dueBriefSubscriptions(now: Date): Promise<SubscriptionRow[]>;
  /** kind 'daily' | 'weekly' = a brief went out; 'confirm' = the confirmation email went out */
  markBriefSent(id: string, kind: BriefKind | 'confirm', onDate: string): Promise<unknown>;
}

export function createMailRpc(opts: { url: string; key: string; fetchImpl?: FetchLike }): MailRpc {
  const host = new URL(opts.url).hostname;
  const headers: Record<string, string> = {
    apikey: opts.key, 'Content-Type': 'application/json', 'Content-Profile': 'api', 'Accept-Profile': 'api',
  };
  if (opts.key.startsWith('eyJ')) headers.Authorization = `Bearer ${opts.key}`;   // legacy JWT keys; sb_secret_ keys go in apikey only

  async function rpc<T>(name: string, body: unknown): Promise<T> {
    const res = await fetchAllowed(`${opts.url}/rest/v1/rpc/${name}`, {
      kind: 'api', method: 'POST', headers, body: JSON.stringify(body), extraHosts: [host], fetchImpl: opts.fetchImpl,
    });
    if (isRpcMissing(res.status, res.text)) throw new RpcMissingError(name);
    if (res.status < 200 || res.status >= 300) {
      let msg = res.text.slice(0, 200);
      try { msg = JSON.parse(res.text).message ?? msg; } catch { /* keep raw */ }
      throw new Error(`rpc ${name}: HTTP ${res.status}: ${msg}`);
    }
    return (res.text ? JSON.parse(res.text) : null) as T;
  }
  const rows = async (name: string, body: unknown): Promise<SubscriptionRow[]> => {
    const r = await rpc<unknown>(name, body);
    return Array.isArray(r) ? (r as SubscriptionRow[]) : [];
  };

  return {
    putBriefSummary: (kind, forDate, text, model) => rpc('put_brief_summary', { p_kind: kind, p_for_date: forDate, p_text: text, p_model: model }),
    pendingConfirmations: () => rows('pending_confirmations', {}),
    dueBriefSubscriptions: (now) => rows('due_brief_subscriptions', { p_now: now.toISOString() }),
    markBriefSent: (id, kind, onDate) => rpc('mark_brief_sent', { p_id: id, p_kind: kind, p_on_date: onDate }),
  };
}
