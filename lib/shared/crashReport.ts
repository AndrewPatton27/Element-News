// What the app keeps when something crashes, and the stale-chunk reload. Pure apart from the
// small storage and window interfaces it is given, so node --test runs it
// (lib/__tests__/crashReport.test.ts).
//
// Why the reload: the website is split into one JavaScript file per screen (search-<hash>.js,
// following-<hash>.js, ...), loaded the first time a screen opens. Every deploy renames them and
// removes the old ones. A tab opened before a deploy still asks for the old names; Cloudflare
// Pages answers a missing file with index.html (HTTP 200), so the script "loads" but defines
// nothing and the screen import fails with `Requiring unknown module "N"` (or, when the file
// 404s, "Loading module ... failed"). That reached the app error boundary as "Something went
// wrong" the first time such a reader opened Search. A fresh index.html names the new files, so
// one reload fixes it; the reload is allowed once per CHUNK_RELOAD_WINDOW_MS so it never loops.

export const LAST_ERROR_KEY = 'element.last-error';
export const CHUNK_RELOAD_KEY = 'element.chunk-reload-at';
export const CHUNK_RELOAD_WINDOW_MS = 60_000;
export const MAX_FIELD_CHARS = 600;

export interface SessionLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CHUNK_PATTERNS: RegExp[] = [
  /Requiring unknown module/i, // metro: the chunk ran but did not define the module (HTML served)
  /Loading module .* failed/i, // expo AsyncRequireError: the chunk 404'd or the network failed
  /Loading chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

function errorParts(err: unknown): { name: string; message: string; stack: string } {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(err),
      stack: typeof e.stack === 'string' ? e.stack : '',
    };
  }
  return { name: 'Error', message: String(err), stack: '' };
}

/** True for a screen file (chunk) that could not be loaded, the case a reload fixes. */
export function isChunkLoadError(err: unknown): boolean {
  const { name, message } = errorParts(err);
  if (name === 'ChunkLoadError' || name === 'AsyncRequireError') return true;
  return CHUNK_PATTERNS.some((re) => re.test(message));
}

/**
 * Removes anything private before an error is stored: access tokens (JWTs), "Bearer ..." values,
 * apikey/token/password fields, email addresses and URL query strings. Then caps the length.
 */
export function sanitizeErrorText(text: string, max: number = MAX_FIELD_CHARS): string {
  const clean = String(text)
    .replace(/eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '[jwt]')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(apikey|api_key|key|token|access_token|refresh_token|password|p_email|email)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1$2[redacted]')
    .replace(/sb_(publishable|secret)_[\w-]+/gi, '[key]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(https?:\/\/[^\s?#"')]+)\?[^\s#"')]*/g, '$1?[query]');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface CrashRecord {
  at: string;
  where: string;
  name: string;
  message: string;
  stack: string;
  componentStack: string;
  chunk: boolean;
  path: string;
}

export function crashRecord(err: unknown, o: { componentStack?: string | null; where?: string; now?: Date; path?: string | null } = {}): CrashRecord {
  const { name, message, stack } = errorParts(err);
  return {
    at: (o.now ?? new Date()).toISOString(),
    where: o.where ?? 'app',
    name: sanitizeErrorText(name, 80),
    message: sanitizeErrorText(message),
    stack: sanitizeErrorText(stack.split('\n').slice(0, 8).join('\n')),
    componentStack: sanitizeErrorText((o.componentStack ?? '').trim().split('\n').slice(0, 12).join('\n')),
    chunk: isChunkLoadError(err),
    path: sanitizeErrorText(o.path ?? '', 120),
  };
}

/** Keeps the latest crash in session storage (this tab only). Never throws. */
export function saveCrash(store: SessionLike | null | undefined, rec: CrashRecord): void {
  try {
    store?.setItem(LAST_ERROR_KEY, JSON.stringify(rec));
  } catch {
    // storage blocked or full: the console copy is still there
  }
}

export function readCrash(store: SessionLike | null | undefined): CrashRecord | null {
  try {
    const raw = store?.getItem(LAST_ERROR_KEY);
    if (!raw) return null;
    const x = JSON.parse(raw) as CrashRecord;
    return x && typeof x === 'object' && typeof x.message === 'string' ? x : null;
  } catch {
    return null;
  }
}

/**
 * May the page reload now to pick up new screen files? Yes at most once per window: the time of
 * the last reload is kept in session storage. Without storage, no (a reload could then loop).
 */
export function claimChunkReload(store: SessionLike | null | undefined, now: number = Date.now(), windowMs: number = CHUNK_RELOAD_WINDOW_MS): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(CHUNK_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < windowMs) return false;
    store.setItem(CHUNK_RELOAD_KEY, String(now));
    return store.getItem(CHUNK_RELOAD_KEY) === String(now);
  } catch {
    return false;
  }
}

export interface WindowLike {
  sessionStorage?: SessionLike;
  location?: { reload(): void; pathname?: string };
  addEventListener?(type: string, fn: (ev: unknown) => void): void;
  removeEventListener?(type: string, fn: (ev: unknown) => void): void;
}

export function sessionOf(win: WindowLike | null | undefined): SessionLike | null {
  try {
    return win?.sessionStorage ?? null;
  } catch {
    return null; // some browsers throw on access when storage is blocked
  }
}

/** If `err` is a stale-chunk failure and a reload is allowed, reloads and returns true. */
export function reloadForChunkError(err: unknown, win: WindowLike | null | undefined, now: number = Date.now()): boolean {
  if (!win?.location || !isChunkLoadError(err)) return false;
  if (!claimChunkReload(sessionOf(win), now)) return false;
  try {
    win.location.reload();
    return true;
  } catch {
    return false;
  }
}

/**
 * Web only: a lazy screen that fails outside React (an unhandled rejection, or a script error
 * event) also triggers the one-time reload. Returns a function that removes the listeners.
 */
export function installChunkReload(win: WindowLike | null | undefined): () => void {
  if (!win?.addEventListener) return () => undefined;
  const onRejection = (ev: unknown) => {
    const reason = (ev as { reason?: unknown } | null)?.reason;
    if (isChunkLoadError(reason)) {
      saveCrash(sessionOf(win), crashRecord(reason, { where: 'unhandledrejection', path: win.location?.pathname ?? null }));
      reloadForChunkError(reason, win);
    }
  };
  const onError = (ev: unknown) => {
    const e = ev as { error?: unknown; message?: unknown } | null;
    const err = e?.error ?? e?.message;
    if (isChunkLoadError(err)) reloadForChunkError(err, win);
  };
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('error', onError);
  return () => {
    win.removeEventListener?.('unhandledrejection', onRejection);
    win.removeEventListener?.('error', onError);
  };
}
