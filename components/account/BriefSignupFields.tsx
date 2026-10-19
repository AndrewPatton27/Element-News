// Form pieces shared by the email sign-up card and the manage card: the Daily / Weekly / Both
// choice (a radio group) and the send-time picker (a button that opens a short list, 5 AM to
// 10 PM, in the reader's own time zone, which is shown). All of it works with a keyboard:
// every option is a focusable button, Enter / Space picks it.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BriefKind } from '../../contract/types.ts';
import { BRIEF_KIND_OPTIONS, SEND_HOURS, hourLabel } from '../../lib/brief/briefLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';

export function KindPicker({ value, onChange }: { value: BriefKind; onChange: (k: BriefKind) => void }) {
  const p = usePalette();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Which brief" style={styles.kinds}>
      {BRIEF_KIND_OPTIONS.map((o) => {
        const on = o.kind === value;
        return (
          <Pressable
            key={o.kind}
            onPress={() => onChange(o.kind)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${o.label}: ${o.hint}`}
            aria-checked={on}
            style={({ pressed }) => [
              styles.kind,
              { backgroundColor: on ? p.accentSoft : p.surface, borderColor: on ? p.accent : p.borderStrong, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={[styles.kindText, { color: on ? p.accentInk : p.ink }]}>{o.label}</Text>
            <Text style={[styles.kindHint, { color: on ? p.accentInk : p.muted }]}>{o.hint}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function HourPicker({ hour, tz, onChange }: { hour: number; tz: string; onChange: (h: number) => void }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.hour}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`Send time: ${hourLabel(hour)}, ${tz}. ${open ? 'Close the list' : 'Change the time'}`}
        aria-expanded={open}
        style={({ pressed }) => [styles.hourBtn, { backgroundColor: p.surface, borderColor: p.borderStrong, opacity: pressed ? 0.8 : 1 }]}
      >
        <Text style={[styles.hourValue, { color: p.ink }]}>{hourLabel(hour)}</Text>
        <Text style={[styles.hourCaret, { color: p.muted }]}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      <Text style={[styles.tz, { color: p.muted }]}>Your time zone: {tz.replace(/_/g, ' ')}</Text>
      {open ? (
        <ScrollView
          accessibilityRole="radiogroup"
          accessibilityLabel="Send time"
          style={[styles.list, { backgroundColor: p.surface, borderColor: p.border }]}
          nestedScrollEnabled
        >
          {SEND_HOURS.map((h) => {
            const on = h === hour;
            return (
              <Pressable
                key={h}
                onPress={() => {
                  onChange(h);
                  setOpen(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                aria-checked={on}
                accessibilityLabel={hourLabel(h)}
                style={({ pressed }) => [styles.item, { backgroundColor: on ? p.accentSoft : 'transparent', opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.itemText, { color: on ? p.accentInk : p.ink, fontFamily: on ? fonts.sansSemi : fonts.sans }]}>{hourLabel(h)}</Text>
                {on ? <Text style={{ color: p.accentInk }}>✓</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kinds: { flexDirection: 'row', gap: 8 },
  kind: { flex: 1, minHeight: 56, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 6 },
  kindText: { fontFamily: fonts.sansSemi, fontSize: 15 },
  kindHint: { fontFamily: fonts.sans, fontSize: 12 },
  hour: { gap: 6 },
  hourBtn: { minHeight: 52, borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hourValue: { fontFamily: fonts.sansSemi, fontSize: 16 },
  hourCaret: { fontSize: 14 },
  tz: { fontFamily: fonts.sans, fontSize: 12 },
  list: { maxHeight: 232, borderRadius: 14, borderWidth: 1 },
  item: { minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemText: { fontSize: 15 },
});
