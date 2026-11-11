// "Report a problem" on a card (M9 trust). Pure: validation, reason list and the reader-facing
// result text, shared by the mock and the Supabase implementations of `Api.reportBlurb`.
//
// EXPECTED BACKEND (a migration is NOT part of the front-end work; ask the back-end owner):
//   api.report_blurb(p_id uuid, p_reason text) returns void
//     - callable by anon and authenticated (the publishable key); never returns the table row
//     - p_reason is one of REPORT_REASONS' codes (the function should reject anything else)
//     - writes one row to a private table (card id, reason, reporter user id or null, created_at)
//     - rate limit per user or per client; over the limit raises (the app then shows "try again later")
//   A missing function (HTTP 404) is reported to the reader as "Reporting is not available yet".
//   Request: POST /rest/v1/rpc/report_blurb  Content-Profile: api  body {"p_id": "<uuid>", "p_reason": "<code>"}

export const REPORT_REASONS = [
  { code: 'inaccurate', label: 'Something looks wrong or inaccurate' },
  { code: 'broken_link', label: 'The source link is broken or wrong' },
  { code: 'misleading', label: 'It is misleading or off-topic' },
  { code: 'other', label: 'Something else' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['code'];
export type ReportStatus = 'ok' | 'invalid' | 'unavailable' | 'rate_limited' | 'error';
export interface ReportResult { ok: boolean; status: ReportStatus }

const ID = /^[0-9a-z][0-9a-z_-]{0,63}$/i;

export function isReportReason(x: unknown): x is ReportReason {
  return typeof x === 'string' && REPORT_REASONS.some((r) => r.code === x);
}

/** True when the card id and reason are both acceptable to send. */
export function isValidReport(cardId: unknown, reason: unknown): boolean {
  return typeof cardId === 'string' && ID.test(cardId) && isReportReason(reason);
}

export function reportToast(r: ReportResult): string {
  if (r.ok) return 'Thanks. We will take a look.';
  if (r.status === 'unavailable') return 'Reporting is not available yet.';
  if (r.status === 'rate_limited') return 'You have sent a lot of reports. Try again in an hour.';
  if (r.status === 'invalid') return 'That report could not be sent.';
  return 'Could not send the report. Try again later.';
}
