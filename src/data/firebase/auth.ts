import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';

import { firebaseEmulatorHost, getFirebaseConfig, useFirebaseEmulator } from './config';

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

export async function firebaseAuth(): Promise<Auth | null> {
  if (cachedAuth !== undefined) return cachedAuth;

  try {
    const app = firebaseApp();
    if (!app) {
      cachedAuth = null;
      return null;
    }

    const mod = await import('firebase/auth');

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

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}
