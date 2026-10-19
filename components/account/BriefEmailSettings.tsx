// "Brief by email" on the Me screen, for signed-in readers: their daily and weekly email
// subscriptions with a plain-words Unsubscribe (asks first) and, when the server supports it,
// a Change time control (the same time picker as the Brief sign-up). If the server does not
// offer the list at all (missing RPC), the whole section is hidden.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Api } from '../../lib/api/api.ts';
import type { MyBriefSubscription } from '../../contract/types.ts';
import { mySubscriptionTitle } from '../../lib/shared/types.ts';
import { detectTimezone, hourLabel } from '../../lib/brief/briefLogic';
import { userMessage } from '../../lib/api/errors';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts, font, radius } from '../../lib/theme/theme';
import { HourPicker } from './BriefSignupFields';
import { OutlineButton, PrimaryButton, SectionLabel } from './FormParts';

type Kind = MyBriefSubscription['kind'];
type Msg = { text: string; error: boolean };

export function BriefEmailSettings({ api }: { api: Api }) {
  const p = usePalette();
  const [subs, setSubs] = useState<MyBriefSubscription[] | null>(null); // null: loading or not offered
  const [asking, setAsking] = useState<Kind | null>(null); // which one is waiting for "are you sure"
  const [editing, setEditing] = useState<Kind | null>(null);
  const [timeOffered, setTimeOffered] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  useEffect(() => {
    let alive = true;
    api.mySubscriptions().then(
      (s) => alive && setSubs(s),
      () => alive && setSubs(null),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  if (subs === null) return null;

  async function unsubscribe(kind: Kind) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.unsubscribeMine(kind);
      if (!r.ok) throw new Error('failed');
      setSubs((cur) => (cur ?? []).filter((s) => s.kind !== kind));
      setAsking(null);
      setMsg({ text: `You’re unsubscribed from the ${kind} brief. You can sign up again any time.`, error: false });
    } catch (e) {
      setMsg({ text: e instanceof Error && e.message !== 'failed' ? userMessage(e) : 'We couldn’t unsubscribe you just now. Please try again.', error: true });
    } finally {
      setBusy(false);
    }
  }

  async function changeTime(kind: Kind, hour: number) {
    const tz = detectTimezone();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.updateMyTime(kind, hour, tz);
      if (r.status === 'unavailable') {
        setTimeOffered(false);
        setEditing(null);
        setMsg({ text: 'Changing the time isn’t available yet. You can unsubscribe and sign up again with a new time.', error: true });
        return;
      }
      if (!r.ok) throw new Error('failed');
      setSubs((cur) => (cur ?? []).map((s) => (s.kind === kind ? { ...s, hour, tz } : s)));
      setEditing(null);
      setMsg({ text: `The ${kind} brief will now arrive around ${hourLabel(hour)}.`, error: false });
    } catch {
      setMsg({ text: 'We couldn’t change the time just now. Please try again.', error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.section} accessibilityLabel="Brief by email">
      <SectionLabel>Brief by email</SectionLabel>
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
        {subs.length === 0 ? (
          <View style={styles.row}>
            <Text style={[styles.help, { color: p.inkSoft }]}>You’re not getting the brief by email.</Text>
            <Text
              style={[styles.link, { color: p.accentInk }]}
              onPress={() => router.navigate('/brief' as never)}
              accessibilityRole="link"
              accessibilityLabel="Sign up for the brief by email"
            >
              Sign up for the brief by email
            </Text>
          </View>
        ) : (
          subs.map((s, i) => {
            const title = mySubscriptionTitle(s.kind);
            const when = s.hour === null ? null : `${hourLabel(s.hour)}${s.tz ? `, ${s.tz.replace(/_/g, ' ')}` : ''}`;
            return (
              <View key={s.kind} style={[styles.row, i > 0 && { borderTopWidth: 1, borderTopColor: p.divider }]}>
                <Text style={[styles.title, { color: p.ink }]}>{title}</Text>
                <Text style={[styles.help, { color: p.inkSoft }]}>
                  {s.confirmed ? 'Confirmed' : 'Waiting for you to confirm: check your inbox for our email.'}
                  {when ? ` · Sent around ${when}` : ''}
                </Text>
                {editing === s.kind ? (
                  <View style={styles.form}>
                    <HourPicker hour={s.hour ?? 7} tz={detectTimezone()} onChange={(h) => void changeTime(s.kind, h)} />
                    <OutlineButton label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                ) : null}
                {asking === s.kind ? (
                  <View style={styles.form}>
                    <Text style={[styles.help, { color: p.ink }]}>Stop the {s.kind} brief emails? You can sign up again any time.</Text>
                    <PrimaryButton danger label={busy ? 'Working…' : 'Yes, unsubscribe'} disabled={busy} onPress={() => void unsubscribe(s.kind)} />
                    <OutlineButton label="Keep it" onPress={() => setAsking(null)} />
                  </View>
                ) : (
                  <View style={styles.actions}>
                    {timeOffered && s.confirmed && editing !== s.kind ? (
                      <View style={styles.action}>
                        <OutlineButton label="Change time" onPress={() => { setMsg(null); setEditing(s.kind); }} />
                      </View>
                    ) : null}
                    <View style={styles.action}>
                      <OutlineButton
                        label="Unsubscribe"
                        color={p.warn}
                        onPress={() => {
                          setMsg(null);
                          setEditing(null);
                          setAsking(s.kind);
                        }}
                      />
                    </View>
                  </View>
                )}
              </View>
            );
          })
        )}
      </View>
      {msg ? (
        <Text
          style={[styles.help, { color: msg.error ? p.up : p.accentInk }]}
          accessibilityRole={msg.error ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
        >
          {msg.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  card: { borderWidth: 1, borderRadius: radius.tile, overflow: 'hidden' },
  row: { gap: 8, paddingVertical: 14, paddingHorizontal: 18 },
  title: { fontFamily: fonts.sansSemi, fontSize: font.body },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
  link: { fontFamily: fonts.sansSemi, fontSize: font.chip, textDecorationLine: 'underline', paddingVertical: 10 },
  form: { gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { flexGrow: 1, flexBasis: 140 },
});
