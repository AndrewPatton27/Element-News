// Sample history for the mock API (fictional numbers, like every mock card): a seeded random walk that ends exactly
// on the sample card's latest value, so the chart and the card agree and tests are repeatable. Pure.

import type { MacroFact } from '../../contract/types.ts';
import { MAX_SERIES_PER_CALL, type Frequency, type HistoryPoint, type MacroHistory } from './seriesHistory.ts';

const FREQ: Record<string, Frequency> = { CPIAUCSL: 'monthly', UNRATE: 'monthly' };
const COUNT: Record<Frequency, number> = { daily: 62, weekly: 26, monthly: 13, quarterly: 8 };
const STEP_DAYS: Record<Frequency, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 91 };

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13;
    return ((h >>> 0) % 10000) / 10000;
  };
}

const num = (s: string) => Number(s.replace(/[^0-9.\-]/g, ''));

/** Latest sample value per series: the numbers fixture, with 5- and 30-year derived from the 2- and 10-year. */
export function sampleLevels(numbers: Pick<MacroFact, 'series_id' | 'value'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of numbers) if (Number.isFinite(num(n.value))) out[n.series_id] = num(n.value);
  if (out.DGS10 !== undefined && out.DGS2 !== undefined) {
    out.DGS5 ??= Math.round(((out.DGS2 + out.DGS10) / 2 + 0.05) * 100) / 100;
    out.DGS30 ??= Math.round((out.DGS10 + 0.45) * 100) / 100;
  }
  return out;
}

export function mockSeriesHistory(id: string, latest: number, today: Date): { frequency: Frequency; points: HistoryPoint[] } {
  const frequency = FREQ[id] ?? 'daily';
  const n = COUNT[frequency];
  const rnd = seeded(id);
  const scale = Math.max(Math.abs(latest) * (frequency === 'daily' ? 0.012 : 0.03), 0.02);
  const steps: number[] = [];
  let level = 0;
  for (let i = 0; i < n; i++) { level += (rnd() - 0.5) * 2 * scale; steps.push(level); }
  const end = steps[n - 1];
  let t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const isWeekend = (ms: number) => [0, 6].includes(new Date(ms).getUTCDay());
  const dates: number[] = [];
  while (dates.length < n) {                                  // newest first; daily series have no weekend readings
    if (!(frequency === 'daily' && isWeekend(t))) dates.push(t);
    t -= STEP_DAYS[frequency] * 86_400_000;
  }
  const points: HistoryPoint[] = dates.reverse().map((ms, i) => ({
    date: new Date(ms).toISOString().slice(0, 10),
    value: Math.round((latest + steps[i] - end) * 1000) / 1000,
  }));
  return { frequency, points };
}

/** The mock of api.macro_history: unknown series are absent, at most MAX_SERIES_PER_CALL like the server. */
export function mockMacroHistory(ids: string[], levels: Record<string, number>, today: Date = new Date()): MacroHistory {
  const out: MacroHistory = {};
  for (const id of [...new Set(ids)].slice(0, MAX_SERIES_PER_CALL)) {
    if (levels[id] !== undefined) out[id] = mockSeriesHistory(id, levels[id], today);
  }
  return out;
}
