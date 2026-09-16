/**
 * Firebase Auth, initialised for React Native.
 *
 * This module exists because `getAuth()` is the wrong call on React Native, and the way
 * it is wrong is invisible: it succeeds, logs a warning into a console nobody reads in a
 * release build, and silently gives you **in-memory persistence**. The user signs up, uses
 * the app, kills it, reopens it — and is signed out, with no error anywhere. Every case
 * they created is still in Firestore under a `uid` the app can no longer produce.
 *
 * `initializeAuth` with `getReactNativePersistence(AsyncStorage)` is the supported fix.
 * Verified against `node_modules/@firebase/auth/dist/rn/index.rn.d.ts` (v12.x), which
 * exports both `initializeAuth` and `getReactNativePersistence` from the `react-native`
 * entry point of `firebase/auth`.
 *
 * ## Why everything here is defensive
 *
 * This runs during boot. A throw here used to mean the splash screen never lifted, because
 * the layout that hides it sits below the provider that calls this. So every failure path
 * returns `null` and lets the app continue in local mode — a user who cannot reach the
 * cloud still gets a working app, which is the entire point of the local repository
 * adapter. Nothing in this file is allowed to be fatal.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';

import { firebaseEmulatorHost, getFirebaseConfig, useFirebaseEmulator } from './config';

/**
 * The initialised app, or null when there is no usable config.
 *
 * Idempotent: `getApps()` is checked first, because Fast Refresh re-runs module scope and a
 * second `initializeApp` with the same name throws `app/duplicate-app`.
 */
export function firebaseApp(): FirebaseApp | null {
  try {
    if (getApps().length > 0) return getApp();

    const config = getFirebaseConfig();
    if (!config) return null;

    return initializeApp(config);
  } catch (error) {
    console.warn('[firebase] app init failed:', describe(error));
    return null;
  }
}

let cachedAuth: Auth | null | undefined;

let emulatorConnected = false;
async function connectDevelopmentAuth(auth: Auth): Promise<Auth> {
  if (useFirebaseEmulator() && !emulatorConnected) {
    const { connectAuthEmulator } = await import('firebase/auth');
    connectAuthEmulator(auth, `http://${firebaseEmulatorHost()}:9099`, { disableWarnings: true });
    emulatorConnected = true;
  }
  return auth;
}

/**
 * The Auth instance, with persistence that survives a restart.
 *
 * Returns `null` rather than throwing when Firebase is unconfigured or unreachable, so
 * callers can fall back to the device-local identity.
 *
 * The result is cached — including a cached `null` — because `initializeAuth` throws
 * `auth/already-initialized` on a second call for the same app, and a failed attempt
 * should not be retried on every render.
 */
export async function firebaseAuth(): Promise<Auth | null> {
  if (cachedAuth !== undefined) return cachedAuth;

  try {
    const app = firebaseApp();
    if (!app) {
      cachedAuth = null;
      return null;
    }

    const mod = await import('firebase/auth');

    // `getReactNativePersistence` is only present on the react-native entry point. On web
    // the bundler resolves `firebase/auth` to the browser build, where it is undefined and
    // the SDK's own default (localStorage) is already correct — so its absence is a
    // supported case, not an error.
    type Persistence = NonNullable<Parameters<typeof mod.initializeAuth>[1]>['persistence'];
    const rnPersistence = (
      mod as unknown as {
        getReactNativePersistence?: (store: unknown) => Persistence;
      }
    ).getReactNativePersistence;

    if (typeof rnPersistence === 'function') {
      try {
        cachedAuth = await connectDevelopmentAuth(mod.initializeAuth(app, { persistence: rnPersistence(AsyncStorage) }));
        return cachedAuth;
      } catch (error) {
        // `auth/already-initialized` means something else got there first — which is fine,
        // that instance already has persistence. Any other error falls through to getAuth.
        if (!String(describe(error)).includes('already-initialized')) {
          console.warn('[firebase] initializeAuth failed, falling back:', describe(error));
        }
      }
    }

    cachedAuth = await connectDevelopmentAuth(mod.getAuth(app));
    return cachedAuth;
  } catch (error) {
    console.warn('[firebase] auth unavailable:', describe(error));
    cachedAuth = null;
    return null;
  }
}

/** An error's message without its stack, which is noise in a release log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}
