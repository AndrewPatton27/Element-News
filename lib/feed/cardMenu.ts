// Which entries the card's "⋯" menu offers, in order. Pure; tested in lib/__tests__/cardMenu.test.ts.
//   fewer      "Fewer like this" (a dislike for this card; the quickest, so first)
//   hideTopic  "Hide <topic> topics" (not on data cards: a Treasury or BLS number card is not "a Business story")
//   hideSource "Hide cards from <source>" (only when the server supports hidden sources)
//   report     "Report a problem"

import type { BlurbCard } from '../../contract/types.ts';

export type MenuItemId = 'fewer' | 'hideTopic' | 'hideSource' | 'report';

export function menuItems(card: Pick<BlurbCard, 'kind'> | null, o: { canHideSource: boolean }): MenuItemId[] {
  const items: MenuItemId[] = ['fewer'];
  if (card && card.kind !== 'data') items.push('hideTopic');
  if (o.canHideSource) items.push('hideSource');
  items.push('report');
  return items;
}
