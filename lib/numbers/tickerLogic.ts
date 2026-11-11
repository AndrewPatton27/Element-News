// Pure wording for the Numbers strip (components/numbers/NumbersTicker.tsx).

/**
 * What the strip says when it has no numbers to scroll. `facts` null with no error means the first request is
 * still running: say nothing (a blank band, no flash of text). A failed request or an empty list is said plainly.
 */
export function tickerEmptyText(facts: readonly unknown[] | null, error: string | null): string | null {
  if (facts && facts.length > 0) return null;
  if (error) return 'Numbers to know could not load right now.';
  if (facts) return 'No numbers to show right now.';
  return null;
}
