// The "Markets" section of the Brief: the market stories (same rows as every topic: source
// chip, labels, opens the detail sheet) and the market numbers with their green / red / gray
// change (lib/numberTone.ts). Hidden entirely when there is nothing to show. No stock prices
// (rule 9): only news and agency numbers.

import { StyleSheet, View } from 'react-native';
import type { AppConfig, BlurbCard, Category, MacroFact, RequiredNotice } from '../contract/types.ts';
import { BriefNumbers } from './BriefNumbers';
import { BriefStories } from './BriefStories';

export function BriefMarkets({
  cards,
  numbers,
  total,
  notices,
  categories,
  config,
  onOpen,
  onSeeAll,
  wide,
}: {
  cards: BlurbCard[];
  numbers: MacroFact[];
  total: number;
  notices: RequiredNotice[];
  categories: Category[];
  config: AppConfig | null;
  onOpen: (card: BlurbCard) => void;
  onSeeAll?: () => void;
  wide: boolean;
}) {
  if (cards.length === 0 && numbers.length === 0) return null;
  return (
    <View accessibilityLabel="Markets" style={styles.box}>
      <BriefStories
        label="Markets"
        cards={cards}
        categories={categories}
        config={config}
        onOpen={onOpen}
        wide={wide}
        preview={3}
        total={total}
        onSeeAll={onSeeAll}
      />
      <BriefNumbers facts={numbers} notices={notices} title="Market numbers" wide={wide} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 14 },
});
