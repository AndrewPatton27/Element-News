import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { tip } from '../../lib/theme/tooltip';
import type { BlurbCard } from '../../contract/types.ts';
import { useCardActions } from '../../lib/shared/useCardActions';
import { usePalette } from '../../lib/theme/useTheme';
import { followStoryLabel, showFollowLabel } from '../../lib/feed/cardFooterLabels';
import { fonts } from '../../lib/theme/theme';
import { PulseIcon, ShareIcon, ThumbDownIcon, ThumbUpIcon } from '../shell/Icons';

export function CardActionRow({ card, compact = false }: { card: BlurbCard; compact?: boolean }) {
  const p = usePalette();
  const a = useCardActions(card);
  // The label needs room (a phone's bar keeps the icon and the source name): about a 480 px card, i.e. a 520 px window.
  const labelled = !compact && showFollowLabel(useWindowDimensions().width - 40);
  const on = (kind: 'like' | 'dislike') => a.reaction === kind;
  const button = (label: string, active: boolean, Icon: typeof ThumbUpIcon, press: () => void, text?: string) => (
    <Pressable key={label} onPress={press} accessibilityRole="button" accessibilityLabel={label} {...tip(label)}
      accessibilityState={{ selected: active }} aria-pressed={active}
      style={({ pressed }) => [styles.button, text ? styles.withText : null, compact && styles.compact, { backgroundColor: active ? p.accentSoft : 'transparent', opacity: pressed ? 0.7 : 1 }]}>
      <Icon color={active ? p.accent : p.ink} size={20} />
      {text ? <Text style={[styles.text, { color: active ? p.accentInk : p.ink }]}>{text}</Text> : null}
    </Pressable>
  );
  return <View style={styles.row}>
    {button('Like this story', on('like'), ThumbUpIcon, () => a.react('like'))}
    {button('Dislike this story', on('dislike'), ThumbDownIcon, () => a.react('dislike'))}
    {button('Follow this story', a.following, PulseIcon, a.toggleFollow, labelled ? followStoryLabel(a.following) : undefined)}
    {button('Share this story', false, ShareIcon, () => { void a.share(); })}
  </View>;
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 2 }, button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }, compact: { width: 44, height: 44 }, withText: { width: 'auto', flexDirection: 'row', gap: 6, paddingHorizontal: 12 }, text: { fontFamily: fonts.sansSemi, fontSize: 14 } });
