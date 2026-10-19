// "Numbers updated ..." line for the Numbers screen and the desktop right rail.
// Inputs: the facts from api.numbersToKnow. Output: the time label, or '' when nothing is known.
// "All of the numbers were updated" means the OLDEST refresh among them, so the line never claims
// more than is true. Servers without updated_at fall back to the newest observation date.

import type { MacroFact } from '../../contract/types.ts';
import { relativeTime, shortDate } from '../shared/format.ts';

// The date shown next to a number's source everywhere except the ticker: the reporting period
// ("Sep 2026") for monthly data, otherwise "As of Oct 15".
export function factWhen(f: Pick<MacroFact, 'period' | 'as_of'>): string {
  return f.period ?? `As of ${shortDate(f.as_of)}`;
}

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

export function numbersUpdatedLabel(facts: MacroFact[], now: Date = new Date()): string {
  const stamps = facts.map((f) => ms(f.updated_at)).filter((t) => !Number.isNaN(t));
  if (stamps.length === facts.length && stamps.length > 0) {
    return `All numbers updated ${relativeTime(new Date(Math.min(...stamps)).toISOString(), now)}`;
  }
  const seen = facts.map((f) => ms(f.as_of)).filter((t) => !Number.isNaN(t));
  if (seen.length === 0) return '';
  return `Latest data from ${shortDate(new Date(Math.max(...seen)).toISOString())}`;
}
