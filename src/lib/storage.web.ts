/** Key-value storage for the web build.
 *
 *  localStorage is synchronous, which is exactly the shape zustand's persist
 *  middleware wants, and it survives a reload and an add-to-home-screen
 *  launch. Every access is guarded: in a private window, or with site data
 *  blocked, these throw rather than return null. */
export interface KV {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const PREFIX = 'snapgrade:';

/** Used when localStorage is unavailable, so the session still works even
 *  though nothing will persist past it. */
const memory = new Map<string, string>();

function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touch it: Safari in private mode throws on write, not on access.
    const probe = `${PREFIX}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

const local = store();

export const kv: KV = {
  getString: (key) => {
    if (!local) return memory.get(key);
    try {
      return local.getItem(PREFIX + key) ?? undefined;
    } catch {
      return memory.get(key);
    }
  },
  set: (key, value) => {
    memory.set(key, value);
    try {
      local?.setItem(PREFIX + key, value);
    } catch {
      // Quota exceeded, most likely. The in-memory copy keeps the session
      // going; the next launch simply starts fresh.
    }
  },
  delete: (key) => {
    memory.delete(key);
    try {
      local?.removeItem(PREFIX + key);
    } catch {
      /* nothing to do */
    }
  },
};

export const usingMmkv = false;

/** Shown in Settings → Diagnostics. */
export const storageBackend = local ? 'localStorage' : 'memory (not saved)';

/** Nothing to await: localStorage is already there when this module loads. */
export async function waitForStorage(): Promise<void> {}

export const zustandStorage = {
  getItem: (name: string): string | null => kv.getString(name) ?? null,
  setItem: (name: string, value: string): void => kv.set(name, value),
  removeItem: (name: string): void => kv.delete(name),
};
