import type { BlurbCard } from '../contract/types.ts';
import type { LocalPrefs } from './localPrefs.ts';
import { rankLocal } from './localRank.ts';

/** Preserve the server's direct tier, then personalize within each tier. */
export function rerankFollowing(cards: BlurbCard[], prefs: LocalPrefs): BlurbCard[] {
  const unique = cards.filter((card, i) => cards.findIndex((other) => other.id === card.id) === i);
  const direct: BlurbCard[] = [];
  const related: BlurbCard[] = [];
  for (const card of unique) {
    const reason = card.follow_reason ?? '';
    (reason.startsWith('Because you follow') || Boolean(card.story_link) || reason.toLowerCase().includes('story-link') ? direct : related).push(card);
  }
  return [...rankLocal(direct, prefs), ...rankLocal(related, prefs)];
}
