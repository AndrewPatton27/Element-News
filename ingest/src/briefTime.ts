// Time helpers for the brief summary and the brief email: a person's local date, hour and weekday in
// their time zone, the Monday of a week, and which briefs a subscription is due for right now.
// Pure (no network, no files). Inputs: a Date, an IANA time zone name, a subscription row.
// Outputs: local date strings (YYYY-MM-DD), hours (0-23) and the list of due briefs.

import { config } from './config.ts';

export interface LocalParts {
  date: string;      // YYYY-MM-DD in the zone
  hour: number;      // 0-23 in the zone
  weekday: number;   // 1 = Monday ... 7 = Sunday
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** true if the zone name is a valid IANA zone for this runtime. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Date, hour and weekday of `now` in `tz`. An invalid zone falls back to config.mail.timezone. */
export function localParts(now: Date, tz: string | null | undefined): LocalParts {
  const zone = isValidTimeZone(tz) ? tz : config.mail.timezone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    weekday: WEEKDAYS[get('weekday')] ?? 1,
  };
}

/** The Monday (YYYY-MM-DD) of the week that contains `date` (a YYYY-MM-DD string, no time zone maths). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;            // Monday = 0 ... Sunday = 6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** The period a summary belongs to: today's local date for a daily brief, the week's Monday for a weekly one. */
export function summaryDate(kind: 'daily' | 'weekly', now: Date, tz: string = config.mail.timezone): string {
  const { date } = localParts(now, tz);
  return kind === 'daily' ? date : weekStart(date);
}

/** true if a stored summary (generated_at) belongs to the current day (daily) or week (weekly). */
export function summaryIsCurrent(kind: 'daily' | 'weekly', generatedAt: string | null | undefined, now: Date, tz: string = config.mail.timezone): boolean {
  if (!generatedAt) return false;
  const t = new Date(generatedAt);
  if (Number.isNaN(t.getTime())) return false;
  return summaryDate(kind, t, tz) === summaryDate(kind, now, tz);
}

/** One subscription row as returned by api.due_brief_subscriptions / api.pending_confirmations. */
export interface SubscriptionRow {
  id: string;
  email: string;
  token: string;
  kind: 'daily' | 'weekly' | 'both';
  send_hour: number;
  tz: string | null;
  status?: string;
  last_daily_sent_on?: string | null;
  last_weekly_sent_on?: string | null;
}

export interface DueBrief {
  kind: 'daily' | 'weekly';
  onDate: string;      // the local date to record with api.mark_brief_sent
}

/**
 * Which briefs this subscription is due for at `now`: only active ones; the local send hour has
 * arrived (a late run still catches up the same day); daily = once per local day; weekly = only on
 * Monday, once. A subscription with kind 'both' on a Monday is due for both.
 */
export function dueBriefs(sub: SubscriptionRow, now: Date): DueBrief[] {
  if (sub.status !== undefined && sub.status !== 'active') return [];
  const hour = Number.isInteger(sub.send_hour) && sub.send_hour >= 0 && sub.send_hour <= 23 ? sub.send_hour : config.mail.defaultSendHour;
  const local = localParts(now, sub.tz);
  if (local.hour < hour) return [];
  const out: DueBrief[] = [];
  if ((sub.kind === 'daily' || sub.kind === 'both') && sub.last_daily_sent_on !== local.date) {
    out.push({ kind: 'daily', onDate: local.date });
  }
  if ((sub.kind === 'weekly' || sub.kind === 'both') && local.weekday === 1 && sub.last_weekly_sent_on !== local.date) {
    out.push({ kind: 'weekly', onDate: local.date });
  }
  return out;
}
