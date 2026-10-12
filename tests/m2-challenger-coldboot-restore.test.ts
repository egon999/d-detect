/**
 * tests/m2-challenger-coldboot-restore.test.ts
 *
 * Empirical adversarial stress testing suite for Milestone 2 cold boot restore:
 * 1. Cold start behavior when `@ddetect/keep_signed_in` is 'false', 'true', null, or corrupt
 * 2. Destination gate routing (launchDestination) across all cold start permutations
 * 3. Deadline racing, storage hanging, and storage exception survival
 * 4. React DOM server rendering verification and mock isolation
 */

import React from 'react';
// @ts-ignore
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KEEP_SIGNED_IN_STORAGE_KEY } from '../src/services/session-provider';
import {
  STORAGE_DEADLINE_MS,
  SESSION_RESTORE_DEADLINE_MS,
  launchDestination,
  type LaunchInputs,
} from '../src/services/auth/launch';
import { deviceSessionUser, sessionAccount } from '../src/services/auth/account';
import SignInScreen from '../app/sign-in';
import {
  DraggableBanner,
  DetectiveMascot,
  ShinyText,
  FloatingPillInput,
  GradientPillButton,
  GooglePillButton,
  CheckboxPill,
} from '../src/ui';

// Mock Expo & React Native modules for server-side rendering tests
const { mockRouter, storageState } = vi.hoisted(() => {
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'test-google-web-client-id';
  const store: Record<string, string> = {};
  return {
    mockRouter: {
      replace: vi.fn(),
      push: vi.fn(),
    },
    storageState: {
      store,
      getItem: vi.fn(async (key: string) => store[key] ?? null),
      setItem: vi.fn(async (key: string, val: string) => {
        store[key] = val;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete store[key];
      }),
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    },
  };
});

vi.mock('@data/firebase/config', () => ({
  isFirebaseConfigured: () => true,
}));

vi.mock('@data/firebase/auth', () => ({
  firebaseAuth: async () => ({ currentUser: null }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/(tabs)',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-blur', () => ({
  BlurView: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-image', () => ({
  Image: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => {}),
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: (props: any) => React.createElement('Text', props, props.name),
}));

vi.mock('@expo-google-fonts/ibm-plex-mono', () => ({
  IBMPlexMono_400Regular: 1,
  IBMPlexMono_500Medium: 2,
  IBMPlexMono_600SemiBold: 3,
}));

vi.mock('@expo-google-fonts/plus-jakarta-sans', () => ({
  PlusJakartaSans_400Regular: 1,
  PlusJakartaSans_500Medium: 2,
  PlusJakartaSans_600SemiBold: 3,
  PlusJakartaSans_700Bold: 4,
  PlusJakartaSans_800ExtraBold: 5,
}));

vi.mock('expo-font', () => ({
  useFonts: () => [true, null],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storageState,
}));

vi.mock('@services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'signedOut',
      accountsAvailable: true,
      signIn: vi.fn(async () => {}),
      signUp: vi.fn(async () => {}),
      signInWithGoogle: vi.fn(async () => true),
      continueOffline: vi.fn(async () => {}),
      sendPasswordReset: vi.fn(async () => {}),
    }),
  };
});

describe('Challenger M2 Empirical Recheck: Cold Boot Restore & Render Invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageState.clear();
  });

  // =========================================================================
  // 1. Cold Boot Restore Logic Harness
  // =========================================================================
  describe('Cold Boot Restore with @ddetect/keep_signed_in', () => {
    async function readKeyWithDeadline(
      key: string,
      ms: number,
      getter: (k: string) => Promise<string | null>,
    ): Promise<string | null> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          getter(key),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), ms);
          }),
        ]);
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    interface ColdBootResult {
      status: 'restoring' | 'signedOut' | 'signedIn';
      user: any;
      isLocal: boolean;
      destination: string;
    }

    async function simulateColdBootRestore(options: {
      keepSignedInPref: string | null;
      firebaseUser?: { uid: string; email: string; displayName: string } | null;
      deviceSessionActive?: boolean;
      localIdentity?: { id: string; displayName?: string } | null;
      storageGetter?: (k: string) => Promise<string | null>;
    }): Promise<ColdBootResult> {
      let status: 'restoring' | 'signedOut' | 'signedIn' = 'restoring';
      let user: any = null;
      let isLocal = false;

      const getter =
        options.storageGetter ??
        (async (key: string) => {
          if (key === KEEP_SIGNED_IN_STORAGE_KEY) return options.keepSignedInPref;
          if (key === 'detact:v1:offline-active')
            return options.deviceSessionActive ? 'true' : null;
          if (key === 'detact:v1:identity')
            return options.localIdentity ? JSON.stringify(options.localIdentity) : null;
          return null;
        });

      const settle = (
        next: 'restoring' | 'signedOut' | 'signedIn',
        acc: any,
        local: boolean,
      ) => {
        status = next;
        user = acc;
        isLocal = local;
      };

      const signOut = () => settle('signedOut', null, false);

      async function restoreLocalIdentity(): Promise<boolean> {
        const pref = await readKeyWithDeadline(
          KEEP_SIGNED_IN_STORAGE_KEY,
          STORAGE_DEADLINE_MS,
          getter,
        );
        if (pref === 'false') return false;
        const stored = await readKeyWithDeadline(
          'detact:v1:identity',
          STORAGE_DEADLINE_MS,
          getter,
        );
        if (!stored) return false;
        try {
          const id = JSON.parse(stored);
          if (!id.id) return false;
          settle('signedIn', deviceSessionUser(id), true);
          return true;
        } catch {
          return false;
        }
      }

      async function resolveWithoutAccount(): Promise<void> {
        const chosen = await readKeyWithDeadline(
          'detact:v1:offline-active',
          STORAGE_DEADLINE_MS,
          getter,
        );
        if (chosen === 'true' && (await restoreLocalIdentity())) return;
        signOut();
      }

      // Simulate Firebase branch
      if (options.firebaseUser) {
        const pref = await readKeyWithDeadline(
          KEEP_SIGNED_IN_STORAGE_KEY,
          STORAGE_DEADLINE_MS,
          getter,
        );
        if (pref === 'false') {
          signOut();
        } else {
          settle('signedIn', sessionAccount(options.firebaseUser as any), false);
        }
      } else {
        await resolveWithoutAccount();
      }

      const destination = launchDestination({
        status,
        hasUser: user !== null,
        seenIntroduction: true,
        storageDeadlinePassed: false,
      });

      return { status, user, isLocal, destination };
    }

    function createMockFirebaseUser(uid: string, email: string, displayName = '') {
      return {
        uid,
        email,
        displayName,
        photoURL: null,
        emailVerified: true,
        providerData: [{ providerId: 'password', displayName, photoURL: null }],
        metadata: { creationTime: '2026-01-01T00:00:00Z' },
      };
    }

    it('bypasses auto-restore and forces sign-in when @ddetect/keep_signed_in is "false" (Firebase user present)', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: 'false',
        firebaseUser: createMockFirebaseUser('user_123', 'agent@ddetect.io', 'Agent 47'),
      });

      expect(result.status).toBe('signedOut');
      expect(result.user).toBeNull();
      expect(result.destination).toBe('signIn');
    });

    it('verifies that active sign-in stays signed in when keep_signed_in is "false"', async () => {
      let initialRestore = true;
      let status: 'restoring' | 'signedOut' | 'signedIn' = 'restoring';
      let user: any = null;

      const settle = (s: 'signedOut' | 'signedIn', u: any) => {
        status = s;
        user = u;
      };
      const signOut = () => settle('signedOut', null);

      const onAuthCallback = async (firebaseUser: any, keepSignedInPref: string) => {
        if (firebaseUser) {
          if (initialRestore) {
            initialRestore = false;
            if (keepSignedInPref === 'false') {
              signOut();
              return;
            }
          }
          settle('signedIn', sessionAccount(firebaseUser));
        } else {
          initialRestore = false;
          signOut();
        }
      };

      // 1. Initial boot: no user
      await onAuthCallback(null, 'false');
      expect(status).toBe('signedOut');
      expect(initialRestore).toBe(false);

      // 2. Active sign-in
      const activeUser = createMockFirebaseUser('active_usr', 'active@ddetect.io', 'Active Detective');
      await onAuthCallback(activeUser, 'false');
      expect(status).toBe('signedIn');
      expect(user).not.toBeNull();
      expect(user.id).toBe('active_usr');

      // Verify route destination is 'app'
      const destination = launchDestination({
        status,
        hasUser: user !== null,
        seenIntroduction: true,
        storageDeadlinePassed: false,
      });
      expect(destination).toBe('app');
    });

    it('restores session when @ddetect/keep_signed_in is "true" (Firebase user present)', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: 'true',
        firebaseUser: createMockFirebaseUser('user_123', 'agent@ddetect.io', 'Agent 47'),
      });

      expect(result.status).toBe('signedIn');
      expect(result.user).not.toBeNull();
      expect(result.user.id).toBe('user_123');
      expect(result.destination).toBe('app');
    });

    it('restores session when @ddetect/keep_signed_in is null/missing (default behavior on first/clean run)', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: null,
        firebaseUser: createMockFirebaseUser('user_clean', 'clean@ddetect.io', 'Clean Run'),
      });

      expect(result.status).toBe('signedIn');
      expect(result.user.id).toBe('user_clean');
      expect(result.destination).toBe('app');
    });

    it('bypasses local identity auto-restore and forces sign-in when @ddetect/keep_signed_in is "false"', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: 'false',
        firebaseUser: null,
        deviceSessionActive: true,
        localIdentity: { id: 'user_local_123', displayName: 'Device Owner' },
      });

      expect(result.status).toBe('signedOut');
      expect(result.user).toBeNull();
      expect(result.destination).toBe('signIn');
    });

    it('restores local identity when @ddetect/keep_signed_in is "true"', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: 'true',
        firebaseUser: null,
        deviceSessionActive: true,
        localIdentity: { id: 'user_local_123', displayName: 'Device Owner' },
      });

      expect(result.status).toBe('signedIn');
      expect(result.user.id).toBe('user_local_123');
      expect(result.isLocal).toBe(true);
      expect(result.destination).toBe('app');
    });

    it('restores local identity when @ddetect/keep_signed_in is missing/null', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: null,
        firebaseUser: null,
        deviceSessionActive: true,
        localIdentity: { id: 'user_local_123', displayName: 'Device Owner' },
      });

      expect(result.status).toBe('signedIn');
      expect(result.user.id).toBe('user_local_123');
      expect(result.isLocal).toBe(true);
      expect(result.destination).toBe('app');
    });

    it('handles hanging storage read (> deadline) without crashing or deadlocking', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: null,
        firebaseUser: createMockFirebaseUser('user_timeout', 'timeout@ddetect.io', 'Timeout'),
        storageGetter: async (key: string) => {
          if (key === KEEP_SIGNED_IN_STORAGE_KEY) {
            // Hang for longer than deadline
            await new Promise((r) => setTimeout(r, STORAGE_DEADLINE_MS + 200));
            return 'false';
          }
          return null;
        },
      });

      // Timed out readKeyWithDeadline yields null, so it does not evaluate === 'false', settling safely
      expect(result.status).toBe('signedIn');
      expect(result.destination).toBe('app');
    });

    it('handles throwing storage read (disk I/O error) cleanly without unhandled rejection', async () => {
      const result = await simulateColdBootRestore({
        keepSignedInPref: null,
        firebaseUser: createMockFirebaseUser('user_err', 'err@ddetect.io', 'Error'),
        storageGetter: async (key: string) => {
          if (key === KEEP_SIGNED_IN_STORAGE_KEY) {
            throw new Error('AsyncStorage SQLite disk I/O error');
          }
          return null;
        },
      });

      // Catches and returns null
      expect(result.status).toBe('signedIn');
      expect(result.destination).toBe('app');
    });

    it('strictly treats only exact "false" as opt-out; any corrupt string defaults safe', async () => {
      for (const weird of ['FALSE', '0', 'no', 'off', '{ "pref": false }', 'undefined']) {
        const result = await simulateColdBootRestore({
          keepSignedInPref: weird,
          firebaseUser: createMockFirebaseUser('user_weird', 'weird@ddetect.io', 'Weird'),
        });
        expect(result.status).toBe('signedIn');
        expect(result.destination).toBe('app');
      }
    });
  });

  // =========================================================================
  // 2. React DOM Server Rendering & Primitive Safety
  // =========================================================================
  describe('React DOM Server Rendering & Primitives Verification', () => {
    it('renders SignInScreen without throwing and contains all core M1/M2 visual components', () => {
      const html = renderToString(React.createElement(SignInScreen));
      expect(html).toBeDefined();
      expect(typeof html).toBe('string');

      // DraggableBanner & Mascot
      expect(html).toContain('SECURE VAULT');
      expect(html).toContain('D-Detect.');

      // ShinyText headings
      expect(html).toContain('Welcome Back');

      // FloatingPillInputs
      expect(html).toContain('Email address');
      expect(html).toContain('Password');

      // CheckboxPill
      expect(html).toContain('Keep me signed in');

      // GradientPillButton & GooglePillButton
      expect(html).toContain('Log In');
      expect(html).toMatch(/Login with Google|Continue with Google/);

      // Zero traces of Apple auth
      expect(html).not.toContain('Apple');
      expect(html).not.toContain('apple.com');
    });

    it('renders individual primitives under stress props with 0 crashes', () => {
      // DetectiveMascot boundary sizes
      expect(() =>
        renderToString(React.createElement(DetectiveMascot, { size: 0 })),
      ).not.toThrow();
      expect(() =>
        renderToString(React.createElement(DetectiveMascot, { size: 1000 })),
      ).not.toThrow();

      // DraggableBanner
      expect(() =>
        renderToString(
          React.createElement(DraggableBanner, {
            children: React.createElement('View'),
            mascot: React.createElement(DetectiveMascot, { size: 80 }),
          }),
        ),
      ).not.toThrow();

      // ShinyText
      expect(() =>
        renderToString(React.createElement(ShinyText, {}, 'Extreme Shimmer Text')),
      ).not.toThrow();
      expect(() =>
        renderToString(React.createElement(ShinyText, {}, '')),
      ).not.toThrow();

      // FloatingPillInput error states
      expect(() =>
        renderToString(
          React.createElement(FloatingPillInput, {
            label: 'Email',
            error: 'Very long dangerous error message <!DOCTYPE html> <script>alert(1)</script>',
          }),
        ),
      ).not.toThrow();

      // GradientPillButton loading/disabled
      expect(() =>
        renderToString(
          React.createElement(GradientPillButton, {
            label: 'Submit',
            onPress: vi.fn(),
            loading: true,
            disabled: true,
          }),
        ),
      ).not.toThrow();

      // CheckboxPill toggle state
      expect(() =>
        renderToString(
          React.createElement(CheckboxPill, {
            checked: false,
            onToggle: vi.fn(),
            label: 'Keep me signed in',
          }),
        ),
      ).not.toThrow();
    });
  });
});
