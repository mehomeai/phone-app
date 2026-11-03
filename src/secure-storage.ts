// Storage split: secrets live ONLY behind SecureStorage (native key storage).
// Conversation history/cache lives in CacheStorage (e.g. AsyncStorage) and must
// never contain tokens, device secrets, or pairing secrets.
//
// This mirrors the prototype split (MeContext.tsx): demo/message state in
// AsyncStorage, the home credential in Expo SecureStore, web pairing disabled.
// The factories below adapt those concrete modules WITHOUT importing them, so
// this package stays portable (Node tests, Expo app, future web guarded).

export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  isAvailable?(): Promise<boolean>;
}

export interface CacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createMemorySecureStorage(): SecureStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async deleteItem(key) {
      map.delete(key);
    },
    async isAvailable() {
      return true;
    },
  };
}

export function createMemoryCacheStorage(): CacheStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

interface ExpoSecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  isAvailableAsync?(): Promise<boolean>;
}

/** Adapt an Expo SecureStore module without taking an expo dependency. */
export function createExpoSecureStoreAdapter(
  secureStore: ExpoSecureStoreModule,
): SecureStorage {
  return {
    getItem: (key) => secureStore.getItemAsync(key).catch(() => null),
    setItem: (key, value) => secureStore.setItemAsync(key, value),
    deleteItem: (key) => secureStore.deleteItemAsync(key),
    isAvailable: async () => {
      if (!secureStore.isAvailableAsync) return true;
      try {
        return await secureStore.isAvailableAsync();
      } catch {
        return false;
      }
    },
  };
}

interface AsyncStorageModule {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Adapt an AsyncStorage module as message-cache storage (never for secrets). */
export function createAsyncStorageCacheAdapter(
  asyncStorage: AsyncStorageModule,
): CacheStorage {
  return {
    getItem: (key) => asyncStorage.getItem(key),
    setItem: (key, value) => asyncStorage.setItem(key, value),
    removeItem: (key) => asyncStorage.removeItem(key),
  };
}

/** Test helper: scan a cache payload for leaked secret-looking material. */
export function cacheLeaksSecrets(
  cacheText: string,
  secrets: Array<string | null | undefined>,
): boolean {
  const live = secrets.filter(
    (s): s is string => typeof s === 'string' && s.length >= 8,
  );
  return live.some((secret) => cacheText.includes(secret));
}

/** Redact authorization material from a headers object before logging. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...headers };
  for (const key of Object.keys(next)) {
    if (
      key.toLowerCase() === 'authorization' ||
      key.toLowerCase().startsWith('x-device')
    ) {
      next[key] = '[redacted]';
    }
  }
  return next;
}
