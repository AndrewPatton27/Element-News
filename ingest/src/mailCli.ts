// CLI for the brief summary and the brief email (separate from the card pipeline's flags).
//   node src/main.ts --brief-summary [--kind daily|weekly|both] [--force] [--dry-run] [--no-ai]
//       AI summary of the day's / week's brief, once per period (skipped if it already exists).
//       --dry-run: reads only, writes nothing to the database; also writes a sample email per kind to
//       outbox/sample/. --no-ai: use the template summary (no AI call).
//   node src/main.ts --send-briefs [--send] [--dry-run]
//       confirmation emails + due briefs. Default = outbox files only. Real sending needs
//       RESEND_API_KEY + EMAIL_FROM in .env AND --send (and MAIL_POSTAL_LINE).
// Inputs: flags; .env (EXPO_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY for reads, SUPABASE_SERVICE_ROLE_KEY
// for writes, GEMINI_API_KEY, GROQ_API_KEY, RESEND_API_KEY, EMAIL_FROM, MAIL_POSTAL_LINE).
// Outputs: log lines (never keys or addresses); exit code 0 (also when the migration is missing), 1 on failure.

import { existsSync } from 'node:fs';
import { composeBriefEmail } from './briefEmail.ts';
import { buildTextModels, fetchBrief, runBriefSummary, type BriefInput, type BriefKind, type SummaryJobOutcome } from './briefSummary.ts';
import { chooseMailer, createOutboxMailer } from './mailer.ts';
import { createMailRpc } from './mailRpc.ts';
import { runSendBriefs } from './sendBriefs.ts';
import { fileCounter } from './summarizer/chain.ts';

export interface MailArgs {
  command: 'brief-summary' | 'send-briefs';
  kinds: BriefKind[];
  force: boolean;
  dryRun: boolean;
  send: boolean;
  noAi: boolean;
}

/** true if argv asks for one of the mail commands. */
export const isMailCommand = (argv: string[]): boolean => argv.includes('--brief-summary') || argv.includes('--send-briefs');

/** Parses the mail flags. Throws on an unknown option or a bad --kind. */
export function parseMailArgs(argv: string[]): MailArgs {
  const a: MailArgs = { command: 'brief-summary', kinds: ['daily', 'weekly'], force: false, dryRun: false, send: false, noAi: false };
  let summary = false, sending = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--brief-summary') summary = true;
    else if (k === '--send-briefs') sending = true;
    else if (k === '--force') a.force = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--send') a.send = true;
    else if (k === '--no-ai') a.noAi = true;
    else if (k === '--kind') {
      const v = argv[++i];
      if (v === 'daily' || v === 'weekly') a.kinds = [v];
      else if (v === 'both') a.kinds = ['daily', 'weekly'];
      else throw new Error('--kind needs daily, weekly or both');
    } else throw new Error(`unknown option for the mail commands: ${k}`);
  }
  if (summary && sending) throw new Error('use --brief-summary or --send-briefs, not both in one run');
  a.command = sending ? 'send-briefs' : 'brief-summary';
  if (a.command === 'brief-summary' && a.send) throw new Error('--send only applies to --send-briefs');
  if (a.command === 'send-briefs' && (a.force || a.noAi)) throw new Error('--force and --no-ai only apply to --brief-summary');
  return a;
}

function loadDotEnv(): void {
  for (const p of ['.env', '../.env']) {
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* malformed file: the checks below say what is missing */ }
      return;
    }
  }
}

const get = (k: string) => (process.env[k] ?? '').trim();
const looksSet = (v: string) => v.length > 0 && !/your|example|xxx|<|>|changeme|placeholder/i.test(v);

/** Public read access, the same URL and publishable key the app uses. */
function publicAccess(): { url: string; key: string } {
  const url = (get('EXPO_PUBLIC_SUPABASE_URL') || get('SUPABASE_URL')).replace(/\/$/, '');
  const key = get('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !looksSet(key)) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env (the same values the app uses)');
  }
  return { url, key };
}

function serviceAccess(): { url: string; key: string } {
  const url = (get('SUPABASE_URL') || get('EXPO_PUBLIC_SUPABASE_URL')).replace(/\/$/, '');
  const key = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !looksSet(key) || key.length < 20) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }
  return { url, key };
}

/** Writes one sample email per outcome that has a summary and a brief (dry run only; local files). */
async function writeSamples(outcomes: SummaryJobOutcome[], now: Date, log: (s: string) => void): Promise<void> {
  const outbox = createOutboxMailer({ date: 'sample', log });
  const postalLine = get('MAIL_POSTAL_LINE') || '[Set MAIL_POSTAL_LINE: the mailing address that appears in the footer]';
  for (const o of outcomes) {
    if (!o.brief || !o.text) continue;
    const brief: BriefInput = { ...o.brief, summary: { text: o.text, generated_at: now.toISOString(), model: o.model ?? 'template' } };
    const mail = composeBriefEmail({ kind: o.kind, brief, token: '00000000-0000-4000-8000-000000000000', postalLine, now });
    await outbox.send({ to: 'sample@example.com', subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, key: `sample-${o.kind}` });
  }
}

/** Runs a mail command; returns the exit code. `log` and `now` are injectable for tests. */
export async function mailMain(argv: string[], log: (s: string) => void = (s) => console.log(s), now = new Date()): Promise<number> {
  const args = parseMailArgs(argv);
  loadDotEnv();

  if (args.command === 'brief-summary') {
    const pub = publicAccess();
    const models = args.noAi ? [] : buildTextModels({ geminiApiKey: get('GEMINI_API_KEY') || null, groqApiKey: get('GROQ_API_KEY') || null });
    log(`brief summary: ${args.kinds.join(' + ')}${args.dryRun ? ' (dry run: reads only, nothing written)' : ''}; models: ${models.map((m) => m.name).join(' -> ') || 'template only'}`);
    let rpc: ReturnType<typeof createMailRpc> | undefined;
    if (!args.dryRun) { const s = serviceAccess(); rpc = createMailRpc({ url: s.url, key: s.key }); }
    const outcomes = await runBriefSummary({
      fetchBrief: (kind) => fetchBrief(kind, pub),
      putSummary: rpc ? (kind, forDate, text, model) => rpc.putBriefSummary(kind, forDate, text, model) : undefined,
      models, counter: fileCounter('state/ai-usage.json'), now, log,
    }, { kinds: args.kinds, force: args.force, dryRun: args.dryRun });
    for (const o of outcomes) {
      if (o.text && (o.status === 'dry_run' || o.status === 'written')) log(`--- ${o.kind} summary (${o.model}) ---\n${o.text}\n---`);
    }
    if (args.dryRun) await writeSamples(outcomes, now, log);
    return 0;
  }

  // --send-briefs
  const pub = publicAccess();
  const svc = serviceAccess();
  const choice = args.dryRun ? { mailer: createOutboxMailer({ log }), note: 'dry run: writing to the outbox, nothing is sent or marked' } : chooseMailer(process.env, { send: args.send, log });
  if (choice.note) log(choice.note);
  const postalLine = get('MAIL_POSTAL_LINE');
  if (choice.mailer.real && !looksSet(postalLine)) {
    log('MAIL_POSTAL_LINE is not set: refusing to send real email without a mailing address in the footer');
    return 1;
  }
  const stats = await runSendBriefs({
    rpc: createMailRpc({ url: svc.url, key: svc.key }),
    fetchBrief: (kind) => fetchBrief(kind, pub),
    mailer: choice.mailer,
    postalLine: postalLine || '[Set MAIL_POSTAL_LINE: the mailing address that appears in the footer]',
    now, log,
  }, { dryRun: args.dryRun });
  return stats.failed > 0 ? 1 : 0;
}
