// Me / Account (designs: docs/design/mobile/Mobile-Me, docs/design/web/Web-Me).
// A profile card, the topics you follow or hide, the sources you switch on, and
// a settings list (change email, change password, Numbers, About, sign out,
// delete my data, delete my account). Forms open inline under their row.
// Confirms are in-page because browser dialogs don't exist on native.

import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SOURCES } from '../lib/sourcesInfo';
import { SOURCE_KEYS, toggleSource } from '../lib/sourceKeys';
import { router } from 'expo-router';
import type { Category } from '../contract/types.ts';
import { useAccount } from '../lib/accountContext';
import { useAppData } from '../lib/appData';
import { categoryName } from '../lib/format';
import { disclaimerText } from '../lib/labels';
import { DELETE_CONFIRM_WORD, deleteConfirmed, validateEmail, validateNewPassword } from '../lib/session';
import { usePalette, useWide } from '../lib/useTheme';
import { userMessage } from '../lib/errors';
import { fonts, font, radius } from '../lib/theme';
import { PasswordField, fieldStyles } from '../components/PasswordField';
import { OutlineButton, PrimaryButton, ListRow, SectionLabel } from '../components/FormParts';
import { AccountPrompt, DeviceData, QuickLinks } from '../components/AccountEntry';
import { ScreenShell } from '../components/ScreenShell';
import { TopicStatePicker } from '../components/TopicStatePicker';
import { FollowingWatchlist } from '../components/FollowingWatchlist';
import { useFollows } from '../lib/useFollows';

type Section = 'email' | 'password' | 'topics' | 'sources' | 'data' | 'account' | 'session';
type Msg = { text: string; error: boolean };

export default function AccountScreen() {
  const p = usePalette();
  const wide = useWide();
  const { categories: publicCategories, config } = useAppData();
  // Signed in: my_categories also lists favorite or hidden topics that have no cards right now,
  // so a hidden topic can always be un-hidden. Falls back to the public list.
  const [myCategories, setMyCategories] = useState<Category[] | null>(null);
  const categories = myCategories ?? publicCategories;
  const acct = useAccount();
  const { follows, toggleTicker } = useFollows();
  const [topics, setTopics] = useState<{ followed: string[]; hidden: string[] }>({ followed: [], hidden: [] });
  const [busy, setBusy] = useState<Section | null>(null);
  const [msgs, setMsgs] = useState<Partial<Record<Section, Msg>>>({});
  const [open, setOpen] = useState<'email' | 'password' | 'data' | 'delete' | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [hideSignal, setHideSignal] = useState(0);
  const [deleteText, setDeleteText] = useState('');

  // Signed out the page still works: topics, companies and sources are kept on this device.
  const signedIn = acct.user !== null;
  useEffect(() => {
    let alive = true;
    if (acct.user) void acct.account.myCategories().then((c) => alive && c && c.length && setMyCategories(c));
    return () => {
      alive = false;
    };
  }, [acct.account, acct.user]);
  useEffect(() => {
    if (acct.viewPrefs) setTopics({ followed: acct.viewPrefs.followed, hidden: acct.viewPrefs.hidden });
  }, [acct.viewPrefs]);

  async function run(section: Section, work: () => Promise<string | void>, done: string) {
    setBusy(section);
    setMsgs((m) => ({ ...m, [section]: undefined }));
    try {
      const text = await work();
      setMsgs((m) => ({ ...m, [section]: { text: text || done, error: false } }));
    } catch (e) {
      setMsgs((m) => ({ ...m, [section]: { text: userMessage(e), error: true } }));
    } finally {
      setBusy(null);
    }
  }

  function fail(section: Section, text: string) {
    setMsgs((m) => ({ ...m, [section]: { text, error: true } }));
  }

  function changePassword() {
    const problem = validateNewPassword(newPassword, confirmPassword);
    if (problem) return fail('password', problem);
    const pw = newPassword;
    setNewPassword('');
    setConfirmPassword('');
    setHideSignal((n) => n + 1);
    void run('password', () => acct.changePassword(pw), 'Password changed.');
  }

  function changeEmail() {
    const problem = validateEmail(newEmail);
    if (problem) return fail('email', problem);
    void run(
      'email',
      async () => {
        const r = await acct.changeEmail(newEmail);
        setOpen(null);
        setNewEmail('');
        return r === 'changed' ? 'Email changed.' : 'Check both inboxes: confirm the change from the link we sent.';
      },
      'Email changed.',
    );
  }

  const card = [styles.card, { backgroundColor: p.surface, borderColor: p.border }];
  const input = [fieldStyles.input, { borderColor: p.borderStrong, backgroundColor: p.surface, color: p.ink }];
  const saved = acct.viewPrefs?.followed ?? [];
  const hiddenSources = acct.viewPrefs?.hiddenSources ?? null; // null: server doesn't support it yet
  const key = (l: string[]) => l.slice().sort().join();
  const topicsChanged = key(saved) !== key(topics.followed) || key(acct.viewPrefs?.hidden ?? []) !== key(topics.hidden);
  const message = (s: Section) => {
    const m = msgs[s];
    return m ? (
      <Text
        style={[styles.help, { color: m.error ? p.up : p.accentInk }]}
        accessibilityRole={m.error ? 'alert' : undefined}
        accessibilityLiveRegion="polite"
      >
        {m.text}
      </Text>
    ) : null;
  };
  // A row's panel: its form (when open) and its status message (always).
  const panel = (section: Section, form: ReactNode) => {
    const m = message(section);
    return form || m ? (
      <>
        {form}
        {m}
      </>
    ) : undefined;
  };
  const toggle = (which: NonNullable<typeof open>) => () => setOpen((o) => (o === which ? null : which));
  const email = acct.user?.email ?? '';

  const profile = !signedIn ? (
    <AccountPrompt />
  ) : (
    <View style={[card, styles.profile]}>
      <View style={[styles.avatar, { backgroundColor: p.accentSoft }]} accessible={false}>
        <Text style={[styles.avatarText, { color: p.accentInk }]}>{(email[0] ?? 'E').toUpperCase()}</Text>
      </View>
      <View style={styles.profileText}>
        <Text style={[styles.label, { color: p.muted }]}>Signed in as</Text>
        <Text style={[styles.value, { color: p.ink }]} numberOfLines={1}>
          {email}
        </Text>
      </View>
    </View>
  );

  const topicsSection = (
    <View style={styles.section}>
      <Text style={[styles.help, { color: p.inkSoft }]}>
        {saved.length
          ? `Your favorites (${saved.map((s) => categoryName(s, categories)).join(', ')}) come first in “For you”. Pick the topics you want first, hide the ones you never want to see, then save.`
          : 'Mark topics as favorite to put them first in your “For you” feed, or hide the ones you never want to see.'}
      </Text>
      <TopicStatePicker categories={categories} value={topics} onChange={setTopics} />
      {topicsChanged ? (
        <PrimaryButton
          label={busy === 'topics' ? 'Saving…' : 'Save topics'}
          onPress={() => void run('topics', () => acct.savePrefs(topics.followed, topics.hidden), 'Topics saved.')}
        />
      ) : null}
      {message('topics')}
    </View>
  );

  const watchlistSection = <FollowingWatchlist tickers={follows.tickers} onToggle={toggleTicker} />;

  const sourcesSection =
    hiddenSources !== null ? (
      <View style={styles.section}>
        <SectionLabel>Sources</SectionLabel>
        <Text style={[styles.help, { color: p.inkSoft }]}>
          Choose which sources you see cards from. Changes apply to every feed right away. At least one source stays on.
        </Text>
        <View style={card}>
          {SOURCE_KEYS.map((s, i) => {
            const on = !hiddenSources.includes(s.key);
            const info = SOURCES.find((x) => x.key === s.key);
            return (
              <View key={s.key} style={[styles.sourceRow, i > 0 && { borderTopWidth: 1, borderTopColor: p.divider }]}>
                <View style={styles.sourceText}>
                  <Text style={[styles.sourceName, { color: on ? p.ink : p.muted }]}>{s.name}</Text>
                  {info ? <Text style={[styles.small, { color: p.muted }]}>{info.gives}</Text> : null}
                  <Text
                    style={[styles.aboutLink, { color: p.accentInk }]}
                    onPress={() => router.navigate('/about' as never)}
                    accessibilityRole="link"
                  >
                    About this source
                  </Text>
                </View>
                <Switch
                  value={on}
                  onValueChange={() => {
                    const next = toggleSource(hiddenSources, s.key);
                    if (!next) return fail('sources', 'Keep at least one source on.');
                    void run('sources', () => acct.saveSources(next), on ? `${s.name} turned off.` : `${s.name} turned on.`);
                  }}
                  disabled={busy === 'sources'}
                  trackColor={{ false: p.borderStrong, true: p.accent }}
                  accessibilityLabel={`${s.name}: ${on ? 'on' : 'off'}`}
                />
              </View>
            );
          })}
        </View>
        {message('sources')}
      </View>
    ) : null;

  // Guests: no account settings, just the links (Numbers, About, quick tour). Signing in is the card at the top.
  const settings = !signedIn ? (
    <QuickLinks about />
  ) : (
    <View style={[card, styles.settings]} accessibilityLabel="Settings">
      <ListRow first wide={wide} label="Change email" onPress={toggle('email')}>
        {panel(
          'email',
          open === 'email' ? (
            <View style={styles.form}>
              <Text style={[fieldStyles.label, { color: p.ink }]}>New email</Text>
              <TextInput
                style={input}
                value={newEmail}
                onChangeText={setNewEmail}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                inputMode="email"
                keyboardType="email-address"
                placeholder="new@example.com"
                placeholderTextColor={p.muted}
                accessibilityLabel="New email"
                onSubmitEditing={changeEmail}
              />
              <PrimaryButton label={busy === 'email' ? 'Saving…' : 'Save new email'} onPress={changeEmail} />
              <OutlineButton label="Cancel" onPress={() => setOpen(null)} />
            </View>
          ) : null,
        )}
      </ListRow>
      <ListRow wide={wide} label="Change password" onPress={toggle('password')}>
        {panel(
          'password',
          open === 'password' ? (
            <View style={styles.form}>
              <Text style={[styles.help, { color: p.muted }]}>
                Your password is stored only as a one-way hash by our sign-in service; nobody, including us, can read it.
              </Text>
              <PasswordField
                label="New password"
                value={newPassword}
                onChangeText={setNewPassword}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                hideSignal={hideSignal}
              />
              <PasswordField
                label="Confirm new password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                autoComplete="new-password"
                onSubmitEditing={changePassword}
                hideSignal={hideSignal}
              />
              <PrimaryButton label={busy === 'password' ? 'Saving…' : 'Change password'} onPress={changePassword} />
              <OutlineButton label="Cancel" onPress={() => setOpen(null)} />
            </View>
          ) : null,
        )}
      </ListRow>
      <ListRow wide={wide} chevron label="Numbers to know" onPress={() => router.navigate('/numbers' as never)} />
      <ListRow wide={wide} chevron label="About Element" onPress={() => router.navigate('/about' as never)} />
      <ListRow wide={wide} chevron label="Replay the quick tour" onPress={() => router.navigate('/tutorial' as never)} />
      <ListRow wide={wide} label="Sign out" onPress={() => void run('session', () => acct.signOut(), 'Signed out.')}>
        {panel('session', null)}
      </ListRow>
      <ListRow wide={wide} tone="warn" label="Delete my data" onPress={toggle('data')}>
        {panel(
          'data',
          open === 'data' ? (
            <View style={styles.form}>
              <Text style={[styles.help, { color: p.muted }]}>
                We keep your topics and what you liked, viewed or opened, only to tailor your feed. Deleting it keeps your login; to remove that too,
                delete your account.
              </Text>
              <Text style={[styles.help, { color: p.ink }]}>Delete your topics and history? This can’t be undone.</Text>
              <PrimaryButton danger
                label="Yes, delete my data"
                onPress={() =>
                  void run(
                    'data',
                    async () => {
                      await acct.deleteMyData();
                      setOpen(null);
                    },
                    'Your data was deleted.',
                  )
                }
              />
              <OutlineButton label="Cancel" onPress={() => setOpen(null)} />
            </View>
          ) : null,
        )}
      </ListRow>
      <ListRow wide={wide} tone="warn" label="Delete my account" onPress={toggle('delete')}>
        {panel(
          'account',
          open === 'delete' ? (
            <View style={styles.form}>
              <Text style={[styles.help, { color: p.muted }]}>
                Removes your login, your topics and your history for good, and signs you out. To confirm, type {DELETE_CONFIRM_WORD} below.
              </Text>
              <TextInput
                style={input}
                value={deleteText}
                onChangeText={setDeleteText}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                placeholder={DELETE_CONFIRM_WORD}
                placeholderTextColor={p.muted}
                accessibilityLabel={`Type ${DELETE_CONFIRM_WORD} to confirm`}
              />
              <PrimaryButton danger
                label={busy === 'account' ? 'Deleting…' : 'Delete my account'}
                disabled={!deleteConfirmed(deleteText) || busy === 'account'}
                onPress={() => void run('account', () => acct.deleteAccount(), 'Your account was deleted.')}
              />
            </View>
          ) : null,
        )}
      </ListRow>
    </View>
  );

  return (
    <ScreenShell tab="me" title={wide ? 'Me' : 'Account'}>
      {profile}
      {wide ? (
        <View style={styles.cols}>
          <View style={styles.colMain}>
            {topicsSection}
            {watchlistSection}
            {sourcesSection}
          </View>
          <View style={styles.colSide}>
            {settings}
            <DeviceData />
          </View>
        </View>
      ) : (
        <>
          {topicsSection}
          {watchlistSection}
          {sourcesSection}
          {settings}
          <DeviceData />
        </>
      )}
      <Text style={[styles.disclaimer, { color: p.muted }]}>{disclaimerText(config)}</Text>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.tile },
  guest: { gap: 10, paddingVertical: 16, paddingHorizontal: 18 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, paddingHorizontal: 18 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.serif, fontSize: 22 },
  profileText: { flex: 1, minWidth: 0, gap: 2 },
  label: { fontFamily: fonts.sans, fontSize: font.meta },
  value: { fontFamily: fonts.sansSemi, fontSize: font.body },
  section: { gap: 10 },
  cols: { flexDirection: 'row', flexWrap: 'wrap', gap: 28, alignItems: 'flex-start' },
  colMain: { flexGrow: 1, flexShrink: 1, flexBasis: 380, minWidth: 0, gap: 28 },
  colSide: { flexGrow: 1, flexShrink: 1, flexBasis: 340, minWidth: 0, gap: 28 },
  settings: { overflow: 'hidden' },
  form: { gap: 10 },
  help: { fontFamily: fonts.sans, fontSize: font.chip, lineHeight: 21 },
  small: { fontFamily: fonts.sans, fontSize: font.meta, lineHeight: 18 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 18 },
  sourceText: { flex: 1, gap: 2 },
  sourceName: { fontFamily: fonts.sansSemi, fontSize: font.body },
  aboutLink: { fontFamily: fonts.sansSemi, fontSize: font.meta, textDecorationLine: 'underline', paddingVertical: 10 },
  disclaimer: { fontFamily: fonts.sans, fontSize: font.small },
});
