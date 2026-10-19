// Signed-in state for the whole app: who is signed in, their saved topics, their
// like/dislike per card, and event tracking (view, open_source, like, dislike).
// Works the same over the mock account (sample mode) and Supabase.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BlurbCard } from '../../contract/types.ts';
import type { AccountApi, EmailChangeResult, SignUpResult } from './account.ts';
import { EMPTY_PREFS, ViewTracker, feedbackEvent, sameUser, unseenReactions, withTopicState, type Feedback, type UserPrefs } from './accountLogic.ts';
import type { AuthUser, RecoveryLink } from './session.ts';
import { setOpenSourceListener } from '../shared/openUrl.ts';
import { defaultStore, onStoreChange } from '../storage/storage.ts';
import { FOLLOWS_KEY } from '../following/followingLogic.ts';
import {
  LOCAL_PREFS_KEY,
  asUserPrefs,
  hasLocalChoices,
  mergeIntoAccount,
  migratedKey,
  reactionMap,
  readLocal,
  withHiddenSources,
  withReaction,
  withTopics,
  writeLocal,
  type LocalPrefs,
} from '../storage/localPrefs.ts';

export interface AccountState {
  account: AccountApi;
  user: AuthUser | null;
  prefs: UserPrefs | null; // null while loading or signed out
  /** What screens should apply: the account's prefs when signed in, this device's when signed out. */
  viewPrefs: UserPrefs | null;
  /** The signed-out reader's choices on this device (also used by the local For you ranking). */
  localPrefs: LocalPrefs;
  onboardingSkipped: boolean;
  reactions: Record<string, Feedback>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<SignUpResult>;
  signOut(): Promise<void>;
  savePrefs(followed: string[], hidden?: string[]): Promise<void>;
  /** Hide one topic right away (optimistic); resolves with the topics to restore for Undo. */
  hideTopic(slug: string): Promise<{ followed: string[]; hidden: string[] }>;
  restoreTopics(previous: { followed: string[]; hidden: string[] }): Promise<void>;
  /** Saves the switched-off sources (only when the server supports them). */
  saveSources(hiddenSources: string[]): Promise<void>;
  /** Switch one source off right away; resolves with the list to restore for Undo. */
  hideSource(key: string): Promise<string[]>;
  skipOnboarding(): void;
  react(card: BlurbCard, pressed: Feedback): void;
  noteCards(cards: BlurbCard[]): void; // pick up my_reaction from For you cards
  trackView(card: BlurbCard): void;
  trackDwell(cardId: string, ms: number): void;
  trackDwellOnExit(cardId: string, ms: number): void;
  trackOpenDetail(card: BlurbCard): void;
  deleteMyData(): Promise<void>;
  refreshPrefs(): Promise<UserPrefs | null>;
  /** "Please sign in again." after an expired session; cleared by clearNotice. */
  notice: string | null;
  clearNotice(): void;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  completePasswordRecovery(link: Extract<RecoveryLink, { ok: true }>, newPassword: string): Promise<void>;
  changePassword(newPassword: string): Promise<void>;
  changeEmail(newEmail: string): Promise<EmailChangeResult>;
  deleteAccount(): Promise<void>;
}

const Ctx = createContext<AccountState | null>(null);
const store = defaultStore();
const skipKey = (uid: string) => `element.onboarding-skipped.${uid}`;

// "Skip for now" on the topic picker, remembered per user on this device.
export function isOnboardingSkipped(uid: string | null | undefined): boolean {
  return uid ? store.get(skipKey(uid)) === '1' : false;
}

export function AccountProvider({ account, children }: { account: AccountApi; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(account.currentUser());
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [reactions, setReactions] = useState<Record<string, Feedback>>({});
  const [skipped, setSkipped] = useState(false);
  const views = useRef(new ViewTracker());
  const noted = useRef(new Set<string>()); // cards whose my_reaction was already applied
  const [notice, setNotice] = useState<string | null>(null);
  const uid = user?.id ?? null;
  // Signed-out choices live on this device; re-read when any screen writes them.
  const [local, setLocal] = useState<LocalPrefs>(() => readLocal(store));
  useEffect(
    () =>
      onStoreChange((k) => {
        if (k === LOCAL_PREFS_KEY || k === FOLLOWS_KEY) setLocal(readLocal(store));
      }),
    [],
  );
  const saveLocal = useCallback((next: LocalPrefs) => {
    writeLocal(store, next); // the listener above updates `local`
    setLocal(next);
  }, []);
  const guestPrefs = useMemo(() => asUserPrefs(local), [local]);
  const guestReactions = useMemo(() => reactionMap(local), [local]);

  // Signing in: merge this device's choices into the account once per user (best effort;
  // the merge is a union, so running it twice changes nothing).
  const migrating = useRef<string | null>(null);
  useEffect(() => {
    if (!uid || !prefs || migrating.current === uid || store.get(migratedKey(uid)) === '1') return;
    const snapshot = readLocal(store);
    if (!hasLocalChoices(snapshot)) return;
    migrating.current = uid;
    const plan = mergeIntoAccount(prefs, snapshot, reactions);
    void (async () => {
      try {
        if (plan.prefs) setPrefs(await account.setPrefs(plan.prefs.followed, plan.prefs.hidden, plan.prefs.hiddenSources));
        for (const r of plan.reactions) {
          await account.track(r.cardId, r.event);
          setReactions((m) => (m[r.cardId] ? m : { ...m, [r.cardId]: r.event }));
        }
        store.set(migratedKey(uid), '1');
      } catch {
        migrating.current = null; // try again next time prefs load
      }
    })();
  }, [uid, prefs, reactions, account]);

  // Track the signed-in user; when the account signs us out by itself (expired
  // session), keep its reason to show "Please sign in again."
  useEffect(
    () =>
      account.onChange((u) => {
        // Keep the same object for the same user, so an hourly token refresh doesn't
        // reset prefs, likes and view tracking (B4).
        setUser((prev) => (sameUser(prev, u) ? prev : u));
        if (!u) {
          const reason = account.takeSignOutReason();
          if (reason) setNotice(reason);
        }
      }),
    [account],
  );

  const refreshPrefs = useCallback(async () => {
    if (!account.currentUser()) return null;
    try {
      const p = await account.getPrefs();
      setPrefs(p);
      return p;
    } catch {
      return null;
    }
  }, [account]);

  // A different user (or sign-out) starts from a clean slate. Keyed on the id only,
  // so an email change or token refresh keeps the state.
  useEffect(() => {
    setPrefs(null);
    setReactions({});
    views.current.reset();
    noted.current.clear();
    setSkipped(isOnboardingSkipped(uid));
    if (uid) void refreshPrefs();
  }, [uid, refreshPrefs]);

  // Stable identity: For you calls it after every load (B1: it used to re-trigger itself).
  const noteCards = useCallback((cards: BlurbCard[]) => {
    const found = unseenReactions(cards, noted.current);
    if (found) setReactions((r) => ({ ...found, ...r }));
  }, []);

  // Opening an original source counts as interest in that card.
  useEffect(() => {
    if (!uid) {
      setOpenSourceListener(null);
      return;
    }
    setOpenSourceListener((cardId) => void account.track(cardId, 'open_source').catch(() => undefined));
    return () => setOpenSourceListener(null);
  }, [uid, account]);

  const value = useMemo<AccountState>(
    () => ({
      account,
      user,
      prefs,
      viewPrefs: user ? prefs : guestPrefs,
      localPrefs: local,
      onboardingSkipped: skipped,
      reactions: user ? reactions : guestReactions,
      signIn: (email, password) => account.signIn(email, password),
      signUp: (email, password) => account.signUp(email, password),
      signOut: () => account.signOut(),
      async savePrefs(followed, hidden) {
        if (!user) return saveLocal(withTopics(readLocal(store), followed, hidden ?? local.hiddenTopics));
        const p = await account.setPrefs(followed, hidden);
        setPrefs(p);
      },
      async hideTopic(slug) {
        const before = user ? (prefs ?? EMPTY_PREFS) : guestPrefs;
        const previous = { followed: before.followed, hidden: before.hidden };
        const next = withTopicState(before, slug, 'hide');
        if (!user) {
          saveLocal(withTopics(readLocal(store), next.followed, next.hidden));
          return previous;
        }
        setPrefs({ ...before, ...next }); // the topic disappears at once
        try {
          setPrefs(await account.setPrefs(next.followed, next.hidden));
        } catch (e) {
          setPrefs(before);
          throw e;
        }
        return previous;
      },
      async restoreTopics(previous) {
        if (!user) return saveLocal(withTopics(readLocal(store), previous.followed, previous.hidden));
        setPrefs(await account.setPrefs(previous.followed, previous.hidden));
      },
      async saveSources(hiddenSources) {
        if (!user) return saveLocal(withHiddenSources(readLocal(store), hiddenSources));
        const before = prefs ?? EMPTY_PREFS;
        setPrefs(await account.setPrefs(before.followed, before.hidden, hiddenSources));
      },
      async hideSource(key) {
        if (!user) {
          const previous = local.hiddenSources;
          saveLocal(withHiddenSources(readLocal(store), previous.includes(key) ? previous : [...previous, key]));
          return previous;
        }
        const before = prefs ?? EMPTY_PREFS;
        const previous = before.hiddenSources ?? [];
        const next = previous.includes(key) ? previous : [...previous, key];
        setPrefs({ ...before, hiddenSources: next }); // the cards disappear at once
        try {
          setPrefs(await account.setPrefs(before.followed, before.hidden, next));
        } catch (e) {
          setPrefs(before);
          throw e;
        }
        return previous;
      },
      skipOnboarding() {
        if (user) store.set(skipKey(user.id), '1');
        setSkipped(true);
      },
      react(card, pressed) {
        if (!user) {
          // Signed out: kept on this device only; nothing is sent.
          saveLocal(withReaction(readLocal(store), card, pressed));
          return;
        }
        const current = reactions[card.id];
        const event = feedbackEvent(current, pressed);
        // Optimistic: the button flips at once; a failed call puts it back.
        setReactions((r) => {
          const next = { ...r };
          if (event === 'clear') delete next[card.id];
          else next[card.id] = pressed;
          return next;
        });
        account.track(card.id, event).catch(() =>
          setReactions((r) => {
            const next = { ...r };
            if (current) next[card.id] = current;
            else delete next[card.id];
            return next;
          }),
        );
      },
      noteCards,
      trackView(card) {
        if (!user || !views.current.shouldTrack(card.id)) return;
        account.track(card.id, 'view').catch(() => undefined);
      },
      // Fire and forget: tracking never blocks or breaks the UI.
      trackDwell(cardId, ms) {
        if (user) account.track(cardId, 'dwell', ms).catch(() => undefined);
      },
      // Page is closing: keepalive send (see AccountApi.trackDwellOnExit).
      trackDwellOnExit(cardId, ms) {
        if (user) account.trackDwellOnExit(cardId, ms);
      },
      trackOpenDetail(card) {
        if (user) account.track(card.id, 'open_detail').catch(() => undefined);
      },
      async deleteMyData() {
        await account.deleteMyData();
        setReactions({});
        views.current.reset();
        noted.current.clear();
        await refreshPrefs();
      },
      refreshPrefs,
      notice,
      clearNotice: () => setNotice(null),
      requestPasswordReset: (email, redirectTo) => account.requestPasswordReset(email, redirectTo),
      async completePasswordRecovery(link, newPassword) {
        await account.completePasswordRecovery(link, newPassword);
        setNotice(null);
      },
      changePassword: (newPassword) => account.changePassword(newPassword),
      async changeEmail(newEmail) {
        const r = await account.changeEmail(newEmail);
        const next = account.currentUser();
        setUser((prev) => (sameUser(prev, next) ? prev : next));
        return r;
      },
      async deleteAccount() {
        await account.deleteAccount();
        setReactions({});
        views.current.reset();
        setNotice('Your account was deleted.');
      },
    }),
    [account, user, prefs, skipped, reactions, refreshPrefs, notice, noteCards, local, guestPrefs, guestReactions, saveLocal],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAccount must be used inside AccountProvider');
  return v;
}
