// Account → topics. Two groups of chips (design Mobile-Me "Categories you
// follow"): tap a chip to make a topic a Favorite (it comes first in "For you"),
// and, under it, tap a topic to Hide it (you won't see it at all). A topic is
// never both: each tap goes through withTopicState, which clears the other list.
// Chips show a check mark when on, so state is never colour-only.

import { StyleSheet, View } from 'react-native';
import type { Category } from '../contract/types.ts';
import { topicState, withTopicState } from '../lib/accountLogic';
import { SectionLabel } from './FormParts';
import { LoadingState } from './States';
import { TopicChip } from './TopicPicker';

interface Props {
  categories: Category[];
  value: { followed: string[]; hidden: string[] };
  onChange: (next: { followed: string[]; hidden: string[] }) => void;
}

export function TopicStatePicker({ categories, value, onChange }: Props) {
  if (categories.length === 0) return <LoadingState label="Loading topics…" />;
  const canHide = categories.filter((c) => topicState(value, c.slug) !== 'follow');
  return (
    <View style={styles.groups}>
      <View style={styles.group}>
        <SectionLabel>Categories you follow</SectionLabel>
        <View style={styles.wrap} accessibilityRole="list">
          {categories.map((c) => {
            const on = topicState(value, c.slug) === 'follow';
            return (
              <TopicChip
                key={c.slug}
                label={c.name}
                on={on}
                accessibilityLabel={`${c.name}: favorite`}
                onPress={() => onChange(withTopicState(value, c.slug, on ? 'normal' : 'follow'))}
              />
            );
          })}
        </View>
      </View>
      {canHide.length > 0 ? (
        <View style={styles.group}>
          <SectionLabel>Topics to hide</SectionLabel>
          <View style={styles.wrap} accessibilityRole="list">
            {canHide.map((c) => {
              const on = topicState(value, c.slug) === 'hide';
              return (
                <TopicChip
                  key={c.slug}
                  label={c.name}
                  on={on}
                  mark="Hidden: "
                  accessibilityLabel={`Hide ${c.name}`}
                  onPress={() => onChange(withTopicState(value, c.slug, on ? 'normal' : 'hide'))}
                />
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: 20 },
  group: { gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
