// Any unknown URL: a plain page with a way back, instead of Expo's developer screen.

import { StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { usePalette } from '../lib/theme/useTheme';
import { fonts } from '../lib/theme/theme';
import { Shell } from '../components/shell/Shell';
import { Button } from '../components/shell/States';

export default function NotFoundScreen() {
  const p = usePalette();
  return (
    <Shell active="feed" scroll>
      <Text style={[styles.title, { color: p.ink }]} accessibilityRole="header">
        Page not found
      </Text>
      <Text style={[styles.text, { color: p.muted }]}>This link doesn’t lead anywhere. The feed is one tap away.</Text>
      <Button label="Go to the feed" onPress={() => router.replace('/')} />
    </Shell>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 37, letterSpacing: -0.5 },
  text: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 22 },
});
