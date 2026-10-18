// Auth session helpers for Supabase Auth (GoTrue) responses. Pure: no React.

export interface AuthUser {
  id: string;
  email: string;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user: AuthUser;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

// Accepts a GoTrue token response ({access_token, refresh_token, expires_in|expires_at, user}).
export function parseSession(x: unknown, nowSec: number = Math.floor(Date.now() / 1000)): Session | null {
  if (!isObj(x) || typeof x.access_token !== 'string' || typeof x.refresh_token !== 'string') return null;
  const user = isObj(x.user) ? x.user : null;
  if (!user || typeof user.id !== 'string') return null;
  const expiresAt = typeof x.expires_at === 'number' ? x.expires_at : typeof x.expires_in === 'number' ? nowSec + x.expires_in : nowSec + 3600;
  return {
    access_token: x.access_token,
    refresh_token: x.refresh_token,
    expires_at: expiresAt,
    user: { id: user.id, email: typeof user.email === 'string' ? user.email : '' },
  };
}

// Refresh a minute early so a request never goes out with a token that expires in flight.
export function needsRefresh(s: Session, nowSec: number = Math.floor(Date.now() / 1000), skewSec = 60): boolean {
  return s.expires_at - skewSec <= nowSec;
}

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
  if (password.length < 8) return 'Use at least 8 characters for the password.';
  return null;
}

// Short, human messages for GoTrue errors. Never echoes tokens or keys.
export function authErrorMessage(status: number, body: unknown): string {
  const b = isObj(body) ? body : {};
  const raw = [b.error_description, b.msg, b.message, b.error].find((v) => typeof v === 'string') as string | undefined;
  const code = typeof b.error_code === 'string' ? b.error_code : '';
  // Supabase's built-in mailer sends only a few confirmation emails per hour; waiting a minute won't help.
  if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(raw ?? '')) {
    return 'Too many sign-up emails were sent. Try again later, or sign in if you already have an account.';
  }
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(raw ?? '')) return 'Email or password is not right.';
  if (code === 'user_already_exists' || /already registered/i.test(raw ?? '')) return 'That email already has an account. Sign in instead.';
  if (code === 'email_exists' || /email address has already been registered/i.test(raw ?? ''))
    return 'That email is already used by another account.';
  if (code === 'same_password') return 'Choose a password that is different from your current one.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(raw ?? '')) return 'Check your inbox and confirm your email first.';
  if (code === 'weak_password' || /password/i.test(raw ?? '')) return raw ?? 'Choose a stronger password.';
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  if (status === 0) return 'Could not reach the server. Check your connection.';
  return raw ? `Sign-in failed: ${raw}` : `Sign-in failed (${status}).`;
}

// Show/hide password toggle: what the button says, for screen readers and tooltips.
export function passwordToggleLabel(visible: boolean): string {
  return visible ? 'Hide password' : 'Show password';
}

export const MIN_PASSWORD_LENGTH = 8;

// New password + confirmation (sign-up uses validateCredentials; this is for reset and change).
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`;
  if (password !== confirm) return 'The two passwords don’t match.';
  return null;
}

export function validateEmail(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? null : 'Enter a valid email address.';
}

// Same text whether or not the email has an account, so the form can't be used to
// find out who has signed up.
export const RESET_SENT_MESSAGE = 'If that email has an account, we sent a reset link.';
export const RESET_RATE_LIMIT_MESSAGE = 'Too many reset emails were sent recently. Try again later.';
export const SIGN_IN_AGAIN_MESSAGE = 'Please sign in again.';
export const INVALID_RESET_LINK_MESSAGE = 'This reset link is invalid or has expired. Ask for a new one from the sign-in page.';

export type RecoveryLink = { ok: true; access_token: string; refresh_token: string | null; expires_in: number | null } | { ok: false; error: string };

// Reads the link Supabase emails for a password reset. Tokens arrive in the URL
// fragment (#access_token=...&type=recovery); errors (expired, used) arrive as
// error / error_code / error_description in the fragment or the query string.
export function parseRecoveryLink(hash: string, search = ''): RecoveryLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const query = new URLSearchParams(search.replace(/^\?/, ''));
  const err = params.get('error') ?? query.get('error');
  if (err) return { ok: false, error: INVALID_RESET_LINK_MESSAGE }; // expired, already used or otherwise rejected
  const token = params.get('access_token');
  if (!token || params.get('type') !== 'recovery') return { ok: false, error: INVALID_RESET_LINK_MESSAGE };
  const exp = Number(params.get('expires_in'));
  return { ok: true, access_token: token, refresh_token: params.get('refresh_token'), expires_in: Number.isFinite(exp) && exp > 0 ? exp : null };
}

// Account deletion asks the user to type DELETE.
export const DELETE_CONFIRM_WORD = 'DELETE';
export function deleteConfirmed(typed: string): boolean {
  return typed.trim() === DELETE_CONFIRM_WORD;
}
