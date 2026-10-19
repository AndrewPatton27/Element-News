import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVALID_RESET_LINK_MESSAGE,
  authErrorMessage,
  deleteConfirmed,
  needsRefresh,
  parseRecoveryLink,
  parseSession,
  passwordToggleLabel,
  validateCredentials,
  validateEmail,
  validateNewPassword,
} from '../account/session.ts';
import {
  EMPTY_PREFS,
  ViewTracker,
  forYouCoversTopics,
  sameUser,
  topicState,
  withTopicState,
  withoutHidden,
  unseenReactions,
  feedbackEvent,
  mockForYouOrder,
  needsOnboarding,
  nextFeedback,
  reactionOf,
  toggleTopic,
} from '../account/accountLogic.ts';
import { ACCOUNT_RPC, AccountError, createMockAccount, createSupabaseAccount, parseUserPrefs } from '../account/account.ts';
import { memoryStore } from '../storage/storage.ts';
import { card } from './helpers.ts';

const NOW = 1_800_000_000;
const tokenResponse = (over: object = {}) => ({
  access_token: 'acc-1',
  refresh_token: 'ref-1',
  expires_in: 3600,
  user: { id: 'u1', email: 'a@b.co' },
  ...over,
});

test('parseSession reads GoTrue responses and computes expiry', () => {
  const s = parseSession(tokenResponse(), NOW);
  assert.deepEqual(s, { access_token: 'acc-1', refresh_token: 'ref-1', expires_at: NOW + 3600, user: { id: 'u1', email: 'a@b.co' } });
  assert.equal(parseSession({ user: { id: 'x' } }, NOW), null, 'sign-up waiting for email confirmation has no session');
  assert.equal(parseSession(null, NOW), null);
});

test('needsRefresh refreshes a minute early', () => {
  const s = parseSession(tokenResponse(), NOW)!;
  assert.equal(needsRefresh(s, NOW), false);
  assert.equal(needsRefresh(s, NOW + 3600 - 61), false);
  assert.equal(needsRefresh(s, NOW + 3600 - 60), true);
});

test('credentials and auth error messages', () => {
  assert.match(validateCredentials('nope', 'longenough') ?? '', /valid email/);
  assert.match(validateCredentials('a@b.co', 'short') ?? '', /8 characters/);
  assert.equal(validateCredentials(' a@b.co ', 'longenough'), null);
  assert.equal(authErrorMessage(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), 'Email or password is not right.');
  assert.match(authErrorMessage(422, { msg: 'User already registered' }), /already has an account/);
  assert.match(authErrorMessage(429, {}), /Too many tries/);
  const mailLimit = 'Too many sign-up emails were sent. Try again later, or sign in if you already have an account.';
  assert.equal(authErrorMessage(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }), mailLimit);
  assert.equal(authErrorMessage(429, { msg: 'Email rate limit exceeded' }), mailLimit, 'matched by message too');
  assert.match(authErrorMessage(429, { error_code: 'over_request_rate_limit' }), /Too many tries/, 'other 429s keep the generic text');
  assert.match(authErrorMessage(0, null), /Could not reach/);
});

test('onboarding, topic toggles and feedback rules', () => {
  assert.equal(needsOnboarding(true, EMPTY_PREFS, false), true);
  assert.equal(needsOnboarding(true, { followed: [], hidden: [], hiddenSources: [], onboarded: true }, false), false, 'saved (even with no topics)');
  assert.equal(needsOnboarding(true, EMPTY_PREFS, true), false, 'skipped');
  assert.equal(needsOnboarding(false, EMPTY_PREFS, false), false, 'signed out');
  assert.equal(needsOnboarding(true, null, false), false, 'prefs not loaded yet');
  assert.equal(feedbackEvent(undefined, 'like'), 'like');
  assert.equal(feedbackEvent('like', 'like'), 'clear');
  assert.equal(feedbackEvent('like', 'dislike'), 'dislike');
  assert.equal(reactionOf({ my_reaction: 'like' }), 'like');
  assert.equal(reactionOf({ my_reaction: null }), undefined);
  assert.equal(reactionOf({}), undefined);
  assert.deepEqual(toggleTopic(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleTopic(['a', 'b'], 'a'), ['b']);
  assert.equal(nextFeedback(undefined, 'like'), 'like');
  assert.equal(nextFeedback('like', 'like'), null);
  assert.equal(nextFeedback('like', 'dislike'), 'dislike');
});

test('ViewTracker records each card once', () => {
  const t = new ViewTracker();
  assert.equal(t.shouldTrack('a'), true);
  assert.equal(t.shouldTrack('a'), false);
  assert.equal(t.shouldTrack('b'), true);
  t.reset();
  assert.equal(t.shouldTrack('a'), true);
});

test('mock For you: followed topics first, disliked cards removed', () => {
  const old = card({ id: 'w', category: 'world' as never, sort_at: '2026-10-17T00:00:00Z', importance: 2 }); // 12 h older, inside the 24 h topic boost
  const fresh = card({ id: 'e', category: 'earnings', sort_at: '2026-10-17T12:00:00Z', importance: 2 });
  const gone = card({ id: 'x', category: 'earnings', sort_at: '2026-10-17T13:00:00Z', importance: 2 });
  const order = mockForYouOrder([fresh, old, gone], ['world'], { x: 'dislike' }).map((c) => c.id);
  assert.deepEqual(order, ['w', 'e']);
});

test('parseUserPrefs reads api.get_prefs; RPC arguments match the migration', () => {
  assert.deepEqual(parseUserPrefs({ followed_categories: ['world', 'tech', 'world'], hidden_categories: ['deals'], onboarded: true, affinity: {} }), {
    followed: ['world', 'tech'],
    hidden: ['deals'],
    hiddenSources: null, // older server: no hidden_sources, so the Sources switches stay hidden
    onboarded: true,
  });
  assert.deepEqual(parseUserPrefs({ followed_categories: [], hidden_categories: [], hidden_sources: ['nasa'], onboarded: true }).hiddenSources, [
    'nasa',
  ]);
  assert.deepEqual(ACCOUNT_RPC.setPrefs.args(['world'], ['deals'], ['nasa']), {
    p_followed: ['world'],
    p_hidden: ['deals'],
    p_hidden_sources: ['nasa'],
  });
  assert.deepEqual(parseUserPrefs(null), EMPTY_PREFS);
  assert.deepEqual(ACCOUNT_RPC.setPrefs.args(['world']), { p_followed: ['world'], p_hidden: null });
  assert.deepEqual(ACCOUNT_RPC.track.args('id1', 'clear'), { p_blurb: 'id1', p_kind: 'clear' });
  assert.deepEqual(ACCOUNT_RPC.feedForYou.args(null, 20), { p_cursor: null, p_limit: 20 });
});

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('supabase account: sign in, RPC with bearer token, session persisted, sign out', async () => {
  const store = memoryStore();
  const { fn, calls } = fakeFetch((url) => {
    if (url.includes('/auth/v1/token?grant_type=password')) return { status: 200, body: tokenResponse() };
    if (url.endsWith('/rpc/get_prefs')) return { status: 200, body: { followed_categories: ['world'], hidden_categories: [], onboarded: true } };
    if (url.endsWith('/rpc/feed_for_you')) return { status: 200, body: { items: [card()], next_cursor: null } };
    if (url.includes('/auth/v1/logout')) return { status: 204 };
    return { status: 200, body: null };
  });
  const acct = createSupabaseAccount({ url: 'https://p.supabase.co', key: 'sb_publishable_x', fetchFn: fn, store, now: () => NOW });
  const seen: (string | null)[] = [];
  acct.onChange((u) => seen.push(u ? u.email : null));
  await acct.signIn(' a@b.co ', 'longenough');
  assert.equal(acct.currentUser()?.email, 'a@b.co');
  assert.ok(store.get('element.session.v1'));
  assert.deepEqual((await acct.getPrefs()).followed, ['world']);
  const page = await acct.feedForYou(null, 99);
  assert.equal(page.items.length, 1);
  const rpcCall = calls.find((c) => c.url.endsWith('/rpc/feed_for_you'))!;
  const h = rpcCall.init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer acc-1');
  assert.equal(h['Content-Profile'], 'api');
  assert.equal(JSON.parse(rpcCall.init.body as string).p_limit, 30);
  const signInBody = JSON.parse(calls[0].init.body as string);
  assert.equal(signInBody.email, 'a@b.co');
  // a new instance restores the saved session
  const again = createSupabaseAccount({ url: 'https://p.supabase.co', key: 'k', fetchFn: fn, store, now: () => NOW });
  assert.equal(again.currentUser()?.id, 'u1');
  await acct.signOut();
  assert.equal(acct.currentUser(), null);
  assert.equal(store.get('element.session.v1'), null);
  assert.deepEqual(seen, ['a@b.co', null]);
});

test('supabase account: expired token is refreshed; rejected refresh signs out', async () => {
  const store = memoryStore();
  store.set(
    'element.session.v1',
    JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: NOW - 10, user: { id: 'u1', email: 'a@b.co' } }),
  );
  let refreshOk = true;
  const { fn } = fakeFetch((url) => {
    if (url.includes('grant_type=refresh_token'))
      return refreshOk ? { status: 200, body: tokenResponse({ access_token: 'new' }) } : { status: 400, body: { msg: 'Invalid Refresh Token' } };
    return { status: 200, body: [] };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  assert.equal(await acct.accessToken(), 'new');
  const expired = createSupabaseAccount({
    url: 'https://p',
    key: 'k',
    fetchFn: fn,
    store: (() => {
      const s = memoryStore();
      s.set(
        'element.session.v1',
        JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: NOW - 10, user: { id: 'u1', email: 'a@b.co' } }),
      );
      return s;
    })(),
    now: () => NOW,
  });
  refreshOk = false;
  assert.equal(await expired.accessToken(), null);
  assert.equal(expired.currentUser(), null);
  await assert.rejects(expired.getPrefs(), (e: unknown) => e instanceof AccountError && e.status === 401);
});

test('supabase account: sign-up that needs email confirmation; errors are friendly', async () => {
  const { fn } = fakeFetch((url) => {
    if (url.endsWith('/auth/v1/signup')) return { status: 200, body: { id: 'u2', email: 'c@d.co' } };
    return { status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store: memoryStore(), now: () => NOW });
  assert.deepEqual(await acct.signUp('c@d.co', 'longenough'), { status: 'confirm_email' });
  assert.equal(acct.currentUser(), null);
  await assert.rejects(acct.signIn('c@d.co', 'wrongpass'), /Email or password is not right/);
});

test('mock account: works offline end to end and delete clears data', async () => {
  const cards = [card({ id: 'a', category: 'earnings' }), card({ id: 'b', category: 'tech' })];
  const acct = createMockAccount(() => cards, memoryStore());
  assert.equal(acct.sample, true);
  await assert.rejects(acct.getPrefs(), AccountError);
  await acct.signUp('me@x.co', 'longenough');
  assert.deepEqual(await acct.getPrefs(), EMPTY_PREFS);
  assert.equal((await acct.setPrefs(['tech'])).onboarded, true);
  assert.deepEqual(
    (await acct.feedForYou(null)).items.map((c) => c.id),
    ['b', 'a'],
  );
  await acct.track('a', 'like');
  assert.equal(reactionOf((await acct.feedForYou(null)).items.find((c) => c.id === 'a')!), 'like');
  await acct.track('a', 'clear');
  assert.equal(reactionOf((await acct.feedForYou(null)).items.find((c) => c.id === 'a')!), undefined);
  await acct.track('b', 'dislike');
  assert.deepEqual(
    (await acct.feedForYou(null)).items.map((c) => c.id),
    ['a'],
  );
  await acct.deleteMyData();
  assert.equal(acct.currentUser()?.email, 'me@x.co', 'the login stays; only prefs and events go');
  assert.deepEqual(await acct.getPrefs(), EMPTY_PREFS);
  assert.deepEqual((await acct.feedForYou(null)).items.map((c) => c.id).sort(), ['a', 'b']);
});

test('password toggle says what pressing it will do', () => {
  assert.equal(passwordToggleLabel(false), 'Show password');
  assert.equal(passwordToggleLabel(true), 'Hide password');
});

test('new password rules: length and confirmation', () => {
  assert.match(validateNewPassword('short', 'short') ?? '', /8 characters/);
  assert.match(validateNewPassword('longenough', 'longenougX') ?? '', /don’t match/);
  assert.equal(validateNewPassword('longenough', 'longenough'), null);
  assert.equal(validateEmail(' new@x.co '), null);
  assert.match(validateEmail('nope') ?? '', /valid email/);
});

test('recovery link: tokens from the fragment, errors and junk rejected', () => {
  const ok = parseRecoveryLink('#access_token=abc&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery');
  assert.deepEqual(ok, { ok: true, access_token: 'abc', refresh_token: 'r1', expires_in: 3600 });
  const expired = parseRecoveryLink('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.deepEqual(expired, { ok: false, error: INVALID_RESET_LINK_MESSAGE });
  assert.equal(parseRecoveryLink('', '?error=access_denied&error_code=otp_expired').ok, false, 'error in the query string');
  assert.equal(parseRecoveryLink('#access_token=abc&type=signup').ok, false, 'not a recovery link');
  assert.equal(parseRecoveryLink('').ok, false, 'no fragment at all');
});

test('delete account needs the word DELETE', () => {
  assert.equal(deleteConfirmed('DELETE'), true);
  assert.equal(deleteConfirmed('  DELETE '), true);
  assert.equal(deleteConfirmed('delete'), false);
  assert.equal(deleteConfirmed(''), false);
});

test('account errors for email changes and reused passwords', () => {
  assert.match(authErrorMessage(422, { error_code: 'email_exists' }), /already used/);
  assert.match(authErrorMessage(422, { error_code: 'same_password', msg: 'New password should be different from the old password.' }), /different/);
});

test('password reset request: neutral on unknown emails, friendly on rate limit', async () => {
  const seen: string[] = [];
  let status = 200;
  const { fn } = fakeFetch((url) => {
    seen.push(url);
    return status === 200
      ? { status: 200, body: {} }
      : { status, body: { error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store: memoryStore(), now: () => NOW });
  await acct.requestPasswordReset(' a@b.co ', 'https://element.example/reset-password');
  assert.equal(seen[0], 'https://p/auth/v1/recover?redirect_to=https%3A%2F%2Felement.example%2Freset-password');
  status = 404; // some setups answer "user not found": still treated as sent
  await acct.requestPasswordReset('nobody@b.co', 'https://x/reset-password');
  status = 429;
  await assert.rejects(acct.requestPasswordReset('a@b.co', 'https://x/reset-password'), /Too many reset emails/);
});

test('recovery link sets the new password and signs in', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const { fn } = fakeFetch((url, init) => {
    calls.push({ url, init });
    return { status: 200, body: { id: 'u1', email: 'a@b.co' } };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store: memoryStore(), now: () => NOW });
  await acct.completePasswordRecovery({ ok: true, access_token: 'rec-1', refresh_token: 'ref-9', expires_in: 3600 }, 'brand-new-pass');
  assert.equal(calls[0].url, 'https://p/auth/v1/user');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer rec-1');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { password: 'brand-new-pass' });
  assert.equal(acct.currentUser()?.email, 'a@b.co');
  assert.equal(await acct.accessToken(), 'rec-1');
});

test('change password and email, delete account, expired session reason', async () => {
  const store = memoryStore();
  store.set(
    'element.session.v1',
    JSON.stringify({ access_token: 'acc', refresh_token: 'r', expires_at: NOW + 3600, user: { id: 'u1', email: 'a@b.co' } }),
  );
  const calls: { url: string; init: RequestInit }[] = [];
  const { fn } = fakeFetch((url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) {
      const body = JSON.parse(init.body as string);
      return { status: 200, body: { id: 'u1', email: body.email ?? 'a@b.co' } };
    }
    if (url.endsWith('/rpc/delete_account')) return { status: 200, body: { deleted: true } };
    return { status: 200, body: {} };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  await acct.changePassword('another-pass-1');
  assert.equal(calls.at(-1)!.init.method, 'PUT');
  assert.equal(await acct.changeEmail(' new@b.co '), 'changed');
  assert.equal(acct.currentUser()?.email, 'new@b.co');
  assert.equal(JSON.parse(store.get('element.session.v1')!).user.email, 'new@b.co', 'saved session updated too');
  await acct.deleteAccount();
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/delete_account')));
  assert.equal(acct.currentUser(), null);
  assert.equal(store.get('element.session.v1'), null, 'tokens cleared');
  assert.equal(acct.takeSignOutReason(), null, 'a deliberate delete is not an expired session');

  const expiredStore = memoryStore();
  expiredStore.set(
    'element.session.v1',
    JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: NOW - 5, user: { id: 'u1', email: 'a@b.co' } }),
  );
  const { fn: reject } = fakeFetch(() => ({ status: 400, body: { msg: 'Invalid Refresh Token: Refresh Token Not Found' } }));
  const stale = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: reject, store: expiredStore, now: () => NOW });
  assert.equal(await stale.accessToken(), null);
  assert.equal(stale.takeSignOutReason(), 'Please sign in again.');
  assert.equal(stale.takeSignOutReason(), null, 'shown once');
  await assert.rejects(stale.changePassword('another-pass-1'), /Please sign in again/);
});

test('mock account: reset link, password and email change, delete account', async () => {
  const acct = createMockAccount(() => [card()], memoryStore());
  await acct.requestPasswordReset('me@x.co', 'https://x/reset-password');
  await assert.rejects(
    acct.completePasswordRecovery({ ok: true, access_token: 'forged', refresh_token: null, expires_in: null }, 'longenough'),
    /invalid or has expired/,
  );
  await acct.completePasswordRecovery({ ok: true, access_token: 'mock-recovery:me@x.co', refresh_token: null, expires_in: null }, 'longenough');
  assert.equal(acct.currentUser()?.email, 'me@x.co');
  await acct.changePassword('another-pass-1');
  assert.equal(await acct.changeEmail('you@x.co'), 'changed');
  assert.equal(acct.currentUser()?.email, 'you@x.co');
  await acct.setPrefs(['tech']);
  await acct.deleteAccount();
  assert.equal(acct.currentUser(), null);
});

test('For you header admits when followed topics have no cards', () => {
  const cards = [{ category: 'policy' }, { category: 'markets' }] as never[];
  assert.equal(forYouCoversTopics(cards, ['energy', 'tech']), false);
  assert.equal(forYouCoversTopics(cards, ['policy']), true);
  assert.equal(forYouCoversTopics(cards, []), true, 'no topics followed: nothing to admit');
  assert.equal(forYouCoversTopics([], ['energy']), true, 'still loading: no claim either way');
});

test('B1: my_reaction from For you is applied once per card', () => {
  const noted = new Set<string>();
  const cards = [
    { id: 'a', my_reaction: 'like' },
    { id: 'b', my_reaction: null },
    { id: 'c', my_reaction: 'dislike' },
  ];
  assert.deepEqual(unseenReactions(cards, noted), { a: 'like', c: 'dislike' });
  assert.equal(unseenReactions(cards, noted), null, 'a second call with the same cards changes nothing');
  assert.deepEqual(unseenReactions([...cards, { id: 'd', my_reaction: 'like' }], noted), { d: 'like' }, 'only new cards count');
});

test('B4: a refreshed token with the same user is the same user', () => {
  assert.equal(sameUser({ id: 'u', email: 'a@b.co' }, { id: 'u', email: 'a@b.co' }), true);
  assert.equal(sameUser({ id: 'u', email: 'a@b.co' }, { id: 'u', email: 'new@b.co' }), false);
  assert.equal(sameUser(null, null), true);
  assert.equal(sameUser({ id: 'u', email: 'a@b.co' }, null), false);
});

test('B3: parallel calls share one refresh', async () => {
  const store = memoryStore();
  store.set(
    'element.session.v1',
    JSON.stringify({ access_token: 'old', refresh_token: 'r0', expires_at: NOW - 10, user: { id: 'u1', email: 'a@b.co' } }),
  );
  let refreshes = 0;
  const { fn } = fakeFetch((url) => {
    if (url.includes('grant_type=refresh_token')) {
      refreshes++;
      return { status: 200, body: tokenResponse({ access_token: 'new', refresh_token: 'r1' }) };
    }
    return { status: 200, body: [] };
  });
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  const tokens = await Promise.all([acct.accessToken(), acct.accessToken(), acct.accessToken()]);
  assert.deepEqual(tokens, ['new', 'new', 'new']);
  assert.equal(refreshes, 1);
});

test('B3: a token another tab already rotated is adopted, not treated as a sign-out', async () => {
  const store = memoryStore();
  const stale = { access_token: 'old', refresh_token: 'r0', expires_at: NOW - 10, user: { id: 'u1', email: 'a@b.co' } };
  store.set('element.session.v1', JSON.stringify(stale));
  let refreshes = 0;
  const { fn } = fakeFetch(() => {
    refreshes++;
    return { status: 400, body: { msg: 'Invalid Refresh Token: Already Used' } };
  });
  const tabB = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  // tab A refreshed first and saved the rotated session
  store.set('element.session.v1', JSON.stringify({ ...stale, access_token: 'fromA', refresh_token: 'r1', expires_at: NOW + 3600 }));
  assert.equal(await tabB.accessToken(), 'fromA');
  assert.equal(refreshes, 0, 'no refresh needed: the stored session is fresh');
  assert.equal(tabB.currentUser()?.id, 'u1');
  assert.equal(tabB.takeSignOutReason(), null);
  assert.ok(store.get('element.session.v1'), "tab A's good session is not wiped");
});

test('B3: an unexpired token is replaced by the newer session from another tab', async () => {
  const store = memoryStore();
  const original = { access_token: 'old', refresh_token: 'r0', expires_at: NOW + 1800, user: { id: 'u1', email: 'a@b.co' } };
  store.set('element.session.v1', JSON.stringify(original));
  const { fn } = fakeFetch(() => ({ status: 200, body: {} }));
  const tabB = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  store.set('element.session.v1', JSON.stringify({ ...original, access_token: 'fromA', refresh_token: 'r1' }));
  assert.equal(await tabB.accessToken(), 'fromA');
  assert.equal(tabB.currentUser()?.id, 'u1');
});

test('hide topics: three exclusive states', () => {
  const prefs = { followed: ['tech', 'world'], hidden: ['deals'] };
  assert.equal(topicState(prefs, 'tech'), 'follow');
  assert.equal(topicState(prefs, 'deals'), 'hide');
  assert.equal(topicState(prefs, 'energy'), 'normal');
  assert.equal(topicState(null, 'tech'), 'normal');
  assert.deepEqual(withTopicState(prefs, 'tech', 'hide'), { followed: ['world'], hidden: ['deals', 'tech'] }, 'hiding a followed topic unfollows it');
  assert.deepEqual(withTopicState(prefs, 'deals', 'follow'), { followed: ['tech', 'world', 'deals'], hidden: [] });
  assert.deepEqual(withTopicState(prefs, 'world', 'normal'), { followed: ['tech'], hidden: ['deals'] });
  for (const slug of ['tech', 'deals', 'energy']) {
    for (const st of ['follow', 'normal', 'hide'] as const) {
      const next = withTopicState(prefs, slug, st);
      assert.ok(!next.followed.some((s) => next.hidden.includes(s)), 'never both followed and hidden');
    }
  }
});

test('hidden topics leave the chips and the feed', () => {
  const cats = [
    { slug: 'tech', name: 'Tech' },
    { slug: 'deals', name: 'Deals' },
  ];
  assert.deepEqual(
    withoutHidden(cats, ['deals']).map((c) => c.slug),
    ['tech'],
  );
  const cards = [
    { id: 'a', category: 'deals' },
    { id: 'b', category: 'tech' },
  ];
  assert.deepEqual(
    withoutHidden(cards, ['deals']).map((c) => c.id),
    ['b'],
  );
  assert.equal(withoutHidden(cards, []), cards, 'nothing hidden: same list');
});

test('mock account: prefs saved by an older build get hiddenSources filled in', async () => {
  const store = memoryStore();
  store.set(
    'element.mock-account.v1',
    JSON.stringify({ user: { id: 'u', email: 'a@b.co' }, prefs: { u: { followed: ['tech'], hidden: [], onboarded: true } }, feedback: {} }),
  );
  const acct = createMockAccount(() => [card()], store);
  const p = await acct.getPrefs();
  assert.deepEqual(p.hiddenSources, []);
  assert.deepEqual(p.followed, ['tech']);
  assert.deepEqual((await acct.setPrefs(['tech'], [], ['nasa'])).hiddenSources, ['nasa']);
});

test('track sends p_ms only with dwell', () => {
  assert.deepEqual(ACCOUNT_RPC.track.args('c1', 'dwell', 4200), { p_blurb: 'c1', p_kind: 'dwell', p_ms: 4200 });
  assert.deepEqual(ACCOUNT_RPC.track.args('c1', 'open_detail'), { p_blurb: 'c1', p_kind: 'open_detail' });
  assert.deepEqual(ACCOUNT_RPC.track.args('c1', 'like'), { p_blurb: 'c1', p_kind: 'like' });
});

test('my_categories: used when the server has it, null before migration 070000', async () => {
  const store = memoryStore();
  store.set('element.session.v1', JSON.stringify({ access_token: 'acc', refresh_token: 'r', expires_at: NOW + 3600, user: { id: 'u1', email: 'a@b.co' } }));
  let has = true;
  const { fn } = fakeFetch((url) =>
    url.endsWith('/rpc/my_categories')
      ? has
        ? { status: 200, body: [{ slug: 'deals', name: 'Deals', sort_order: 2, followed: false, hidden: true }, { slug: 'world', name: 'World', sort_order: 1, followed: true, hidden: false }] }
        : { status: 404, body: { message: 'Could not find the function api.my_categories' } }
      : { status: 200, body: {} },
  );
  const acct = createSupabaseAccount({ url: 'https://p', key: 'k', fetchFn: fn, store, now: () => NOW });
  assert.deepEqual((await acct.myCategories())?.map((c) => c.slug), ['world', 'deals']);
  has = false;
  assert.equal(await acct.myCategories(), null);
});
