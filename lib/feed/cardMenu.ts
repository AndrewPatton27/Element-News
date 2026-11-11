// Which entries the card's "⋯" menu offers, in order. Pure; tested in lib/__tests__/cardMenu.test.ts.
//   fewer      "Fewer like this" (a dislike for this card; the quickest, so first)
//   hideTopic  "Hide <topic> topics" (not on data cards: a Treasury or BLS number card is not "a Business story")
//   hideSource "Hide cards from <source>" (only when the server supports hidden sources)
//   report     "Report a problem"

import type { BlurbCard } from '../../contract/types.ts';

//   save       "Save for later" / "Remove from saved" (flag `signals`, A-22)
//   muteTicker "Mute <company>" (flag `signals`; only when the card has a company)
//   muteTopic  "Mute <fine topic>" (flag `signals`; only when the card carries a fine topic)
export type MenuItemId = 'fewer' | 'save' | 'muteTicker' | 'muteTopic' | 'hideTopic' | 'hideSource' | 'report';

export function menuItems(card: Pick<BlurbCard, 'kind'> | null, o: { canHideSource: boolean; signals?: { ticker?: boolean; topic?: boolean } }): MenuItemId[] {
  const items: MenuItemId[] = ['fewer'];
  if (o.signals) {
    items.push('save');
    if (o.signals.ticker) items.push('muteTicker');
    if (o.signals.topic) items.push('muteTopic');
  }
  if (card && card.kind !== 'data') items.push('hideTopic');
  if (o.canHideSource) items.push('hideSource');
  items.push('report');
  return items;
}
