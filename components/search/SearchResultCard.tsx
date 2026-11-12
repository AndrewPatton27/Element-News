// One result tile for Search and the Following feed (design Mobile-Following / Web-Following story cards:
// white, 1 px border, 20 px corners), in the same shape as a feed card: badge and
// topic, serif headline, the key takeaways (or the summary), an optional "Because
// you follow X" line, a quiet "More detail" link, then the one-line bottom bar
// (source and time, opening the sources sheet with links to the originals; like,
// dislike, follow, share). The AI notice and the disclaimer are the screen's
// persistent strip (D-80). No images, no prices.

import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { categoryName, clampHeadline } from '../../lib/shared/format';
import { shareAlikeCredit } from '../../lib/shared/labels';
import { OPEN_DETAIL_HINT } from '../../lib/shared/detail';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { badgeLabel } from '../card/Card';
import { ShareAlikeLine } from '../card/Labels';
import { CardActionRow } from '../card/CardActionRow';
import { CardTemplate } from '../card/templates/CardTemplate';

export interface SearchResultCardProps {
  card: BlurbCard;
  config: AppConfig | null;
  categories: Category[];
  reason?: string | null; // Following: "Because you follow Economy"
  related?: string | null; // Following: "Update to: <headline>"
  onOpen: (card: BlurbCard) => void; // opens the "More detail" sheet
  onShowSources: (card: BlurbCard) => void;
}

// All the card's information is passed to the shared template (components/card/templates).
export function SearchResultCard({ card, config, categories, reason, related, onOpen, onShowSources }: SearchResultCardProps) {
  const p = usePalette();
  const wide = useWide();
  const credit = shareAlikeCredit(card, config);
  const isData = card.kind === 'data';
  return (
    <CardTemplate
      card={card}
      wide={wide}
      meta={{ layout: 'inline', dot: isData ? p.dataInk : p.accent, badge: badgeLabel(card), badgeColor: isData ? p.dataInk : p.accentInk, text: categoryName(card.category, categories) }}
      onOpen={() => onOpen(card)}
      openLabel={`${clampHeadline(card.headline)}. ${OPEN_DETAIL_HINT}`}
      related={related}
      reason={reason}
      moreLabel={`More detail: ${clampHeadline(card.headline)}`}
      onMore={() => onOpen(card)}
      smallPrint={credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
      bar={{ onPress: () => onShowSources(card), actions: <CardActionRow card={card} compact /> }}
    />
  );
}
