// Alerts through GitHub issues in a PRIVATE repo (public-repo issues are public). One open issue per label
// `wd:<kind>`; at most one comment a day (checked on GitHub, so the Worker keeps no state); the issue is
// closed with a note when the problem is gone. GitHub emails the repo owner for new issues and comments.
// Only counts, timestamps, source names and short error classes go in (sanitize() on every string).
// Inputs: the current problems, a fetch function, the repo and a token (from env). Outputs: what was done.

import { ALL_KINDS, sanitize, type Kind, type Problem } from './logic.ts';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AlertConfig { repo: string; token: string; fetch: Fetcher; now: Date }
export interface AlertResult { opened: Kind[]; commented: Kind[]; closed: Kind[]; unchanged: Kind[]; githubStatus: number | null }

const API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'element-watchdog', 'Content-Type': 'application/json',
  };
}

interface Issue { number: number; created_at?: string }

/**
 * Brings GitHub in line with `problems`. `checkedKinds` are the kinds this run could actually judge: an issue is
 * only closed for a kind that was checked and is fine now (a failed Supabase call must not close the others).
 */
export async function syncAlerts(cfg: AlertConfig, problems: Problem[], checkedKinds: readonly Kind[] = ALL_KINDS): Promise<AlertResult> {
  const res: AlertResult = { opened: [], commented: [], closed: [], unchanged: [], githubStatus: null };
  const h = headers(cfg.token);
  const call = async (path: string, init?: RequestInit) => {
    const r = await cfg.fetch(`${API}/repos/${cfg.repo}${path}`, { ...init, headers: h, signal: AbortSignal.timeout(20_000) });
    res.githubStatus = r.status;
    return r;
  };
  const byKind = new Map(problems.map((p) => [p.kind, p]));
  for (const kind of ALL_KINDS) {
    const problem = byKind.get(kind);
    if (!problem && !checkedKinds.includes(kind)) continue;
    const list = await call(`/issues?labels=${encodeURIComponent(`wd:${kind}`)}&state=open&per_page=1`);
    if (!list.ok) { res.githubStatus = list.status; return res; }          // 401/403/404: the caller reports it to Healthchecks
    const open = ((await list.json()) as Issue[])[0];
    if (problem) {
      const body = `${sanitize(problem.detail, 400)}\n\n_${cfg.now.toISOString()} (watchdog)_`;
      if (!open) {
        const c = await call('/issues', { method: 'POST', body: JSON.stringify({ title: `[watchdog] ${sanitize(problem.title, 100)}`, body, labels: [`wd:${kind}`] }) });
        if (!c.ok) { res.githubStatus = c.status; return res; }
        res.opened.push(kind);
      } else {
        const sinceMs = cfg.now.getTime() - 24 * 3_600_000;
        const since = new Date(sinceMs).toISOString();
        if (open.created_at && Date.parse(open.created_at) > sinceMs) { res.unchanged.push(kind); continue; }   // opened within the day: that email was the alert
        const cm = await call(`/issues/${open.number}/comments?since=${encodeURIComponent(since)}&per_page=1`);
        if (!cm.ok) { res.githubStatus = cm.status; return res; }
        if (((await cm.json()) as unknown[]).length === 0) {
          await call(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Still happening.\n\n${body}` }) });
          res.commented.push(kind);
        } else res.unchanged.push(kind);
      }
    } else if (open) {
      await call(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Recovered at ${cfg.now.toISOString()}. Closing.` }) });
      await call(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
      res.closed.push(kind);
    }
  }
  return res;
}
