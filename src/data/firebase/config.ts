/**
 * Firebase configuration.
 *
 * Values come from `EXPO_PUBLIC_FIREBASE_*` environment variables, which Expo inlines at
 * build time from `.env`. See `.env.example` for the full list.
 *
 * These are **not secrets**. The Firebase web config is a public identifier — it says
 * which project to talk to, nothing more. What actually protects the data is Firestore
 * Security Rules (`rules/firestore.rules`) and Storage Rules (`rules/storage.rules`),
 * which is why `EXPO_PUBLIC_` is the correct prefix for all of them.
 *
 * What must never appear here is a service-account JSON or any other credential that
 * grants administrative access. Model-provider keys are handled separately in
 * `src/services/ai/credentials.ts`, which holds a user-supplied key in the platform
 * keystore and reads nothing from the environment — no AI key ships in the bundle. That
 * file documents the reasoning in full.
 */

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

/**
 * Every variable spelled out as a *static* `process.env.EXPO_PUBLIC_FIREBASE_X` expression.
 *
 * This verbosity is load-bearing, not a style choice. Expo inlines environment variables at
 * build time by textually substituting static dot-notation references, and the docs are
 * explicit that alternative forms — `process.env['KEY']`, or destructuring — are not
 * supported and will not be inlined.
 *
 * This file previously read them through a computed key, ``process.env[`..._${key}`]``,
 * which the bundler cannot see. Confirmed against a release APK: not one of the six values
 * appeared in `index.android.bundle`, so every lookup returned `undefined` on device and
 * the config was resolved entirely by the `extra` fallback below. That worked, but by
 * accident — deleting the `extra` block from `app.json` (a reasonable thing to do once
 * `.env` exists) would have silently dropped the app into local-only mode with no error.
 */
const ENV: Record<RequiredKey, string | undefined> = {
  API_KEY: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  AUTH_DOMAIN: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  PROJECT_ID: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  STORAGE_BUCKET: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  MESSAGING_SENDER_ID: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  APP_ID: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

/**
 * Reads one value, preferring `.env` and falling back to `app.json`'s `extra` block.
 *
 * The `extra` fallback is kept deliberately: `app.json` is committed while `.env` is not,
 * so it is what makes the project buildable by someone who clones the repo — and it is
 * shipped inside the APK as `assets/app.config`, which is where the values actually came
 * from before the bug above was fixed.
 */
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

/**
 * The resolved config, or `null` when the app is running without a Firebase project.
 *
 * Returning `null` rather than throwing is deliberate: the app is fully usable offline and
 * this is the state it is developed and demonstrated in. Firebase is an optional backend,
 * not a boot requirement.
 */
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

  // All-or-nothing: a partially configured project produces confusing runtime errors that
  // look like bugs in the app, so an incomplete config is treated as no config.
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

/**
 * Whether a Firebase project is configured.
 *
 * Synchronous and side-effect free, because the repository provider needs to answer this
 * before it can decide which adapter to build.
 */
export function isFirebaseConfigured(): boolean {
  return getFirebaseConfig() !== null;
}

/** Names of the variables that are missing, for the diagnostics screen. Never their values. */
export function missingFirebaseKeys(): string[] {
  return REQUIRED_KEYS.filter((key) => !read(key)).map(
    (key) => `EXPO_PUBLIC_FIREBASE_${key}`,
  );
}

// ---------------------------------------------------------------------------
// Emulator routing
// ---------------------------------------------------------------------------

/**
 * Whether to route Firebase at the local Emulator Suite.
 *
 * Both spellings and any truthy value are accepted, and that tolerance is the fix for a
 * real trap rather than politeness. `.env.example` documented
 * `EXPO_PUBLIC_USE_FIREBASE_EMULATOR=1`, while the only reader in the codebase tested
 * `EXPO_PUBLIC_USE_FIREBASE_EMULATORS === 'true'` — plural name, string value, both
 * different. Following the documented instruction therefore did nothing visible: the app
 * kept talking to the **production** project while the developer believed every write was
 * landing in a throwaway emulator. Silent-wrong-target is the worst failure mode a flag
 * like this can have, so it now answers to either name and to `1`, `true` or `yes`.
 *
 * Both variables are read as static dot-notation expressions because that is the only
 * form Expo's build-time inliner substitutes — see the note on `ENV` above.
 */
export function useFirebaseEmulator(): boolean {
  const flag =
    process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATOR ??
    process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATORS;
  return flag !== undefined && /^(1|true|yes)$/i.test(flag.trim());
}

/**
 * Host for the Emulator Suite. Validated, because it is interpolated into a URL.
 *
 * A host that fails the check falls back to loopback rather than throwing. Throwing here
 * used to take down `firebaseAuth()`, which every sign-in path awaits — a typo in a
 * development-only variable would have looked like the account system being broken.
 */
export function firebaseEmulatorHost(): string {
  const raw = process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST?.trim();
  if (!raw) return '127.0.0.1';
  if (!/^[A-Za-z0-9.-]+$/.test(raw)) {
    console.warn('[firebase] ignoring invalid EXPO_PUBLIC_FIREBASE_EMULATOR_HOST, using 127.0.0.1');
    return '127.0.0.1';
  }
  return raw;
}
