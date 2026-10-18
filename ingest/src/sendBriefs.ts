// Sends the scheduled brief emails and the confirmation emails (run hourly; the database picks who is due).
// Flow: pending confirmations -> confirmation emails; due subscriptions -> compose the daily and/or
// weekly brief from the stored brief JSON (the summary is read, never generated here) -> mailer.send
// -> api.mark_brief_sent. The mailer is the outbox unless real sending was switched on (see mailer.ts).
// Marking: only after a REAL send (outbox runs and dry runs never mark, so testing cannot use up
// anyone's brief for the day). A rerun cannot double-send: the resend Idempotency-Key is stable.
// Inputs: RpcS, brief reader, mailer, clock. Outputs: SendStats and log lines (no addresses, no keys).

import { composeBriefEmail, composeConfirmationEmail, nonHttpsLinks } from './briefEmail.ts';
import { RpcMissingError, type BriefInput, type BriefKind } from './briefSummary.ts';
import { dueBriefs, localParts } from './briefTime.ts';
import { config } from './config.ts';
import { recipientTag, type Mailer } from './mailer.ts';
import type { MailRpc } from './mailRpc.ts';

export interface SendDeps {
  rpc: MailRpc;
  fetchBrief(kind: BriefKind): Promise<BriefInput>;
  mailer: Mailer;
  postalLine: string;
  now: Date;
  log(s: string): void;
}

export interface SendStats {
  confirmations: number;
  briefs: number;
  failed: number;
  skipped: number;
  missing_rpc: boolean;
}

const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export async function runSendBriefs(deps: SendDeps, opts: { dryRun?: boolean } = {}): Promise<SendStats> {
  const stats: SendStats = { confirmations: 0, briefs: 0, failed: 0, skipped: 0, missing_rpc: false };
  const { rpc, mailer, log } = deps;
  const mark = !opts.dryRun && mailer.real;        // only a real send uses up the day's brief
  const today = localParts(deps.now, config.mail.timezone).date;

  const safeMark = async (id: string, kind: BriefKind | 'confirm', onDate: string) => {
    if (!mark) return;
    try { await rpc.markBriefSent(id, kind, onDate); } catch (e) { log(`warning: could not mark ${kind} sent for ${id.slice(0, 8)} (${(e as Error).message}); the idempotency key prevents a double send`); }
  };

  try {
    // 1. confirmation emails
    const pending = await rpc.pendingConfirmations();
    log(`${pending.length} pending confirmation(s)`);
    for (const p of pending) {
      if (!EMAIL_SHAPE.test(p.email ?? '')) { stats.skipped++; continue; }
      const mail = composeConfirmationEmail({ token: p.token, kind: p.kind, sendHour: p.send_hour, tz: p.tz, postalLine: deps.postalLine });
      assertSafe(mail.html);
      const r = await mailer.send({ to: p.email, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, key: `confirm-${p.id}` });
      if (r.skipped) { stats.skipped++; continue; }
      if (!r.ok) { stats.failed++; log(`confirmation to ${recipientTag(p.email)} failed: ${r.error}`); continue; }
      stats.confirmations++;
      await safeMark(p.id, 'confirm', today);
    }

    // 2. the briefs that are due
    const due = await rpc.dueBriefSubscriptions(deps.now);
    log(`${due.length} subscription(s) returned as due`);
    const briefs = new Map<BriefKind, BriefInput | null>();
    const briefFor = async (kind: BriefKind): Promise<BriefInput | null> => {
      if (!briefs.has(kind)) {
        try { briefs.set(kind, await deps.fetchBrief(kind)); } catch (e) {
          if (e instanceof RpcMissingError) throw e;
          log(`could not read the ${kind} brief (${(e as Error).message})`);
          briefs.set(kind, null);
        }
      }
      return briefs.get(kind) ?? null;
    };
    for (const s of due) {
      if (!EMAIL_SHAPE.test(s.email ?? '')) { stats.skipped++; continue; }
      for (const d of dueBriefs(s, deps.now)) {
        const brief = await briefFor(d.kind);
        if (!brief) { stats.failed++; continue; }
        const mail = composeBriefEmail({ kind: d.kind, brief, token: s.token, postalLine: deps.postalLine, now: deps.now });
        assertSafe(mail.html);
        const r = await mailer.send({ to: s.email, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, key: `${d.kind}-${s.id}-${d.onDate}` });
        if (r.skipped) { stats.skipped++; continue; }
        if (!r.ok) { stats.failed++; log(`${d.kind} brief to ${recipientTag(s.email)} failed: ${r.error}`); continue; }
        stats.briefs++;
        await safeMark(s.id, d.kind, d.onDate);
      }
    }
  } catch (e) {
    if (e instanceof RpcMissingError) {
      stats.missing_rpc = true;
      log(`${e.message}. Apply the brief email migration first; nothing was sent.`);
    } else throw e;
  }
  log(`done: ${stats.confirmations} confirmation(s), ${stats.briefs} brief(s), ${stats.failed} failed, ${stats.skipped} skipped${mark ? '' : ' (not marked sent: ' + (opts.dryRun ? 'dry run' : 'outbox') + ')'}`);
  log(mailer.summary());
  return stats;
}

/** Last check before any message leaves: no link in the email may be http. */
function assertSafe(html: string): void {
  const bad = nonHttpsLinks(html);
  if (bad.length) throw new Error(`refusing to send: non-https link(s) in the email (${bad.length})`);
}
