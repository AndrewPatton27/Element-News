// Story lists on the Brief screen. The ranked list ("Today in a minute", "Top stories ·
// last week": a big accent number, meta line, serif headline, optional one-line teaser) and
// the plain category sections. The headline opens the card's DetailSheet; under it every row
// carries a small source chip and one muted labels line (rule 5), so no row is unlabelled.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../contract/types.ts';
import { briefRowLabels, seeAllLabel, splitSection, teaser } from '../lib/briefLogic';
import { cardTime, categoryName, clampHeadline } from '../lib/format';
import { openUrl } from '../lib/openUrl';
import { usePalette } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { badgeLabel } from './Card';
import { LinkIcon } from './Icons';
import { ShareAlikeLine } from './Labels';
import { CardActionRow } from './CardActionRow';

export function BriefLabel({ text, right, onRight, rightA11y }: { text: string; right?: string; onRight?: () => void; rightA11y?: string }) {
  const p = usePalette();
  return (
    <View style={styles.labelRow}>
      <Text accessibilityRole="header" style={[styles.label, { color: p.muted }]}>
        {text}
      </Text>
      {right && onRight ? (
        <Pressable onPress={onRight} accessibilityRole="link" accessibilityLabel={rightA11y ?? right} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} style={styles.seeAll}>
          <Text style={[styles.seeAllText, { color: p.accent }]}>{right} ›</Text>
        </Pressable>
      ) : right ? (
        <Text style={[styles.labelRight, { color: p.muted }]}>{right}</Text>
      ) : null}
    </View>
  );
}

interface ListProps {
  label: string;
  right?: string;
  cards: BlurbCard[];
  categories: Category[];
  config: AppConfig | null;
  onOpen: (card: BlurbCard) => void;
  wide: boolean;
  ranked?: boolean; // numbered rows with a teaser line (the headline list)
  showTeaser?: boolean;
  preview?: number; // show only this many rows, the rest behind a Show more toggle
  total?: number; // all eligible stories of the topic (for See all N)
  onSeeAll?: () => void; // opens the feed filtered to this topic
}

export function BriefStories({ label, right, cards: all, categories, config, onOpen, wide, ranked, showTeaser, preview, total, onSeeAll }: ListProps) {
  const p = usePalette();
  const [expanded, setExpanded] = useState(false);
  if (all.length === 0) return null;
  const { shown: cards, hidden } = splitSection(all, expanded, preview ?? Number.MAX_SAFE_INTEGER);
  const seeAll = onSeeAll && total !== undefined ? seeAllLabel(total, all.length) : null;
  return (
    <View accessibilityRole="list" accessibilityLabel={label} style={styles.list}>
      <BriefLabel
        text={label}
        right={seeAll ?? right}
        onRight={seeAll ? onSeeAll : undefined}
        rightA11y={seeAll ? `${seeAll} stories in ${label}. Opens the feed for this topic` : undefined}
      />
      {cards.map((c, i) => {
        const line = ranked && showTeaser ? teaser(c.body, wide ? 150 : 90) : '';
        const meta = [badgeLabel(c), ...(ranked ? [categoryName(c.category, categories)] : []), cardTime(c)].filter(Boolean).join(' · ');
        return (
          <View key={c.id} style={[styles.row, wide && styles.rowWide, { borderTopColor: p.border }]}>
            {ranked ? <Text style={[styles.rank, wide && styles.rankWide, { color: p.accent }]}>{i + 1}</Text> : null}
            <View style={styles.text}>
              <Pressable
                onPress={() => onOpen(c)}
                accessibilityRole="button"
                accessibilityLabel={`${ranked ? `${i + 1}. ` : ''}${clampHeadline(c.headline)}. ${meta}. Opens more detail`}
                style={({ pressed }) => [styles.open, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.meta, wide && styles.metaWide, { color: p.muted }]}>{meta}</Text>
                <Text style={[ranked ? styles.title : styles.titlePlain, wide && (ranked ? styles.titleWide : styles.titlePlainWide), { color: p.ink }]}>
                  {clampHeadline(c.headline)}
                </Text>
                {line ? <Text style={[styles.line, wide && styles.lineWide, { color: p.inkSoft }]}>{line}</Text> : null}
              </Pressable>
              <RowLabels card={c} config={config} />
              <CardActionRow card={c} compact />
            </View>
          </View>
        );
      })}
      {preview !== undefined && all.length > preview ? (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Show fewer stories in ${label}` : `Show ${hidden} more stories in ${label}`}
          aria-expanded={expanded}
          style={({ pressed }) => [styles.more, { borderTopColor: p.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.moreText, { color: p.accent }]}>{expanded ? 'Show fewer' : `Show ${hidden} more`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Rule 5, per row: a small source chip (opens the original, https only) and one muted line
// with the AI label (AI-written cards only) and the disclaimer, once.
function RowLabels({ card, config }: { card: BlurbCard; config: AppConfig | null }) {
  const p = usePalette();
  const { source, line, credit } = briefRowLabels(card, config);
  return (
    <View style={styles.labels}>
      {source ? (
        <Pressable
          onPress={() => openUrl(source.url, card.id)}
          accessibilityRole="link"
          accessibilityLabel={`Source: ${source.label}${source.count > 1 ? `, ${source.count} sources` : ''}. Opens the original.`}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          style={({ pressed }) => [styles.chip, { backgroundColor: p.surfaceMuted, opacity: pressed ? 0.75 : 1 }]}
        >
          <LinkIcon color={p.ink} size={12} />
          <Text style={[styles.chipText, { color: p.ink }]} numberOfLines={1}>
            {source.label}
          </Text>
          {source.count > 1 ? <Text style={[styles.chipCount, { color: p.muted }]}>+{source.count - 1}</Text> : null}
        </Pressable>
      ) : null}
      {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
      <Text style={[styles.small, { color: p.muted }]}>{line}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flexDirection: 'column' },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 6 },
  label: { fontFamily: fonts.sansSemi, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  labelRight: { fontFamily: fonts.sans, fontSize: 13 },
  seeAll: { minHeight: 32, justifyContent: 'center' },
  seeAllText: { fontFamily: fonts.sansSemi, fontSize: 14 },
  more: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1 },
  moreText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  row: { flexDirection: 'row', gap: 14, paddingVertical: 14, borderTopWidth: 1 },
  rowWide: { gap: 20, paddingVertical: 22 },
  rank: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 26, minWidth: 20 },
  rankWide: { fontSize: 34, lineHeight: 34, minWidth: 28 },
  text: { flex: 1, gap: 6 },
  open: { gap: 4 },
  labels: { gap: 4, alignItems: 'flex-start' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  chipText: { flexShrink: 1, fontFamily: fonts.sansSemi, fontSize: 12 },
  chipCount: { fontFamily: fonts.sans, fontSize: 12 },
  small: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  meta: { fontFamily: fonts.sans, fontSize: 12 },
  metaWide: { fontSize: 13 },
  title: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 23 },
  titleWide: { fontSize: 28, lineHeight: 32, letterSpacing: -0.4 },
  titlePlain: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 22 },
  titlePlainWide: { fontSize: 22, lineHeight: 27 },
  line: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  lineWide: { fontSize: 17, lineHeight: 25, maxWidth: 640 },
});
