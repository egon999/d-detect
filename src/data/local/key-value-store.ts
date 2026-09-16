/**
 * The narrow slice of key/value storage the local adapter needs.
 *
 * Kept as an interface so the adapter can be exercised in plain Node against an
 * in-memory store. Importing `@react-native-async-storage/async-storage` directly
 * would drag the React Native runtime into the unit tests, and the write path is
 * exactly the part worth testing without a device.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  getMany(keys: readonly string[]): Promise<Array<[string, string | null]>>;
  setMany(entries: ReadonlyArray<readonly [string, string]>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory store. Used by tests, and as the fallback when persistence is unavailable. */
export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async getMany(keys) {
      return keys.map((key) => [key, map.get(key) ?? null] as [string, string | null]);
    },
    async setMany(entries) {
      for (const [key, value] of entries) map.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}
