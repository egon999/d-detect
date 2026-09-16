/**
 * An in-memory stand-in for `expo-secure-store`.
 *
 * The real package is a native module and cannot load under Node at all, which is exactly
 * why `credentials.ts` imports it dynamically and treats a failed import as "no storage".
 * That leaves "no key stored" as the only state a plain Node test could otherwise reach —
 * and since the keystore is now the *only* place a key can come from, every test that
 * needs a key present needs this double.
 *
 * Install it at the top of a test file, before any import that reaches `credentials.ts`:
 *
 * ```ts
 * vi.mock('expo-secure-store', async () => (await import('./secure-store-double')).secureStoreDouble);
 * ```
 *
 * The `await import` matters: `vi.mock` factories are hoisted above the file's own
 * imports, so a factory that referenced a statically imported binding would read it before
 * initialisation.
 *
 * Seed it through `saveKey` rather than by writing to `items` directly, so the storage-key
 * namespacing in `credentials.ts` stays the single source of truth for what a stored key
 * is called.
 */

const items = new Map<string, string>();

let available = true;
let nextReadThrows = false;

/** The mocked module surface — exactly the four members `credentials.ts` declares. */
export const secureStoreDouble = {
  isAvailableAsync: async (): Promise<boolean> => available,
  getItemAsync: async (key: string): Promise<string | null> => {
    if (nextReadThrows) {
      nextReadThrows = false;
      // Stands in for the keystore-invalidated case: the device passcode was removed, so
      // the entry exists but can no longer be decrypted.
      throw new Error('keystore entry could not be decrypted');
    }
    return items.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string): Promise<void> => {
    items.set(key, value);
  },
  deleteItemAsync: async (key: string): Promise<void> => {
    items.delete(key);
  },
};

/**
 * Clears every stored entry and restores the default "storage works" behaviour.
 *
 * Call `resetCredentialsCacheForTests()` alongside this: `credentials.ts` memoises the
 * module handle, so a change to `available` is not observed until that cache is dropped.
 */
export function resetSecureStoreDouble(): void {
  items.clear();
  available = true;
  nextReadThrows = false;
}

/** Simulates a platform with no keystore — web, or a device that reports it unusable. */
export function setSecureStoreAvailable(next: boolean): void {
  available = next;
}

/** Makes the next read throw, so the caller's failure path can be exercised. */
export function failNextSecureStoreRead(): void {
  nextReadThrows = true;
}

/** How many entries are held. Used to assert that `clearKey` actually removed one. */
export function secureStoreSize(): number {
  return items.size;
}
