// Email providers behind one small interface.
//   outbox (default): writes <outboxDir>/<date>/<name>.html + .txt and sends nothing.
//   resend: POST https://api.resend.com/emails with RESEND_API_KEY and EMAIL_FROM. Only built when
//           BOTH env vars exist AND the caller passed send = true (the --send flag).
// The resend provider sets List-Unsubscribe and List-Unsubscribe-Post (and an Idempotency-Key per
// message), enforces a per-run cap (config.mail.maxPerRun) and stops after repeated provider errors.
// Inputs: Message objects; env values; an optional fake fetch for tests.
// Outputs: SendResult per message; files in the outbox; the API key is never logged.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchAllowed, type FetchLike } from './allowlist.ts';
import { config } from './config.ts';

export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** stable name for the message (file name, idempotency key), e.g. "daily-<subscription id>-2026-10-18" */
  key: string;
}

export interface SendResult {
  ok: boolean;
  /** provider message id (resend) or the written file path (outbox) */
  id?: string;
  error?: string;
  /** true when the run stopped before trying this message (cap or repeated errors) */
  skipped?: boolean;
}

export interface Mailer {
  name: 'outbox' | 'resend';
  /** true: a message that was sent really left the machine */
  real: boolean;
  send(m: Message): Promise<SendResult>;
  /** one line for the run report */
  summary(): string;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

/** Stable short id for a recipient, so no address appears in a file name or a log line. */
export const recipientTag = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 8);

export function createOutboxMailer(opts: { dir?: string; date?: string; log?: (s: string) => void } = {}): Mailer & { files: string[] } {
  const base = opts.dir ?? config.mail.outboxDir;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const files: string[] = [];
  return {
    name: 'outbox', real: false, files,
    async send(m) {
      const dir = join(base, date);
      mkdirSync(dir, { recursive: true });
      const stem = join(dir, safeName(m.key));
      const meta = `<!-- To: ${recipientTag(m.to)} (hashed) | Subject: ${m.subject.replace(/--/g, '- -')} | Headers: ${Object.keys(m.headers ?? {}).join(', ') || 'none'} -->\n`;
      writeFileSync(`${stem}.html`, meta + m.html, 'utf8');
      writeFileSync(`${stem}.txt`, `Subject: ${m.subject}\n${Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${m.text}\n`, 'utf8');
      files.push(`${stem}.html`, `${stem}.txt`);
      opts.log?.(`outbox: wrote ${stem}.html (${m.subject}; to ${recipientTag(m.to)})`);
      return { ok: true, id: `${stem}.html` };
    },
    summary: () => `outbox: ${files.length / 2} message(s) written to ${join(base, date)}; nothing was sent`,
  };
}

export function createResendMailer(opts: {
  apiKey: string;
  from: string;
  fetchImpl?: FetchLike;
  maxPerRun?: number;
  maxConsecutiveErrors?: number;
}): Mailer {
  const max = opts.maxPerRun ?? config.mail.maxPerRun;
  const maxErrors = opts.maxConsecutiveErrors ?? config.mail.maxConsecutiveErrors;
  let sent = 0, failed = 0, attempts = 0, errorsInARow = 0, stopped: string | null = null;
  return {
    name: 'resend', real: true,
    async send(m) {
      if (stopped) return { ok: false, skipped: true, error: stopped };
      if (attempts >= max) { stopped = `per-run cap of ${max} emails reached`; return { ok: false, skipped: true, error: stopped }; }
      attempts++;
      try {
        const res = await fetchAllowed(config.mail.resendEndpoint, {
          kind: 'api', method: 'POST', extraHosts: [config.mail.resendHost], fetchImpl: opts.fetchImpl,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json',
            'Idempotency-Key': safeName(m.key),                      // a rerun cannot double-send the same brief
          },
          body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers ?? {} }),
        });
        if (res.status >= 200 && res.status < 300) {
          let id: string | undefined;
          try { id = JSON.parse(res.text)?.id; } catch { /* no id */ }
          sent++; errorsInARow = 0;
          return { ok: true, id };
        }
        failed++; errorsInARow++;
        if (errorsInARow >= maxErrors) stopped = `stopped after ${errorsInARow} provider errors in a row (last HTTP ${res.status})`;
        return { ok: false, error: `resend: HTTP ${res.status}` };   // the body can echo the address; keep it out of logs
      } catch (e) {
        failed++; errorsInARow++;
        if (errorsInARow >= maxErrors) stopped = `stopped after ${errorsInARow} provider errors in a row`;
        return { ok: false, error: `resend: ${(e as Error).name}` };
      }
    },
    summary: () => `resend: ${sent} sent, ${failed} failed${stopped ? `; ${stopped}` : ''}`,
  };
}

export interface MailerChoice {
  mailer: Mailer;
  /** why the real provider is not in use, or null */
  note: string | null;
}

/**
 * Picks the provider. Real sending needs all three: RESEND_API_KEY, EMAIL_FROM and send = true.
 * Anything less falls back to the outbox, with a note saying what is missing.
 */
export function chooseMailer(
  env: Record<string, string | undefined>,
  opts: { send: boolean; log?: (s: string) => void; fetchImpl?: FetchLike; outboxDir?: string; date?: string },
): MailerChoice {
  const key = (env.RESEND_API_KEY ?? '').trim();
  const from = (env.EMAIL_FROM ?? '').trim();
  if (opts.send && key && from) return { mailer: createResendMailer({ apiKey: key, from, fetchImpl: opts.fetchImpl }), note: null };
  const missing = [!key && 'RESEND_API_KEY', !from && 'EMAIL_FROM'].filter(Boolean).join(' and ');
  const note = opts.send
    ? `--send was given but ${missing} ${missing.includes(' and ') ? 'are' : 'is'} not set: writing to the outbox instead, nothing is sent`
    : (key && from ? 'real sending is off (no --send flag): writing to the outbox, nothing is sent' : null);
  return { mailer: createOutboxMailer({ dir: opts.outboxDir, date: opts.date, log: opts.log }), note };
}
