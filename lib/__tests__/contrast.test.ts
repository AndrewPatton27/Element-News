import { test } from 'node:test';
import assert from 'node:assert/strict';
import { light, type Palette } from '../theme/theme.ts';

// WCAG 2 relative luminance and contrast ratio.
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Text roles drawn on the surfaces they actually sit on must reach AA (4.5:1).
const PAIRS: Array<[keyof Palette, keyof Palette]> = [
  ['ink', 'bg'], ['inkBody', 'surface'], ['inkSoft', 'surface'], ['inkPlain', 'surface'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surfaceMuted'],
  // accentInk on surface: the card topic line and the bar's link glyph / "+N" count;
  // muted on bg: the persistent feed notice strip (D-80) under the card area.
  ['accent', 'surface'], ['accent', 'bg'], ['accentInk', 'accentSoft'], ['accentInk', 'surface'], ['onAccent', 'accent'],
  ['dataInk', 'dataSoft'], ['dataInk', 'dataPanel'],
  ['warn', 'surfaceMuted'], ['warn', 'bg'], ['up', 'surface'], ['down', 'surface'], ['flat', 'surface'],
  ['good', 'surface'], ['bad', 'surface'], ['good', 'bg'], ['bad', 'bg'],
];

test('light palette text pairs meet WCAG AA 4.5:1', () => {
  for (const [fg, bg] of PAIRS) {
    const r = ratio(light[fg], light[bg]);
    assert.ok(r >= 4.5, `${fg} on ${bg} is ${r.toFixed(2)}`);
  }
});
