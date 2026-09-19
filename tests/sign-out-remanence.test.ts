/**
 * What a sign-out has to take off the device.
 *
 * Signing out used to end the Firebase session and leave Firestore's persistent cache exactly
 * where it was. That cache is not an index or a handful of ids: it is a copy of every document
 * the client has read, `extraction.sourceText` — the full extracted text of a user's evidence —
 * included. On a shared or handed-on phone that is one person's evidence left readable for
 * whoever holds the handset next, and no screen in the app would ever show that it was there.
 *
 * The fix is one call. Which makes *where* it sits the entire substance of it, and the ordering
 * the only thing worth asserting: three of the four steps below are independently plausible in
 * any position, and every wrong order still ends with the user on the sign-in screen looking at
 * a sign-out that appears to have worked.
 *
 * There is no component-render harness in this repo, which is why `runSignOutTeardown` is a
 * plain async function rather than living inside the `signOut` callback. An ordering only React
 * can reach is an ordering no test can hold in place.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The single record of what happened and in what order. Counting calls would pass on every
 * sequence this file exists to rule out.
 */
const order = vi.hoisted(() => [] as string[]);

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      order.push(`removed:${key}`);
      values.delete(key);
    }),
  },
}));

/**
 * The one Expo native module in this import graph, stubbed so the rest of it can load for real.
 *
 * `@data/firebase/config` reads `Constants.expoConfig.extra`, and reaching the real
 * `expo-constants` under Node dies inside `expo-modules-core` on an `EventEmitter` that is not
 * there. Stubbing it here — rather than mocking our own modules that sit on top of it — is what
 * lets `importOriginal` below spread a module that would otherwise refuse to import at all.
 */
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));

// Native Google Sign-In: an Android module that cannot load under Node at all.
vi.mock('../src/services/auth/google', () => ({
  signOutOfGoogle: vi.fn(async () => {
    order.push('google');
  }),
}));

/**
 * `importOriginal` is spread into both of these rather than hand-listing the exports.
 *
 * A hand-written factory goes stale silently: the day production code imports one more symbol
 * from a module mocked this way, every test in the file fails on an undefined that has nothing
 * to do with what it was asserting. Only the two functions the teardown actually drives are
 * overridden; everything else stays real.
 */
const authHandle = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../src/data/firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  firebaseAuth: vi.fn(async () => authHandle.current),
}));

const firebase = vi.hoisted(() => ({
  signOut: async () => {
    order.push('firebase');
  },
}));
vi.mock('firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signOut: vi.fn(async () => {
    await firebase.signOut();
  }),
}));

import { runSignOutTeardown } from '../src/services/session-provider';

/** The key the restore path reads to decide whether a device identity may come back. */
const OFFLINE_ACTIVE_KEY = 'detact:v1:offline-active';

/** An adapter that records that its cache was dropped, and when. */
function cacheDropping(behaviour: () => Promise<void> = async () => {}) {
  return vi.fn(async () => {
    order.push('cache');
    await behaviour();
  });
}

beforeEach(() => {
  order.length = 0;
  values.clear();
  values.set(OFFLINE_ACTIVE_KEY, 'true');
  authHandle.current = { name: 'fake-auth' };
  firebase.signOut = async () => {
    order.push('firebase');
  };
});

describe('dropping the cached evidence at sign-out', () => {
  it('drops the adapter cache, and drops it last', async () => {
    const dropLocalCache = cacheDropping();

    await runSignOutTeardown({ dropLocalCache }, true);

    // The whole fix, in one assertion. The cache goes after every step that had to be
    // acknowledged first, and the three that were already here keep the order they had.
    expect(order).toEqual(['google', `removed:${OFFLINE_ACTIVE_KEY}`, 'firebase', 'cache']);
    expect(dropLocalCache).toHaveBeenCalledTimes(1);
  });

  it('waits for the Firebase sign-out to be acknowledged rather than racing it', async () => {
    // The assertion above would also pass if the drop were merely *started* last: with every
    // step resolving on an already-settled promise, "kicked off concurrently" and "awaited in
    // sequence" produce the same array. So this one holds the acknowledgement open.
    //
    // It matters because dropping the cache terminates the client the sign-out is still talking
    // to and discards whatever is still queued in it. A drop that overlaps an unacknowledged
    // sign-out leaves the store in a state neither operation describes.
    let release: () => void = () => {};
    // Resolves the moment the teardown is inside the sign-out and waiting on it. Counting
    // microtask turns instead would be guesswork: the steps before this one each `await
    // import(...)`, and module loading takes an unknown number of turns to settle.
    const inFlight = new Promise<void>((entered) => {
      firebase.signOut = () =>
        new Promise<void>((acknowledge) => {
          release = () => {
            order.push('firebase');
            acknowledge();
          };
          entered();
        });
    });

    const dropLocalCache = cacheDropping();
    const teardown = runSignOutTeardown({ dropLocalCache }, true);
    await inFlight;

    // Several turns of the microtask queue with the sign-out deliberately unacknowledged, so a
    // missing `await` would have had every chance to let the drop through early.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(dropLocalCache).not.toHaveBeenCalled();

    release();
    await teardown;

    expect(order).toEqual(['google', `removed:${OFFLINE_ACTIVE_KEY}`, 'firebase', 'cache']);
  });

  it('still clears the device before Firebase, which is what keeps the listener on signedOut', async () => {
    // Load-bearing and easy to lose. The auth listener fires on the Firebase sign-out and reads
    // `OFFLINE_ACTIVE_KEY` to decide whether a device identity may be restored; with the key
    // still set, it would quietly sign the user back in under a *different* `ownerId` instead of
    // landing on `signedOut`. The new call must not have moved either of these.
    await runSignOutTeardown({ dropLocalCache: cacheDropping() }, true);

    expect(order.indexOf('google')).toBeLessThan(order.indexOf(`removed:${OFFLINE_ACTIVE_KEY}`));
    expect(order.indexOf(`removed:${OFFLINE_ACTIVE_KEY}`)).toBeLessThan(order.indexOf('firebase'));
    expect(values.has(OFFLINE_ACTIVE_KEY)).toBe(false);
  });

  it('completes for an adapter that holds no cache to drop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // `dropLocalCache` is optional on the port. The device adapter is the store of record and
      // caches nothing behind itself, so it implements none — which is an adapter with nothing to
      // drop, not a failure. Hence `?.()` at the call site rather than a no-op on every adapter.
      await expect(runSignOutTeardown({}, true)).resolves.toBeUndefined();
      expect(order).toEqual(['google', `removed:${OFFLINE_ACTIVE_KEY}`, 'firebase']);

      // The load-bearing half. Resolving is not enough on its own: drop the `?.` and the call
      // throws a TypeError that the catch below it swallows into a warning, which resolves too
      // and looks identical from the outside. Silence here is what separates "this adapter has
      // nothing to drop" from "the drop failed and nobody noticed".
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the cache in local mode too, where there is no Firebase step to follow', async () => {
    const dropLocalCache = cacheDropping();

    await runSignOutTeardown({ dropLocalCache }, false);

    // Guarded by the port, not by whether a Firebase project is configured. An adapter that
    // caches is worth dropping either way, and the optional call already covers one that does not.
    expect(order).toEqual(['google', `removed:${OFFLINE_ACTIVE_KEY}`, 'cache']);
  });
});

describe('when the cache will not drop', () => {
  it('signs the user out anyway, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropLocalCache = cacheDropping(async () => {
      throw new Error('failed-precondition');
    });

    try {
      // Not a rejection. The caller's state updates run after this returns, and they are what
      // actually end the session — a throw here would strand the app on `signedIn` against a
      // credential Firebase has already revoked. A cache that would not drop must not also cost
      // the user the sign-out they asked for.
      await expect(runSignOutTeardown({ dropLocalCache }, true)).resolves.toBeUndefined();

      // But not silent either, which is where this parts company with the Google branch above.
      // A stale Google chooser is a nuisance; a cache that would not drop is exactly the
      // remanence this call exists to prevent, and this line is the only trace it leaves.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('[session]');
      expect(String(warn.mock.calls[0]?.[1])).toContain('failed-precondition');
    } finally {
      warn.mockRestore();
    }
  });
});
