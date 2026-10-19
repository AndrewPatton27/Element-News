import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tip } from '../../lib/theme/tooltip';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BlurbCard } from '../../contract/types.ts';
import { useCardActions } from '../../lib/shared/useCardActions';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { shareUrl } from './cardFooter';
import { PulseIcon, ShareIcon, ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';

export function DetailActions({ card }: { card: BlurbCard }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const a = useCardActions(card);
  const button = (label: string, active: boolean, icon: ReactNode, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} {...tip(label)}
      accessibilityState={{ selected: active }} aria-pressed={active}
      style={({ pressed }) => [styles.button, { backgroundColor: active ? p.accentSoft : p.surfaceMuted, opacity: pressed ? 0.72 : 1 }]}>
      {icon}<Text numberOfLines={1} style={[styles.label, { color: active ? p.accentInk : p.ink }]}>{label === 'Follow this story' && active ? 'Following' : label.replace(' this story', '')}</Text>
    </Pressable>
  );
  return <View style={[styles.dock, { backgroundColor: p.surface, borderTopColor: p.border, paddingBottom: Math.max(insets.bottom, 8) }]}>
    <View style={styles.row}>
      {button('Like this story', a.reaction === 'like', <ThumbUpIcon color={a.reaction === 'like' ? p.accent : p.ink} />, () => a.react('like'))}
      {button('Dislike this story', a.reaction === 'dislike', <ThumbDownIcon color={a.reaction === 'dislike' ? p.accent : p.ink} />, () => a.react('dislike'))}
      {button('Follow this story', a.following, <PulseIcon color={a.following ? p.accent : p.ink} />, a.toggleFollow)}
      {shareUrl(card.share_path, null) ? button('Share this story', false, <ShareIcon color={p.ink} />, () => { void a.share(); }) : null}
    </View>
    {a.toast ? <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.toast, { color: p.ink }]}>{a.toast}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  dock: { borderTopWidth: 1, paddingTop: 10, paddingHorizontal: 12 },
  row: { flexDirection: 'row', gap: 6, justifyContent: 'space-between' },
  button: { flex: 1, minWidth: 44, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 2 },
  label: { fontFamily: fonts.sansMedium, fontSize: 12 },
  toast: { position: 'absolute', alignSelf: 'center', bottom: 62, fontFamily: fonts.sansMedium, fontSize: 13, padding: 7, backgroundColor: '#E6E9E4', borderRadius: 10, overflow: 'hidden' },
});
