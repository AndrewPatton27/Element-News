// Latest stays strictly chronological (master list conflict 10). Cards the reader disliked, and their twins (same
// dedupe key, same headline, a linked update), are NOT removed there: they are dimmed. The hard exclusion is For you
// only. UI hook: `const dim = latestDimmed(cards, reactions)`, then render a card with `dim.has(card.id)` at lower
// opacity (like and dislike buttons stay; undoing the dislike lifts the dim). Pure; no I/O.

import type { BlurbCard } from '../../contract/types.ts';
import type { LocalPrefs } from '../storage/localPrefs.ts';
import { dislikeIndex } from './cardKeys.ts';

/** Ids to dim: disliked on this device (and twins), or disliked on the account (server my_reaction). */
export function latestDimmed(cards: readonly BlurbCard[], reactions: LocalPrefs['reactions']): Set<string> {
  const disliked = dislikeIndex(reactions);
  const out = new Set<string>();
  for (const c of cards) if (disliked(c) || (c as { my_reaction?: string | null }).my_reaction === 'dislike') out.add(c.id);
  return out;
}

/** Opacity for a Latest card (one place to tune it). */
export const LATEST_DIM_OPACITY = 0.45;
