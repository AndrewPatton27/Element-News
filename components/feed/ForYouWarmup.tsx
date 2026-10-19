// Shown instead of the For you feed until the reader has given it enough to learn from.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FOR_YOU_MIN_STORIES, FOR_YOU_MIN_TOPICS, type ForYouProgress } from '../../lib/feed/forYouGate';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function ForYouWarmup({ progress, onBack }: { progress: ForYouProgress; onBack: () => void }) {
  const p = usePalette();
  const stories = Math.min(progress.stories, FOR_YOU_MIN_STORIES);
  const topics = Math.min(progress.topics, FOR_YOU_MIN_TOPICS);
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <View style={[styles.panel, { backgroundColor: p.surface, borderColor: p.border }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.ink }]}>Your For you feed is warming up</Text>
        <Text style={[styles.text, { color: p.muted }]}>Read and react to a few more stories across different topics so we can learn what you like.</Text>
        <Text style={[styles.line, { color: p.ink }]}>{stories} of {FOR_YOU_MIN_STORIES} stories</Text>
        <Text style={[styles.line, { color: p.ink }]}>{topics} of {FOR_YOU_MIN_TOPICS} topics</Text>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to Trending"
          style={({ pressed }) => [styles.btn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.btnText, { color: p.onAccent }]}>Back to Trending</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  panel: { width: '100%', maxWidth: 460, borderWidth: 1, borderRadius: 20, padding: 24, gap: 10, alignItems: 'center' },
  title: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 28, textAlign: 'center' },
  text: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  line: { fontFamily: fonts.sansSemi, fontSize: 15 },
  btn: { minHeight: 48, minWidth: 200, paddingHorizontal: 24, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  btnText: { fontFamily: fonts.sansSemi, fontSize: 16 },
});
