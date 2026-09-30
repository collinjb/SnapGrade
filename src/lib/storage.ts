/** Synchronous key-value storage backed by MMKV, falling back to AsyncStorage
 *  (async, mirrored through an in-memory cache) when MMKV's native module is
 *  missing — e.g. in Expo Go or a dev build that predates the dependency. */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface KV {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const PREFIX = 'snapgrade:';

function makeMmkv(): KV | null {
  try {
    // Required lazily so a missing native module degrades instead of crashing.
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const mmkv = new MMKV({ id: 'snapgrade' });
    return {
      getString: (k) => mmkv.getString(k),
      set: (k, v) => mmkv.set(k, v),
      delete: (k) => mmkv.delete(k),
    };
  } catch {
    return null;
  }
}

class AsyncStorageShim implements KV {
  private cache = new Map<string, string>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.hydrate();
  }

  private async hydrate(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const ours = keys.filter((k) => k.startsWith(PREFIX));
      if (ours.length === 0) return;
      for (const [k, v] of await AsyncStorage.multiGet(ours)) {
        if (v != null) this.cache.set(k.slice(PREFIX.length), v);
      }
    } catch {
      // Nothing persisted is recoverable; start empty rather than block boot.
    }
  }

  getString(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    void AsyncStorage.setItem(PREFIX + key, value);
  }

  delete(key: string): void {
    this.cache.delete(key);
    void AsyncStorage.removeItem(PREFIX + key);
  }
}

const mmkv = makeMmkv();
const shim = mmkv ? null : new AsyncStorageShim();

export const kv: KV = mmkv ?? shim!;
export const usingMmkv = mmkv !== null;

/** Shown in Settings → Diagnostics. */
export const storageBackend = mmkv ? 'MMKV' : 'AsyncStorage';

/** Resolves once the fallback store has loaded from disk. No-op under MMKV. */
export async function waitForStorage(): Promise<void> {
  await shim?.ready;
}

/** Storage adapter shaped for zustand's `createJSONStorage`. */
export const zustandStorage = {
  getItem: (name: string): string | null => kv.getString(name) ?? null,
  setItem: (name: string, value: string): void => kv.set(name, value),
  removeItem: (name: string): void => kv.delete(name),
};
