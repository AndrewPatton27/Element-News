// Cheap deterministic editorial exclusions. Runs before source-page/model work where possible.
// Inputs: RawItem plus mutable per-run counts. Output: null when eligible, otherwise a stable reject code.
import { config } from './config.ts';
import type { RawItem } from './types.ts';

export type TopicFilterState = { narrowCounts: Map<string, number> };
export const createTopicFilterState = (): TopicFilterState => ({ narrowCounts: new Map() });

/** Narrow source types: FAA airworthiness directives, USGS quakes and NASA releases (R-218 macro focus). */
export function narrowSourceType(item: RawItem): string | null {
  if (item.source === 'fedreg' && /airworthiness directive/i.test(item.title)) return 'faa_airworthiness_directive';
  if (item.source === 'usgs') return 'usgs_quake';
  if (item.source === 'nasa') return 'nasa_release';
  return null;
}

/** New cards allowed per run for a narrow source type (per-type cap, else the shared narrowSourceMaxPerRun). */
export function narrowCap(type: string): number {
  return config.reportCard.narrowSourceCaps[type] ?? config.reportCard.narrowSourceMaxPerRun;
}

/** The narrow-source cap alone (used by USGS, which does not go through filterTopic). */
export function narrowCapReached(item: RawItem, state: TopicFilterState): boolean {
  const narrow = narrowSourceType(item);
  return !!narrow && (state.narrowCounts.get(narrow) ?? 0) >= narrowCap(narrow);
}

export function filterTopic(item: RawItem, state: TopicFilterState): string | null {
  const title = item.title ?? '';
  const summary = item.summary_text ?? '';
  if (narrowCapReached(item, state)) return 'report_card_variety_cap';
  if (/\bform\s*144\b/i.test(title) || /\b(routine|technical)\s+(?:sec\s+)?(?:exhibit|amendment|supplement)\s+(?:filing|paperwork)\b/i.test(title)) return 'report_card_topic_exclusion';

  // FAA directives are the named narrow source type: let at most the configured variety through.
  if (config.reportCard.denyTitlePatterns.some((pattern) => pattern.test(title))) {
    // A broad consequential business story can contain otherwise noisy terms.
    if (!config.reportCard.allowBusinessContextPatterns.some((pattern) => pattern.test(`${title} ${summary}`))) {
      return 'report_card_topic_exclusion';
    }
  }
  const sourceContext = `${title} ${summary}`;
  if (/\b(celebrity|actor|actress|singer|athlete|team|tournament|championship|game)\b/i.test(sourceContext)
    && !config.reportCard.allowBusinessContextPatterns.some((pattern) => pattern.test(sourceContext))) return 'report_card_topic_exclusion';
  return null;
}

/** Count an item only after passing deterministic exclusions, so skipped duplicates do not consume variety. */
export function recordTopic(item: RawItem, state: TopicFilterState): void {
  const narrow = narrowSourceType(item);
  if (narrow) state.narrowCounts.set(narrow, (state.narrowCounts.get(narrow) ?? 0) + 1);
}
