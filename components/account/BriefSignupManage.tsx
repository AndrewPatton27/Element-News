// "Change your time" card: opened from the link in every brief email (brief?manage=<token>).
// The token in the link is the only credential, so there is no login. The reader picks which
// brief and what time, or unsubscribes. We do not read the current settings back (that would
// need another public call), so the card says so and starts from the defaults.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Api } from '../../lib/api/api.ts';
import type { BriefKind } from '../../contract/types.ts';
import { DEFAULT_SEND_HOUR, detectTimezone, hourLabel, runMail, type MailOutcome } from '../../lib/brief/briefLogic';
import { usePalette } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { HourPicker, KindPicker } from './BriefSignupFields';
import { OutlineButton, PrimaryButton } from './FormParts';

type Done = { kind: 'saved'; text: string } | { kind: 'unsubscribed' } | { kind: 'error'; text: string } | null;

function failText(o: MailOutcome): string {
  return o === 'unavailable' ? 'Email briefs are not available right now. Nothing was changed. Please try again later.' : 'That link is no longer valid. Use the link in your most recent brief email.';
}

export function BriefManage({ api, token, wide, onClose }: { api: Api; token: string; wide: boolean; onClose: () => void }) {
  const p = usePalette();
  const tz = useMemo(() => detectTimezone(), []);
  const [kind, setKind] = useState<BriefKind>('daily');
  const [hour, setHour] = useState(DEFAULT_SEND_HOUR);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    const o = await runMail(() => api.updateBriefSubscription(token, { kind, hour, tz }));
    setBusy(false);
    setDone(o === 'done' ? { kind: 'saved', text: `Saved. Your ${kind === 'both' ? 'daily and weekly briefs' : `${kind} brief`} will arrive around ${hourLabel(hour)} (${tz.replace(/_/g, ' ')}).` } : { kind: 'error', text: failText(o) });
  }

  async function unsubscribe() {
    if (busy) return;
    setBusy(true);
    const o = await runMail(() => api.unsubscribeBrief(token));
    setBusy(false);
    setDone(o === 'done' ? { kind: 'unsubscribed' } : { kind: 'error', text: failText(o) });
  }

  return (
    <View accessibilityLabel="Manage your email brief" style={[styles.card, wide && styles.cardWide, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.ink }]}>
        Change your email brief
      </Text>
      {done?.kind === 'unsubscribed' ? (
        <Text accessibilityLiveRegion="polite" style={[styles.msg, { color: p.accentInk }]}>
          You are unsubscribed. No more emails will be sent. You can sign up again any time on this page.
        </Text>
      ) : (
        <>
          <Text style={[styles.hint, { color: p.muted }]}>Pick what you want and when. We do not show your current choice here, so just set it again.</Text>
          <KindPicker value={kind} onChange={setKind} />
          <HourPicker hour={hour} tz={tz} onChange={setHour} />
          {done ? (
            <Text accessibilityRole={done.kind === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[styles.msg, { color: done.kind === 'error' ? p.bad : p.accentInk }]}>
              {done.text}
            </Text>
          ) : null}
          <PrimaryButton label={busy ? 'Saving…' : 'Save changes'} onPress={save} disabled={busy} />
          <OutlineButton label="Unsubscribe" onPress={unsubscribe} color={p.warn} />
        </>
      )}
      <Pressable onPress={onClose} accessibilityRole="button" style={styles.close}>
        <Text style={[styles.closeText, { color: p.accent }]}>{done?.kind === 'unsubscribed' ? 'Sign up again' : 'Close'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  cardWide: { borderRadius: 20, padding: 22, maxWidth: 520 },
  title: { fontFamily: fonts.serif, fontSize: 22, lineHeight: 26 },
  hint: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  msg: { fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 20 },
  close: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  closeText: { fontFamily: fonts.sansSemi, fontSize: 14 },
});
