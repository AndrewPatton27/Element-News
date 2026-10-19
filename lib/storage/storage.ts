// Tiny key-value store for the auth session: localStorage on web, memory elsewhere
// (native builds would swap in AsyncStorage; the demo is the web app).

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// Writes through defaultStore() from anywhere in the app notify these listeners with the key,
// so the account context sees a follow saved by the Following screen at once.
type Listener = (key: string) => void;
const listeners = new Set<Listener>();
export function onStoreChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function notify(key: string) {
  for (const fn of listeners) {
    try {
      fn(key);
    } catch {
      // a listener's problem is its own
    }
  }
}
function notifying(s: KeyValueStore): KeyValueStore {
  return {
    get: (k) => s.get(k),
    set: (k, v) => {
      s.set(k, v);
      notify(k);
    },
    remove: (k) => {
      s.remove(k);
      notify(k);
    },
  };
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

// Off web the memory store is shared, so every screen sees the same values.
let sharedMemory: KeyValueStore | null = null;

export function defaultStore(): KeyValueStore {
  return notifying(baseStore());
}

function baseStore(): KeyValueStore {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      const probe = '__element_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return {
        get: (k) => {
          try {
            return ls.getItem(k);
          } catch {
            return null;
          }
        },
        set: (k, v) => {
          try {
            ls.setItem(k, v);
          } catch {
            // storage full or blocked: the session just won't survive a reload
          }
        },
        remove: (k) => {
          try {
            ls.removeItem(k);
          } catch {
            // ignore
          }
        },
      };
    }
  } catch {
    // private mode or blocked storage
  }
  sharedMemory ??= memoryStore();
  return sharedMemory;
}
