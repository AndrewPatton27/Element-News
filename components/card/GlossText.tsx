// D-02 tap-to-define (flag `glossary`). GlossText draws text with its glossary terms underlined (a dotted line,
// not a link colour, so the text still reads as text); tapping one calls onTerm. DefineSheet shows the meaning in a
// small panel with the same open/close motion as the other sheets. The word list is static (lib/glossary/glossary.ts):
// no AI and no network. With the flag off, plain Text is used and none of this loads.

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { SheetModal } from '../shell/SheetModal';
import { glossaryTermsIn, segmentText, type GlossaryTerm } from '../../lib/glossary/glossary';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';

export function GlossText({ text, style, onTerm }: { text: string; style?: StyleProp<TextStyle>; onTerm: (t: GlossaryTerm) => void }) {
  const p = usePalette();
  const parts = useMemo(() => segmentText(text), [text]);
  return (
    <Text style={style}>
      {parts.map((s, i) =>
        s.term ? (
          <Text
            key={i}
            onPress={() => onTerm(s.term as GlossaryTerm)}
            accessibilityRole="button"
            accessibilityLabel={`${s.text}, tap for the meaning`}
            style={{ textDecorationLine: 'underline', textDecorationStyle: 'dotted', textDecorationColor: p.accentInk, cursor: 'pointer' }}
          >
            {s.text}
          </Text>
        ) : (
          s.text
        ),
      )}
    </Text>
  );
}

/**
 * "Words in this story": one 44 px tall button per glossary term found in the texts. The dotted underline in the
 * text is a tap target only as tall as a line of text; this row is the reliable one (D-232).
 */
export function GlossaryWords({ texts, onTerm }: { texts: string[]; onTerm: (t: GlossaryTerm) => void }) {
  const p = usePalette();
  const terms = useMemo(() => glossaryTermsIn(texts), [texts.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (terms.length === 0) return null;
  return (
    <View style={styles.words} testID="glossary-words">
      <Text style={[styles.wordsLabel, { color: p.muted }]} accessibilityRole="header" aria-level={3}>
        Words in this story
      </Text>
      <View style={styles.wordsRow}>
        {terms.map((t) => (
          <Pressable
            key={t.term}
            onPress={() => onTerm(t)}
            accessibilityRole="button"
            accessibilityLabel={`What does ${t.term} mean?`}
            style={({ pressed }) => [styles.wordChip, { borderColor: p.borderStrong, backgroundColor: p.surface, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.wordText, { color: p.accentInk }]}>{t.term}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function DefineSheet({ term, onClose }: { term: GlossaryTerm | null; onClose: () => void }) {
  const p = usePalette();
  return (
    <SheetModal
      open={term !== null}
      onClose={onClose}
      variant="panel"
      label={term ? `Meaning of ${term.term}` : 'Meaning'}
      backdropLabel="Close meaning"
      dockStyle={styles.center}
      surfaceStyle={[styles.panel, { borderColor: p.border }]}
    >
      <View style={styles.body}>
        <Text style={[styles.kicker, { color: p.muted }]}>Plain meaning</Text>
        <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header" testID="define-term">
          {term?.term ?? ''}
        </Text>
        <Text style={[styles.text, { color: p.inkBody }]} testID="define-meaning">
          {term?.meaning ?? ''}
        </Text>
      </View>
      <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.done, { borderTopColor: p.divider, opacity: pressed ? 0.7 : 1 }]}>
        <Text style={[styles.doneText, { color: p.accentInk }]}>Got it</Text>
      </Pressable>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  words: { gap: 8 },
  wordsLabel: { fontFamily: fonts.sansSemi, fontSize: 13 },
  wordsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  wordChip: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  wordText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  panel: { width: '100%', maxWidth: 360, borderRadius: radius.tile, borderWidth: 1, overflow: 'hidden' },
  body: { paddingTop: 20, paddingHorizontal: 20, paddingBottom: 16, gap: 6 },
  kicker: { fontFamily: fonts.sansMedium, fontSize: 12, letterSpacing: 0.4, textTransform: 'uppercase' },
  title: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 28 },
  text: { fontFamily: fonts.sans, fontSize: font.body, lineHeight: 23 },
  done: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1 },
  doneText: { fontFamily: fonts.sansSemi, fontSize: font.body },
});
