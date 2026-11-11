// The card's "⋯" options (everyone; signed out the choice is kept on this device): fewer like
// this, hide this card's topic or source, report a problem. A small sheet with large tap targets;
// Escape / back / tapping outside closes it. "Report a problem" opens a short list of reasons in
// the same sheet. Which entries show: lib/feed/cardMenu.ts.

import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SheetModal } from '../shell/SheetModal';
import type { BlurbCard, Category } from '../../contract/types.ts';
import { REPORT_REASONS, type ReportReason } from '../../lib/api/report';
import { menuItems } from '../../lib/feed/cardMenu';
import { categoryName } from '../../lib/shared/format';
import { cardSourceKey, sourceName } from '../../lib/sources/sourceKeys';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, radius, font } from '../../lib/theme/theme';

interface Props {
  card: BlurbCard | null;
  categories: Category[];
  onHideTopic: (card: BlurbCard) => void;
  /** "Fewer like this": records a dislike for the card. */
  onFewer: (card: BlurbCard) => void;
  /** "Report a problem" with a reason code (api.reportBlurb). */
  onReport: (card: BlurbCard, reason: ReportReason) => void;
  /** When the server supports hidden sources and the card's source can be switched off. */
  onHideSource?: (card: BlurbCard, key: string) => void;
  onClose: () => void;
  /** A-22 (flag `signals`): the extra entries. Absent = the menu is exactly as before. */
  signals?: {
    saved: boolean;
    onSave: (card: BlurbCard) => void;
    muteTicker?: (card: BlurbCard) => { symbol: string; name: string } | null;
    onMuteTicker?: (card: BlurbCard, symbol: string) => void;
    muteTopic?: (card: BlurbCard) => { slug: string; name: string } | null;
    onMuteTopic?: (card: BlurbCard, slug: string) => void;
  };
}

export function CardMenu({ card: openCard, categories, onHideTopic, onFewer, onReport, onClose, onHideSource, signals }: Props) {
  const p = usePalette();
  const [reporting, setReporting] = useState(false);
  // Keep the last card while the panel fades out, so it doesn't empty out first.
  const last = useRef(openCard);
  if (openCard) last.current = openCard;
  const card = openCard ?? last.current;
  useEffect(() => {
    if (openCard === null) setReporting(false);
  }, [openCard]);
  const topic = card ? categoryName(card.category, categories) : '';
  const sourceKey = card && onHideSource ? cardSourceKey(card) : null;
  const mt = card && signals?.muteTicker ? signals.muteTicker(card) : null;
  const mtopic = card && signals?.muteTopic ? signals.muteTopic(card) : null;
  const items = menuItems(card, { canHideSource: !!sourceKey, signals: signals ? { ticker: !!mt, topic: !!mtopic } : undefined });
  const row = (first: boolean, pressed: boolean) => [styles.item, !first && styles.divided, !first && { borderTopColor: p.divider }, { opacity: pressed ? 0.7 : 1 }];
  return (
    <SheetModal
      open={openCard !== null}
      onClose={onClose}
      variant="panel"
      label={reporting ? 'Report a problem' : 'Card options'}
      backdropLabel="Close options"
      dockStyle={styles.center}
      surfaceStyle={[styles.menu, { borderColor: p.border }]}
    >
      {reporting ? (
        <>
          <Text style={[styles.heading, { color: p.ink }]} accessibilityRole="header">What is the problem?</Text>
          {REPORT_REASONS.map((r) => (
            <Pressable key={r.code} onPress={() => card && onReport(card, r.code)} accessibilityRole="button" style={({ pressed }) => row(false, pressed)}>
              <Text style={[styles.itemText, { color: p.ink }]}>{r.label}</Text>
            </Pressable>
          ))}
        </>
      ) : (
        items.map((id, i) => {
          const first = i === 0;
          if (id === 'fewer')
            return (
              <Pressable key={id} onPress={() => card && onFewer(card)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>Fewer like this</Text>
                <Text style={[styles.hint, { color: p.muted }]}>Same as a thumbs down: you will see less of this kind of story.</Text>
              </Pressable>
            );
          if (id === 'save' && signals && card)
            return (
              <Pressable key={id} onPress={() => signals.onSave(card)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>{signals.saved ? 'Remove from saved' : 'Save for later'}</Text>
                <Text style={[styles.hint, { color: p.muted }]}>Your saved stories are in Account → Saved and signals.</Text>
              </Pressable>
            );
          if (id === 'muteTicker' && mt && signals?.onMuteTicker && card)
            return (
              <Pressable key={id} onPress={() => signals.onMuteTicker?.(card, mt.symbol)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>Mute {mt.name}</Text>
                <Text style={[styles.hint, { color: p.muted }]}>No more cards about {mt.symbol}. You can undo it in Saved and signals.</Text>
              </Pressable>
            );
          if (id === 'muteTopic' && mtopic && signals?.onMuteTopic && card)
            return (
              <Pressable key={id} onPress={() => signals.onMuteTopic?.(card, mtopic.slug)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>Mute {mtopic.name}</Text>
                <Text style={[styles.hint, { color: p.muted }]}>No more {mtopic.name} cards. You can undo it in Saved and signals.</Text>
              </Pressable>
            );
          if (id === 'hideTopic')
            return (
              <Pressable key={id} onPress={() => card && onHideTopic(card)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>Hide {topic} topics</Text>
                <Text style={[styles.hint, { color: p.muted }]}>You won’t see {topic} cards. You can undo this, or change it any time in Account.</Text>
              </Pressable>
            );
          if (id === 'hideSource' && sourceKey && card && onHideSource)
            return (
              <Pressable key={id} onPress={() => onHideSource(card, sourceKey)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
                <Text style={[styles.itemText, { color: p.ink }]}>Hide cards from {sourceName(sourceKey)}</Text>
                <Text style={[styles.hint, { color: p.muted }]}>Turn it back on any time in Account → Sources.</Text>
              </Pressable>
            );
          return (
            <Pressable key={id} onPress={() => setReporting(true)} accessibilityRole="button" style={({ pressed }) => row(first, pressed)}>
              <Text style={[styles.itemText, { color: p.ink }]}>Report a problem</Text>
              <Text style={[styles.hint, { color: p.muted }]}>Tell us if a card is wrong or its link is broken.</Text>
            </Pressable>
          );
        })
      )}
      <Pressable
        onPress={reporting ? () => setReporting(false) : onClose}
        accessibilityRole="button"
        style={({ pressed }) => [styles.item, styles.cancel, { borderTopColor: p.divider, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.cancelText, { color: p.accentInk }]}>{reporting ? 'Back' : 'Cancel'}</Text>
      </Pressable>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  menu: { width: '100%', maxWidth: 360, borderRadius: radius.tile, borderWidth: 1, overflow: 'hidden' },
  heading: { fontFamily: fonts.sansSemi, fontSize: font.body, paddingTop: 16, paddingHorizontal: 20, paddingBottom: 4 },
  item: { minHeight: 52, paddingVertical: 14, paddingHorizontal: 20, gap: 4, justifyContent: 'center' },
  itemText: { fontFamily: fonts.sansSemi, fontSize: font.body },
  hint: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
  divided: { borderTopWidth: 1 },
  cancel: { borderTopWidth: 1, alignItems: 'center' },
  cancelText: { fontFamily: fonts.sansSemi, fontSize: font.body },
});
