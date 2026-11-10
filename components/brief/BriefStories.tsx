// Story lists on the Brief screen. The ranked list ("Today in a minute", "Top stories ·
// last week": a big accent number, meta line, serif headline, optional one-line teaser) and
// the plain category sections. The headline opens the card's DetailSheet; under it every row
// carries the same one-line bar as the feed cards: source and time (opens the original, rule 5)
// and like / dislike / follow / share. The AI notice and the disclaimer are the Brief screen's
// persistent strip (D-80); a FRED-based row still shows the FRED notice (rule 8).

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import { briefRowLabels, seeAllLabel, splitSection, teaser } from '../../lib/brief/briefLogic';
import { categoryName, clampHeadline } from '../../lib/shared/format';
import { openUrl } from '../../lib/shared/openUrl';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { badgeLabel } from '../card/Card';
import { ShareAlikeLine } from '../card/Labels';
import { CardActionRow } from '../card/CardActionRow';
import { CardBar } from '../card/CardBar';

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
        const meta = [badgeLabel(c), ...(ranked ? [categoryName(c.category, categories)] : [])].filter(Boolean).join(' · ');
        return (
          <View key={c.id} style={[styles.row, wide && styles.rowWide, { borderTopColor: p.border }]}>
            {ranked ? <Text style={[styles.rank, wide && styles.rankWide, { color: p.accent }]}>{i + 1}</Text> : null}
            <View style={styles.text}>
              <Pressable
                onPress={() => onOpen(c)}
                accessibilityRole="button"
                accessibilityLabel={`${ranked ? `${i + 1}. ` : ''}${clampHeadline(c.headline)}. ${meta ? `${meta}. ` : ''}Opens more detail`}
                style={({ pressed }) => [styles.open, { opacity: pressed ? 0.7 : 1 }]}
              >
                {meta ? <Text style={[styles.meta, wide && styles.metaWide, { color: p.muted }]}>{meta}</Text> : null}
                <Text style={[ranked ? styles.title : styles.titlePlain, wide && (ranked ? styles.titleWide : styles.titlePlainWide), { color: p.ink }]}>
                  {clampHeadline(c.headline)}
                </Text>
                {line ? <Text style={[styles.line, wide && styles.lineWide, { color: p.inkSoft }]}>{line}</Text> : null}
              </Pressable>
              <RowLabels card={c} config={config} wide={wide} />
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

// Rule 5, per row: the bar's source opens the original (https only; briefRowLabels checks it),
// then the action buttons. Rows from FRED add the FRED notice above the bar.
function RowLabels({ card, config, wide }: { card: BlurbCard; config: AppConfig | null; wide: boolean }) {
  const p = usePalette();
  const { source, line, credit } = briefRowLabels(card, config);
  return (
    <View style={styles.labels}>
      {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
      {line ? <Text style={[styles.small, { color: p.muted }]}>{line}</Text> : null}
      <CardBar card={card} onPress={() => (source ? openUrl(source.url, card.id) : undefined)} link={!!source} size={wide ? 'wide' : 'phone'} divider={false}>
        <CardActionRow card={card} compact />
      </CardBar>
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
  open: { gap: 4, minHeight: 44 },
  labels: { gap: 2, alignSelf: 'stretch' },
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
