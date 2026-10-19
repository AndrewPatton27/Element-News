import { Pressable, StyleSheet, View } from 'react-native';
import { tip } from '../../lib/theme/tooltip';
import type { BlurbCard } from '../../contract/types.ts';
import { useCardActions } from '../../lib/shared/useCardActions';
import { usePalette } from '../../lib/theme/useTheme';
import { PulseIcon, ShareIcon, ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';

export function CardActionRow({ card, compact = false }: { card: BlurbCard; compact?: boolean }) {
  const p = usePalette();
  const a = useCardActions(card);
  const on = (kind: 'like' | 'dislike') => a.reaction === kind;
  const button = (label: string, active: boolean, Icon: typeof ThumbUpIcon, press: () => void) => (
    <Pressable key={label} onPress={press} accessibilityRole="button" accessibilityLabel={label} {...tip(label)}
      accessibilityState={{ selected: active }} aria-pressed={active}
      style={({ pressed }) => [styles.button, compact && styles.compact, { backgroundColor: active ? p.accentSoft : 'transparent', opacity: pressed ? 0.7 : 1 }]}>
      <Icon color={active ? p.accent : p.ink} size={20} />
    </Pressable>
  );
  return <View style={styles.row}>
    {button('Like this story', on('like'), ThumbUpIcon, () => a.react('like'))}
    {button('Dislike this story', on('dislike'), ThumbDownIcon, () => a.react('dislike'))}
    {button('Follow this story', a.following, PulseIcon, a.toggleFollow)}
    {button('Share this story', false, ShareIcon, () => { void a.share(); })}
  </View>;
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 2 }, button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, compact: { width: 44, height: 44 } });
