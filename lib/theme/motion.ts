// Motion tokens (ui-polish-m8). One small set shared by every animated surface, so sheets,
// toasts, the swipe and press feedback feel like one product. Pure: no React imports; the rules
// below are unit tested (lib/__tests__/motion.test.ts).
//
// Rules of thumb: UI motion stays under 300 ms; exits are faster than entries; anything a finger
// drags ends with a spring seeded by the release velocity; keyboard and system actions (arrow keys,
// Escape) never animate; reduced motion keeps only short opacity changes.

export type Bezier = [number, number, number, number];

export const motion = {
  easeOut: [0.23, 1, 0.32, 1] as Bezier, // strong ease-out: entrances, exits, press release
  easeDrawer: [0.32, 0.72, 0, 1] as Bezier, // iOS sheet curve: sheets rising from the bottom edge
  pressMs: 120, // press-in feedback (scale 0.94-0.97)
  toastInMs: 200,
  toastOutMs: 140,
  sheetInMs: 300,
  sheetOutMs: 220,
  panelInMs: 200, // wide-screen centred panel
  reducedMs: 150, // reduced motion: opacity only
  // Snap back after a drag that did not commit: damping ratio 0.8 (400 stiffness, 32 damping, mass 1).
  springSnap: { stiffness: 400, damping: 32, mass: 1 },
  // Distance OR velocity: a short fast flick is enough to commit.
  dismissFraction: 0.3,
  dismissVelocity: 0.5, // px/ms
} as const;

// CSS form of a curve, for the web-only global transition rule.
export function cssBezier(b: Bezier): string {
  return `cubic-bezier(${b.join(',')})`;
}

/** A dragged sheet closes when pulled down far enough or flicked down fast enough. */
export function sheetDismiss(dragY: number, velocityY: number, height: number): boolean {
  if (dragY <= 0 && velocityY <= 0) return false;
  return dragY > Math.max(1, height) * motion.dismissFraction || velocityY > motion.dismissVelocity;
}

/**
 * How long a fly-off or close should take so its first frames move at the finger's speed.
 * The ease-out curve above starts about 4x faster than its average speed, so
 * duration = 4 * distance / speed, clamped to stay snappy but visible.
 */
export function flingDuration(distancePx: number, speedPxPerMs: number, min = 140, max = 320): number {
  const ms = (4 * Math.max(0, distancePx)) / Math.max(0.5, Math.abs(speedPxPerMs));
  return Math.round(Math.min(max, Math.max(min, ms)));
}
