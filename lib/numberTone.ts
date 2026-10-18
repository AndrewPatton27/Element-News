// Is a change in a macro number generally good or bad for ordinary households?
// A small, explicit map from series_id to how an INCREASE is judged. Anything not
// listed, anything that did not change, and anything with no direction is neutral
// (gray). This is a plain reading aid, never advice. Pure: type-only imports.
// Colour is extra: the arrow glyph and the word (up / down / unchanged) stay.

import type { MacroFact } from '../contract/types.ts';
import type { Palette } from './theme';

export type NumberTone = 'good' | 'bad' | 'neutral';
type Direction = MacroFact['direction'] | undefined;

/** How an increase is judged. Series not listed here (rates, oil, ...) are neutral. */
export const INCREASE_JUDGED: Readonly<Record<string, 'good' | 'bad'>> = {
  CPIAUCSL: 'bad', // inflation: higher prices hurt
  UNRATE: 'bad', // unemployment
  ICSA: 'bad', // jobless claims
  GASREGW: 'bad', // gas price
  PAYEMS: 'good', // payroll jobs
  RSAFS: 'good', // retail sales
  HOUST: 'good', // housing starts
  A191RL1Q225SBEA: 'good', // GDP growth
  // Neutral on purpose (a rise helps savers and hurts borrowers, or the reverse):
  // DGS2, DGS10, DFF (rates), DCOILWTICO (oil).
};

/** Tone of a change. 'flat', null and unknown series are always neutral. */
export function numberTone(seriesId: string, direction: Direction): NumberTone {
  if (direction !== 'up' && direction !== 'down') return 'neutral';
  const judged = Object.prototype.hasOwnProperty.call(INCREASE_JUDGED, seriesId) ? INCREASE_JUDGED[seriesId] : null;
  if (!judged) return 'neutral';
  if (direction === 'up') return judged;
  return judged === 'good' ? 'bad' : 'good';
}

/** Palette colour for a tone: green = good, red = bad, gray = neutral. */
export function toneColor(p: Palette, tone: NumberTone): string {
  if (tone === 'good') return p.good;
  if (tone === 'bad') return p.bad;
  return p.flat;
}

/** Colour for the change indicator of one number. */
export function changeToneColor(p: Palette, seriesId: string, direction: Direction): string {
  return toneColor(p, numberTone(seriesId, direction));
}

/** Words for screen readers only; '' for neutral. */
export function toneWords(tone: NumberTone): string {
  if (tone === 'good') return 'generally favorable';
  if (tone === 'bad') return 'generally unfavorable';
  return '';
}

/** Append the tone to an existing accessibility label (no trailing period, like the labels it extends). */
export function withToneLabel(label: string, seriesId: string, direction: Direction): string {
  const words = toneWords(numberTone(seriesId, direction));
  return words ? `${label}. Change is ${words} for households` : label;
}

export const NUMBERS_LEGEND = 'Green: generally good for households. Red: generally bad. Gray: no change or neither.';
