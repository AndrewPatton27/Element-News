// The body of a card's standalone view, shared by the "More detail" sheet (DetailSheet) and the shared-card
// page (app/b/[id].tsx): headline, the source line (agency and time, opening the original), key points, the
// numbers of a data card, the in-depth paragraphs (or the summary with a note), the sources, the Wikipedia
// credit, then the AI label and the disclaimer. A standalone view keeps both texts itself (rule 5, D-80);
// `alwaysAiNotice` shows the AI notice even when a card does not say it was AI-generated (the share page).
// The headline is a level-2 heading by default (the page or sheet title is level 1).

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard } from '../../contract/types.ts';
import { NO_DETAIL_MESSAGE, dataMeasures, detailKeyPoints, detailParagraphs, showNoDetailNote } from '../../lib/shared/detail';
import { clampHeadline } from '../../lib/shared/format';
import { aiNoticeText, cardLabels, primarySource, shareAlikeCredit } from '../../lib/shared/labels';
import { openUrl } from '../../lib/shared/openUrl';
import { isHttpUrl } from '../../lib/shared/types';
import { BarSource } from './CardBar';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { AiLabel, Disclaimer, ShareAlikeLine } from './Labels';
import { SourceList } from './SourceList';
import { DataFacts } from './DataCard';
import { DefineSheet, GlossText, GlossaryWords } from './GlossText';
import { flagOn } from '../../lib/flags/flags';
import type { GlossaryTerm } from '../../lib/glossary/glossary';

interface Props {
  card: BlurbCard;
  config: AppConfig | null;
  headingLevel?: 1 | 2;
  alwaysAiNotice?: boolean;
}

export function DetailBody({ card, config, headingLevel = 2, alwaysAiNotice = false }: Props) {
  const p = usePalette();
  const wide = useWide();
  // D-02: with the `glossary` flag on, jargon in the key points and paragraphs is tap-to-define.
  const gloss = flagOn('glossary');
  const [term, setTerm] = useState<GlossaryTerm | null>(null);
  const keyPoints = detailKeyPoints(card);
  const { paragraphs } = detailParagraphs(card);
  const noDetail = showNoDetailNote(card);
  const measures = dataMeasures(card);
  const labels = cardLabels(card, config);
  const aiLabel = labels.aiLabel ?? (alwaysAiNotice ? aiNoticeText(config) : null);
  const credit = shareAlikeCredit(card, config);
  const primary = primarySource(card);
  const original = primary && isHttpUrl(primary.url) ? primary.url : null;

  return (
    <>
      <Text style={[styles.headline, { color: p.ink }]} accessibilityRole="header" aria-level={headingLevel}>
        {clampHeadline(card.headline)}
      </Text>
      {original ? (
        <View style={[styles.sourceLine, { borderColor: p.divider }]}>
          <BarSource card={card} link linkUrl={original} timeLabel="added" onPress={() => openUrl(original, card.id)} size={wide ? 'wide' : 'phone'} />
        </View>
      ) : null}

      {keyPoints.length ? (
        <View style={[styles.points, { backgroundColor: p.surfaceMuted }]}>
          <Text style={[styles.h3, { color: p.ink }]} accessibilityRole="header" aria-level={headingLevel + 1}>
            Key points
          </Text>
          {keyPoints.map((k, i) => (
            <View key={i} style={styles.point}>
              <Text style={[styles.bullet, { color: p.inkSoft }]}>•</Text>
              {gloss ? <GlossText text={k} style={[styles.pointText, { color: p.inkSoft }]} onTerm={setTerm} /> : <Text style={[styles.pointText, { color: p.inkSoft }]}>{k}</Text>}
            </View>
          ))}
        </View>
      ) : null}

      {card.kind === 'data' ? <DataFacts card={card} config={config} chartH={170} detail /> : null}

      {paragraphs.map((t, i) =>
        gloss ? (
          <GlossText key={i} text={t} style={[styles.para, { color: p.inkSoft }]} onTerm={setTerm} />
        ) : (
          <Text key={i} style={[styles.para, { color: p.inkSoft }]}>
            {t}
          </Text>
        ),
      )}
      {gloss ? <GlossaryWords texts={[...keyPoints, ...paragraphs]} onTerm={setTerm} /> : null}
      {measures.length ? (
        <View style={styles.sources}>
          <Text style={[styles.h3, { color: p.ink }]} accessibilityRole="header" aria-level={headingLevel + 1}>
            What this number measures
          </Text>
          {measures.map((m) => (
            <Text key={m.label} style={[styles.pointText, { color: p.inkSoft }]}>
              <Text style={{ fontFamily: fonts.sansSemi, color: p.ink }}>{m.label}: </Text>
              {m.text}
            </Text>
          ))}
        </View>
      ) : null}
      {noDetail ? <Text style={[styles.note, { color: p.muted }]}>{NO_DETAIL_MESSAGE}</Text> : null}

      <View style={styles.sources}>
        <Text style={[styles.h3, { color: p.ink }]} accessibilityRole="header" aria-level={headingLevel + 1}>
          Sources
        </Text>
        <SourceList card={card} config={config} plain />
      </View>

      <View style={styles.labels}>
        {credit ? <ShareAlikeLine credit={credit} cardId={card.id} /> : null}
        {aiLabel ? <AiLabel text={aiLabel} /> : null}
        <Disclaimer text={labels.disclaimer} />
      </View>
      {gloss ? <DefineSheet term={term} onClose={() => setTerm(null)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  sourceLine: { flexDirection: 'row', marginTop: -10, borderBottomWidth: 1, paddingBottom: 2 },
  headline: { fontFamily: fonts.serif, fontSize: 28, lineHeight: 31, letterSpacing: -0.56 },
  points: { borderRadius: 18, paddingVertical: 16, paddingHorizontal: 18, gap: 8 },
  h3: { fontFamily: fonts.sansSemi, fontSize: 15 },
  point: { flexDirection: 'row', gap: 8 },
  bullet: { fontFamily: fonts.sansSemi, fontSize: 16, lineHeight: 22 },
  pointText: { flex: 1, fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
  para: { fontFamily: fonts.sans, fontSize: 17, lineHeight: 26 },
  note: { fontFamily: fonts.sansMedium, fontSize: 14, fontStyle: 'italic' },
  sources: { gap: 10 },
  labels: { gap: 2 },
});
