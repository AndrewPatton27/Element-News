// Visible on every screen in mock mode, so sample cards are never mistaken for news.

import { StyleSheet, Text } from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, space } from '../../lib/theme/theme';

export function SampleBanner() {
  const p = usePalette();
  return (
    <Text style={[styles.banner, { backgroundColor: p.dataSoft, color: p.dataInk }]}>SAMPLE DATA · fictional cards for testing, not real news</Text>
  );
}

const styles = StyleSheet.create({
  banner: { fontFamily: fonts.sansSemi, textAlign: 'center', fontSize: 13, letterSpacing: 0.3, paddingVertical: 6, paddingHorizontal: space.lg },
});
