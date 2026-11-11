// C16: following "Government" must not pull in FAA airworthiness orders or NASA items. The real fix is data
// (retag FAA orders to Recalls & Safety, NASA to Science & Space; server side), but until every card is
// retagged the Following page drops those two kinds when the ONLY reason they are here is the Government
// topic. A card the reader asked for in another way (that source, a company, a story) always stays.

import type { BlurbCard } from '../../contract/types.ts';
import { isAirworthinessCard } from '../feed/feedOrder.ts';
import { cardSourceKey } from '../sources/sourceKeys.ts';
import type { Follows } from './followingLogic.ts';

const GOVERNMENT = 'policy';

export function isGovernmentMisfit(card: BlurbCard): boolean {
  return isAirworthinessCard(card) || cardSourceKey(card) === 'nasa';
}

export function withoutGovernmentMisfits(cards: BlurbCard[], follows: Pick<Follows, 'topics' | 'sources'>): BlurbCard[] {
  if (!follows.topics.includes(GOVERNMENT)) return cards;
  const names = new Set(follows.sources.map((s) => s.toLocaleLowerCase()));
  return cards.filter((c) => {
    if (!isGovernmentMisfit(c)) return true;
    if (c.follow_match === 'ticker' || c.follow_match === 'company' || c.story_link) return true;
    // The reader follows the card's own source (Federal Register, NASA): they asked for it.
    if (c.follow_match === 'source' || c.sources.some((s) => names.has(s.name.toLocaleLowerCase()))) return true;
    return false;
  });
}
