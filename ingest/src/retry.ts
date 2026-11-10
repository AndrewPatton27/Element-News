// Retry bookkeeping for items whose report-card step failed for a reason that may be transient (the scorer judged
// the card ABANDON, or the one allowed rewrite did not pass the checks). Before this, such an item was marked
// 'skipped' for good (about 316 items in 30 days, R-254). Now it stays 'new' and is tried again in a later run, at most
// config.reportCard.maxRetries times, then it is skipped for good.
//
// The counter lives in ingest.items.status_note as 'report_card_retry:<failures so far>:<code>' (no schema change; one
// short string that is overwritten, never appended, so it cannot grow). api.upsert_item returns status_note
// (20261129000000_supply_ops.sql) and the pipeline passes it in here.
// Inputs: the item's current status_note and the failure code. Outputs: the status and note to store.
import { config } from './config.ts';

const RETRY_NOTE = /^report_card_retry:(\d{1,3}):/;

/** Failures recorded so far in a status_note (0 when it holds no counter). */
export function reportCardFailures(note: string | null | undefined): number {
  const m = RETRY_NOTE.exec(note ?? '');
  return m ? Math.min(Number(m[1]), 999) : 0;
}

export interface RetryDecision { status: 'new' | 'skipped'; note: string; failures: number }

/**
 * The failure just happened (`code`, e.g. 'report_card_revise_failed'). Failure number n = previous + 1. While n is below
 * `max` the item stays 'new' with the counter in the note; at `max` it is skipped with the plain code (so requeue-skipped.sql,
 * which matches 'report_card_%', finds it).
 */
export function decideReportCardRetry(note: string | null | undefined, code: string, max: number = config.reportCard.maxRetries): RetryDecision {
  const failures = reportCardFailures(note) + 1;
  if (failures >= max) return { status: 'skipped', note: code, failures };
  return { status: 'new', note: `report_card_retry:${failures}:${code}`, failures };
}
