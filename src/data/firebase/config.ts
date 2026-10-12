import Constants from 'expo-constants';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

const REQUIRED_KEYS = [
  'API_KEY',
  'AUTH_DOMAIN',
  'PROJECT_ID',
  'STORAGE_BUCKET',
  'MESSAGING_SENDER_ID',
  'APP_ID',
] as const;

type RequiredKey = (typeof REQUIRED_KEYS)[number];

const ENV: Record<RequiredKey, string | undefined> = {
  API_KEY: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  AUTH_DOMAIN: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  PROJECT_ID: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  STORAGE_BUCKET: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  MESSAGING_SENDER_ID: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  APP_ID: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

function read(key: RequiredKey): string | undefined {
  const fromEnv = ENV[key];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const firebase = extra?.firebase as Record<string, unknown> | undefined;
  const value = firebase?.[camelCase(key)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function camelCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

export function getFirebaseConfig(): FirebaseConfig | null {
  const values: Partial<Record<RequiredKey, string>> = {};
  let missing = 0;

  for (const key of REQUIRED_KEYS) {
    const value = read(key);
    if (value) {
      values[key] = value;
    } else {
      missing += 1;
    }
  }

  if (missing > 0) return null;

  return {
    apiKey: values.API_KEY!,
    authDomain: values.AUTH_DOMAIN!,
    projectId: values.PROJECT_ID!,
    storageBucket: values.STORAGE_BUCKET!,
    messagingSenderId: values.MESSAGING_SENDER_ID!,
    appId: values.APP_ID!,
  };
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseConfig() !== null;
}

export function missingFirebaseKeys(): string[] {
  return REQUIRED_KEYS.filter((key) => !read(key)).map(
    (key) => `EXPO_PUBLIC_FIREBASE_${key}`,
  );
}

export function useFirebaseEmulator(): boolean {
  const flag =
    process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATOR ??
    process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATORS;
  return flag !== undefined && /^(1|true|yes)$/i.test(flag.trim());
}

const LOOPBACK_HOST = '127.0.0.1';

export function firebaseEmulatorHost(): string {
  const raw = process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST?.trim();
  if (!raw) return LOOPBACK_HOST;
  if (!/^[A-Za-z0-9.-]+$/.test(raw)) {
    console.warn(
      `[firebase] ignoring invalid EXPO_PUBLIC_FIREBASE_EMULATOR_HOST, using ${LOOPBACK_HOST}`,
    );
    return LOOPBACK_HOST;
  }
  return raw;
}
