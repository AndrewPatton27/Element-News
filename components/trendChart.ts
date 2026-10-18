// Pure chart geometry for the "Trends · 12 weeks" card (same math as the design,
// docs/design/web/Web-Final.dc.html): 600 x 170 box, 8 px side margin, 14 px
// vertical margin, baseline at y = 156. No React imports.

import { changeToneColor } from '../lib/numberTone.ts';
import type { Palette } from '../lib/theme.ts';

export const CHART_W = 600;
export const CHART_H = 170;
const PX = 8;
const PY = 14;
export const BASELINE = 156;

export interface ChartShape {
  points: string; // polyline points
  area: string; // closed path under the line
  cx: number; // last point
  cy: number;
}

// Needs at least 2 finite values; otherwise there is nothing to draw.
export function chartShape(data: number[]): ChartShape | null {
  const v = data.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (v.length < 2) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pts = v.map((n, k) => [PX + (k * (CHART_W - 2 * PX)) / (v.length - 1), PY + (CHART_H - 2 * PY) * (1 - (n - min) / (max - min || 1))]);
  const last = pts[pts.length - 1];
  return {
    points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
    area: `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L')} L${last[0].toFixed(1)} ${BASELINE} L${PX} ${BASELINE} Z`,
    cx: last[0],
    cy: last[1],
  };
}

// Colours for one trend: the change text ("delta") follows the tone (green good,
// red bad, gray neutral); the chart line is green or red only when the change
// is judged, otherwise the brand accent. Direction is still in the glyph + word.
export function trendColors(p: Palette, seriesId: string, direction: 'up' | 'down' | 'flat' | null): { delta: string; line: string } {
  const delta = changeToneColor(p, seriesId, direction);
  return { delta, line: delta === p.good || delta === p.bad ? delta : p.accent };
}

// Next / previous slide, wrapping around; safe for an empty list.
export function stepIndex(i: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0;
  return (((i + delta) % length) + length) % length;
}


// How many Top stories sit above the trend chart. Short windows (a 1366x768 or
// 1280x720 laptop, where the browser leaves 650-800 px) show 3 so the chart is
// visible without scrolling the column; the design's 5 on tall windows.
export function storiesToShow(windowHeight: number): number {
  if (windowHeight < 800) return 3;
  if (windowHeight < 880) return 4;
  return 5;
}
