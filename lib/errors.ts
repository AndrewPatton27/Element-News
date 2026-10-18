// Friendly error text for the feed and account calls. Pure: no React imports, so node --test runs it.
//
// Readers never see "Server returned 400: invalid_cursor". HTTP statuses and PostgREST
// errors map to one short sentence; the raw text is kept on the error (`detail`) and is
// printed only to the console in development. Messages never include headers or keys.

export const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
export const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
export const SIGN_IN_AGAIN = 'Please sign in again.';

declare const __DEV__: boolean | undefined;

const lower = (s: string | null | undefined): string => (typeof s === 'string' ? s.toLowerCase() : '');

/** The server rejected a paging cursor (the list changed, or the cursor was damaged). */
export function isInvalidCursor(status: number, raw?: string | null): boolean {
  return status === 400 && /invalid[_ ]cursor|bad[_ ]cursor/.test(lower(raw));
}

// `raw` is PostgREST's `message` (an RPC's `raise exception` text, or the engine's), `code`
// is its `code` field (PGRSTxxx, or a Postgres SQLSTATE such as 42501).
export function friendlyHttpError(status: number, raw?: string | null, code?: string | null): string {
  const text = lower(raw);
  const c = (code ?? '').toUpperCase();
  if (status === 0) return NETWORK_MESSAGE;
  if (isInvalidCursor(status, raw)) return 'The feed changed while you were reading. Tap retry to start again.';
  if (/unknown[_ ]card|card not found/.test(text)) return 'That card is no longer available.';
  if (status === 401 || c === 'PGRST301' || c === 'PGRST303' || /jwt expired|not[_ ]authenticated/.test(text)) return SIGN_IN_AGAIN;
  if (status === 403 || c === '42501') return 'You do not have access to do that.';
  if (c === 'PGRST202' || c === '42883') return 'This feature is not available yet. Try again later.';
  if (status === 404) return 'We could not find that.';
  if (status === 408 || status === 504) return 'The server took too long to answer. Try again.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The server had a problem. Try again in a moment.';
  if (status === 400 || status === 406 || status === 422) return 'That request could not be completed. Try again.';
  return GENERIC_MESSAGE;
}

/** Console warning with the raw text, in development builds only. */
export function warnRaw(context: string, raw: unknown): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__ === true && raw !== undefined && raw !== '') {
    console.warn(`[element] ${context}:`, raw);
  }
}

/** The raw text kept on an error for developers (never shown to readers). */
export function rawDetail(err: unknown): string | undefined {
  const d = err && typeof err === 'object' ? (err as { detail?: unknown }).detail : undefined;
  return typeof d === 'string' ? d : undefined;
}

// Errors thrown by our own API layers (ApiError, AccountError) already carry a friendly
// message. Anything else (a parse failure, a thrown TypeError) must not leak its text.
export function userMessage(err: unknown, fallback: string = GENERIC_MESSAGE): string {
  if (err instanceof Error && (err.name === 'ApiError' || err.name === 'AccountError') && err.message) return err.message;
  warnRaw('unexpected error', err);
  return fallback;
}

/** Reads `message` and `code` out of a PostgREST error body without trusting its shape. */
export function parseErrorBody(body: unknown): { message: string | null; code: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { message: null, code: null };
  const o = body as { message?: unknown; code?: unknown };
  return { message: typeof o.message === 'string' ? o.message : null, code: typeof o.code === 'string' ? o.code : null };
}
