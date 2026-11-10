// Daily brief window and the honest span text (release M9, workstream 7, D-119). Pure, no React.
// Same rule as core.brief_window_hours in migration 20261125000000_brief_window_fallback.sql:
// the daily window is 24 h; on Monday (New York) it is 72 h and the brief says "Since Friday".
// The weekly brief keeps its own 168 h window.

import type { BriefWindowKind } from '../../contract/types.ts';

export const BRIEF_TZ = 'America/New_York';
export const DAILY_WINDOW_HOURS = 24;
export const MONDAY_WINDOW_HOURS = 72;

/** ISO weekday (1 = Monday ... 7 = Sunday) of `now` in `tz`. */
export function localWeekday(now: Date, tz: string = BRIEF_TZ): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[w] ?? 1;
}

/** The daily window for a moment: 72 h "since_friday" on Monday, else 24 h. */
export function dailyWindow(now: Date, tz: string = BRIEF_TZ): { hours: number; kind: BriefWindowKind } {
  return localWeekday(now, tz) === 1
    ? { hours: MONDAY_WINDOW_HOURS, kind: 'since_friday' }
    : { hours: DAILY_WINDOW_HOURS, kind: '24h' };
}

/** "Last 24 hours" / "Since Friday" / "Last 7 days"; the server's window_kind wins, else it is read from the hours. */
export function spanLabel(kind: BriefWindowKind | undefined, hours: number): string {
  if (kind === 'since_friday') return 'Since Friday';
  if (kind === 'week') return 'Last 7 days';
  if (kind === '24h') return 'Last 24 hours';
  const h = Number.isFinite(hours) && hours > 0 ? Math.round(hours) : DAILY_WINDOW_HOURS;
  if (h === MONDAY_WINDOW_HOURS) return 'Since Friday';
  if (h === 168) return 'Last 7 days';
  if (h % 24 === 0 && h > 24) return `Last ${h / 24} days`;
  return `Last ${h} hours`;
}
