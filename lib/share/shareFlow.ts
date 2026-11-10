// Share a link on the web: the system share sheet when the browser has one, else the clipboard,
// else a hidden-textarea copy, else ask the reader to copy it by hand. Pure (dependencies are
// passed in), so Node tests cover every branch. Returns the toast text, or null when the
// system sheet handled it. Used by lib/shared/useCardActions.ts.

export interface ShareDeps {
  /** navigator.share when the browser has it. */
  share?: (data: { title: string; url: string }) => Promise<void>;
  /** navigator.clipboard.writeText when available. */
  writeText?: (text: string) => Promise<void>;
  /** Legacy copy (a hidden textarea and execCommand('copy')); true when it worked. */
  legacyCopy?: (text: string) => boolean;
  /** Last resort: show the link so the reader can copy it by hand (window.prompt). */
  manualCopy?: (text: string) => void;
}

export const COPIED = 'Link copied';
export const COPY_BY_HAND = 'Copy the link from the box that opened.';
export const COPY_FAILED = 'Could not copy the link. Long-press the address bar to copy this page instead.';

export async function shareLink(title: string, url: string, d: ShareDeps): Promise<string | null> {
  if (d.share) {
    try {
      await d.share({ title, url });
      return null;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return null; // reader closed the sheet
    }
  }
  if (d.writeText) {
    try {
      await d.writeText(url);
      return COPIED;
    } catch {
      // permission denied or insecure page: try the next way
    }
  }
  if (d.legacyCopy) {
    try {
      if (d.legacyCopy(url)) return COPIED;
    } catch {
      // fall through
    }
  }
  if (d.manualCopy) {
    try {
      d.manualCopy(url);
      return COPY_BY_HAND;
    } catch {
      // fall through
    }
  }
  return COPY_FAILED;
}

/** The browser-backed dependencies. Only call in a browser. */
export function browserShareDeps(): ShareDeps {
  const g = globalThis as { navigator?: Navigator; document?: Document; window?: Window };
  const nav = g.navigator;
  const doc = g.document;
  return {
    share: nav && typeof nav.share === 'function' ? (data) => nav.share(data) : undefined,
    writeText: nav?.clipboard && typeof nav.clipboard.writeText === 'function' ? (t) => nav.clipboard.writeText(t) : undefined,
    legacyCopy: doc
      ? (text) => {
          const ta = doc.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          doc.body.appendChild(ta);
          ta.select();
          let ok = false;
          try { ok = doc.execCommand('copy'); } finally { doc.body.removeChild(ta); }
          return ok;
        }
      : undefined,
    manualCopy: g.window && typeof g.window.prompt === 'function' ? (t) => { g.window?.prompt('Copy this link', t); } : undefined,
  };
}
