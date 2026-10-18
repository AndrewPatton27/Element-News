// How long the reader actually looks at each card ("dwell"), for the For you feed.
// The clock runs only while a card is the active one AND nothing pauses it (tab
// or app hidden, a sheet open, another screen on top). Time spent in the detail
// sheet is not dwell; it is sent separately as 'open_detail'. Pure: no React.

export const DWELL_MIN_MS = 300; // shorter looks are scroll-bys: not sent
export const DWELL_MAX_MS = 600_000; // cap (10 min); the server treats very long looks as "walked away"

export type PauseReason = 'hidden' | 'sheet' | 'away';

export interface DwellRecord {
  cardId: string;
  ms: number;
}

export class DwellTimer {
  private cardId: string | null = null;
  private total = 0;
  private since: number | null = null; // when the clock last started running
  private pauses = new Set<PauseReason>();

  private running(): boolean {
    return this.cardId !== null && this.pauses.size === 0;
  }

  private settle(now: number) {
    if (this.since !== null) {
      this.total += Math.max(0, now - this.since);
      this.since = null;
    }
  }

  private resumeIfFree(now: number) {
    if (this.running() && this.since === null) this.since = now;
  }

  /** The card on screen changed (or null: none). Returns the finished record for the previous card, if worth sending. */
  show(cardId: string | null, now: number): DwellRecord | null {
    if (cardId === this.cardId) return null;
    const done = this.finish(now);
    this.cardId = cardId;
    this.resumeIfFree(now);
    return done;
  }

  pause(reason: PauseReason, now: number) {
    this.settle(now);
    this.pauses.add(reason);
  }

  resume(reason: PauseReason, now: number) {
    this.pauses.delete(reason);
    this.resumeIfFree(now);
  }

  /** Ends the current card's look (sign-out, page hide, unmount). */
  finish(now: number): DwellRecord | null {
    this.settle(now);
    const record =
      this.cardId !== null && this.total >= DWELL_MIN_MS ? { cardId: this.cardId, ms: Math.min(Math.round(this.total), DWELL_MAX_MS) } : null;
    this.cardId = null;
    this.total = 0;
    return record;
  }

  /** Milliseconds counted so far for the current card (for tests). */
  elapsed(now: number): number {
    return this.total + (this.since !== null ? Math.max(0, now - this.since) : 0);
  }
}
