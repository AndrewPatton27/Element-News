// Trust labels. The disclaimer is on every card; the AI label only on cards whose
// text was written by a model. Strings come from lib/labels.ts.

import { StyleSheet, Text } from 'react-native';
import { CC_BY_SA_MARK, disclaimerText, type ShareAlikeCredit } from '../lib/labels';
import { openUrl } from '../lib/openUrl';
import { usePalette } from '../lib/useTheme';
import { font, fonts } from '../lib/theme';

export function AiLabel({ text }: { text: string }) {
  const p = usePalette();
  return (
    <Text style={[styles.small, { color: p.muted }]} accessibilityLabel={text}>
      {text}
    </Text>
  );
}

export function Disclaimer({ text, center }: { text: string; center?: boolean }) {
  const p = usePalette();
  // Never blank: an empty string falls back to the built-in wording.
  return <Text style={[styles.small, { color: p.muted }, center && styles.center]}>{disclaimerText({ disclaimer: text })}</Text>;
}

// 'Adapted from Wikipedia ("Title") · CC BY-SA 4.0': the credit links to the article,
// the license mark links to the license (CC BY-SA attribution requirements).
export function ShareAlikeLine({ credit, cardId }: { credit: ShareAlikeCredit; cardId?: string }) {
  const p = usePalette();
  const at = credit.text.lastIndexOf(CC_BY_SA_MARK);
  const lead = at >= 0 ? credit.text.slice(0, at) : credit.text + ' · ';
  return (
    <Text style={[styles.small, { color: p.muted }]}>
      <Text onPress={() => openUrl(credit.articleUrl, cardId)} accessibilityRole="link" style={styles.link}>
        {lead.replace(/\s*·\s*$/, '')}
      </Text>
      {' · '}
      <Text onPress={() => openUrl(credit.licenseUrl)} accessibilityRole="link" style={styles.link}>
        {CC_BY_SA_MARK}
      </Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  link: { textDecorationLine: 'underline' },
  small: { fontFamily: fonts.sans, fontSize: font.small, lineHeight: 17 },
  center: { textAlign: 'center' },
});
