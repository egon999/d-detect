import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions';
import { getFirebaseConfig, useFirebaseEmulator, firebaseEmulatorHost } from './config';

let appInstance: FirebaseApp | null = null;
let firestoreInstance: Firestore | null = null;
let storageInstance: FirebaseStorage | null = null;
let functionsInstance: Functions | null = null;

let emulatorsConnected = false;

export function getDetactApp(): FirebaseApp {
  if (appInstance) return appInstance;
  if (getApps().length > 0) {
    appInstance = getApp();
    return appInstance;
  }

  const config = getFirebaseConfig();
  if (!config) {
    throw new Error('Firebase configuration missing.');
  }

  appInstance = initializeApp(config);
  return appInstance;
}

export function getDetactFirestore(): Firestore {
  if (firestoreInstance) return firestoreInstance;
  const app = getDetactApp();
  const db = getFirestore(app);

  if (useFirebaseEmulator() && !emulatorsConnected) {
    try {
      const host = firebaseEmulatorHost();
      connectFirestoreEmulator(db, host, 8080);
      console.log(`[firebase] Firestore emulator connected at ${host}:8080`);
    } catch (e) {
      console.warn('[firebase] Firestore emulator connect failed or already connected:', e);
    }
  }

  firestoreInstance = db;
  return db;
}

export function getDetactStorage(): FirebaseStorage {
  if (storageInstance) return storageInstance;
  const app = getDetactApp();
  const storage = getStorage(app);

  if (useFirebaseEmulator()) {
    try {
      const host = firebaseEmulatorHost();
      connectStorageEmulator(storage, host, 9199);
      console.log(`[firebase] Storage emulator connected at ${host}:9199`);
    } catch (e) {
      console.warn('[firebase] Storage emulator connect failed or already connected:', e);
    }
  }

  storageInstance = storage;
  return storage;
}

export function getDetactFunctions(): Functions {
  if (functionsInstance) return functionsInstance;
  const app = getDetactApp();
  const functions = getFunctions(app, 'us-central1');

  if (useFirebaseEmulator()) {
    try {
      const host = firebaseEmulatorHost();
      connectFunctionsEmulator(functions, host, 5001);
      console.log(`[firebase] Functions emulator connected at ${host}:5001`);
    } catch (e) {
      console.warn('[firebase] Functions emulator connect failed or already connected:', e);
    }
  }

  functionsInstance = functions;
  return functions;
}
