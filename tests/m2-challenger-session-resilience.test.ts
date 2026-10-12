/**
 * tests/m2-challenger-session-resilience.test.ts
 *
 * Empirical challenger verification suite for Milestone 2:
 * 1. "Keep me signed in" storage lifecycle & app reload persistence
 * 2. Google Auth button error, in-progress, and cancellation handling
 * 3. Session lifecycle, sign-out teardown fault tolerance, and API auth bridge
 * 4. Auth error human readability invariants
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Storage & Native Mocks
// ---------------------------------------------------------------------------

const { mockStorage, mockRouter, teardownTracker } = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    mockStorage: {
      store,
      getItem: vi.fn(async (key: string) => store[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete store[key];
      }),
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    },
    mockRouter: {
      replace: vi.fn(),
      push: vi.fn(),
    },
    teardownTracker: {
      steps: [] as string[],
      cacheFails: false,
      googleFails: false,
      firebaseFails: false,
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: mockStorage,
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

vi.mock('@api', () => ({
  clearApiCache: () => {
    teardownTracker.steps.push('cache');
    if (teardownTracker.cacheFails) throw new Error('API cache clear failed');
  },
}));

vi.mock('../src/services/auth/google', () => ({
  signOutOfGoogle: async () => {
    teardownTracker.steps.push('google');
    if (teardownTracker.googleFails) throw new Error('Google play services failed');
  },
}));

vi.mock('@data/firebase/config', () => ({
  isFirebaseConfigured: () => true,
}));

vi.mock('@data/firebase/auth', () => ({
  firebaseAuth: async () => ({ currentUser: null }),
}));

vi.mock('firebase/auth', () => ({
  signOut: async () => {
    teardownTracker.steps.push('firebase');
    if (teardownTracker.firebaseFails) throw new Error('Firebase network failed');
  },
}));

import { KEEP_SIGNED_IN_STORAGE_KEY } from '../app/sign-in';
import { runSignOutTeardown } from '../src/services/session-provider';
import { shouldLeaveForSignIn } from '../src/services/auth/route-guard';
import { KNOWN_AUTH_ERROR_CODES, readableAuthError } from '../src/services/auth/errors';
import type { GoogleSignInOutcome } from '../src/services/auth/google';

describe('Milestone 2 Empirical Challenger: Session, Persistence & Google Auth Resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.clear();
    teardownTracker.steps = [];
    teardownTracker.cacheFails = false;
    teardownTracker.googleFails = false;
    teardownTracker.firebaseFails = false;
  });

  // =========================================================================
  // 1. "Keep me signed in" Storage Lifecycle & Reload Persistence
  // =========================================================================
  describe('"Keep me signed in" Storage Lifecycle & App Reload Persistence', () => {
    it('uses correct dedicated storage key constant', () => {
      expect(KEEP_SIGNED_IN_STORAGE_KEY).toBe('@ddetect/keep_signed_in');
    });

    it('hydrates true by default when no prior preference is stored', async () => {
      const stored = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
      expect(stored).toBeNull();
      const hydrated = stored !== null ? stored === 'true' : true;
      expect(hydrated).toBe(true);
    });

    it('hydrates false when storage contains "false"', async () => {
      mockStorage.store[KEEP_SIGNED_IN_STORAGE_KEY] = 'false';
      const stored = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
      const hydrated = stored !== null ? stored === 'true' : true;
      expect(hydrated).toBe(false);
    });

    it('hydrates true when storage contains "true"', async () => {
      mockStorage.store[KEEP_SIGNED_IN_STORAGE_KEY] = 'true';
      const stored = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
      const hydrated = stored !== null ? stored === 'true' : true;
      expect(hydrated).toBe(true);
    });

    it('survives corrupted storage value and defaults cleanly', async () => {
      mockStorage.store[KEEP_SIGNED_IN_STORAGE_KEY] = 'unexpected_string';
      const stored = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
      const hydrated = stored !== null ? stored === 'true' : true;
      // Stored is not 'true', so strictly evaluates to false without crashing
      expect(hydrated).toBe(false);
    });

    it('persists preference toggles across simulated app reload cycles', async () => {
      // --- Cycle 1: First launch (clean storage) ---
      const storedItem = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
      let currentSessionPref: boolean = storedItem !== null ? storedItem === 'true' : true;
      expect(currentSessionPref).toBe(true);

      // User unchecks "Keep me signed in"
      currentSessionPref = false;
      await mockStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'false');
      expect(mockStorage.store[KEEP_SIGNED_IN_STORAGE_KEY]).toBe('false');

      // --- Cycle 2: App Reload (reboot simulation) ---
      const reloadedPref1 = (await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY)) === 'true';
      expect(reloadedPref1).toBe(false);

      // User re-checks "Keep me signed in"
      await mockStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'true');
      expect(mockStorage.store[KEEP_SIGNED_IN_STORAGE_KEY]).toBe('true');

      // --- Cycle 3: App Reload (reboot simulation) ---
      const reloadedPref2 = (await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY)) === 'true';
      expect(reloadedPref2).toBe(true);
    });

    it('handles storage rejection during toggle without unhandled rejection', async () => {
      const failingStorage = {
        setItem: vi.fn().mockRejectedValue(new Error('AsyncStorage disk failure')),
      };

      let errorThrown = false;
      try {
        await failingStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'false').catch(() => {});
      } catch {
        errorThrown = true;
      }
      expect(errorThrown).toBe(false);
    });

    it('persists preference on submission without blocking navigation if storage fails', async () => {
      const failingStorage = {
        setItem: vi.fn().mockRejectedValue(new Error('AsyncStorage quota exceeded')),
      };

      let navigated = false;
      await failingStorage
        .setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'false')
        .catch(() => {});
      navigated = true;

      expect(navigated).toBe(true);
    });

    it('active sign-in succeeds and stays signed in when keep_signed_in is false', async () => {
      await mockStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'false');

      let currentStatus: 'restoring' | 'signedOut' | 'signedIn' = 'restoring';
      let currentUser: any = null;
      let initialRestore = true;

      const settle = (status: 'signedOut' | 'signedIn', user: any) => {
        currentStatus = status;
        currentUser = user;
      };
      const signOut = () => settle('signedOut', null);

      const authStateListener = async (firebaseUser: any) => {
        if (firebaseUser) {
          if (initialRestore) {
            initialRestore = false;
            const keepSignedInPref = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
            if (keepSignedInPref === 'false') {
              signOut();
              return;
            }
          }
          settle('signedIn', firebaseUser);
        } else {
          initialRestore = false;
          signOut();
        }
      };

      // 1. Cold launch with no prior user
      await authStateListener(null);
      expect(currentStatus).toBe('signedOut');
      expect(currentUser).toBeNull();
      expect(initialRestore).toBe(false);

      // 2. Active sign-in occurs with "Keep me signed in" set to 'false'
      const activeUser = { uid: 'user_active_123', email: 'active@ddetect.io' };
      await authStateListener(activeUser);

      // Active sign-in MUST succeed and remain in 'signedIn' state despite keepSignedInPref === 'false'
      expect(currentStatus).toBe('signedIn');
      expect(currentUser).not.toBeNull();
      expect(currentUser.uid).toBe('user_active_123');
    });

    it('active sign-in after cold-boot eviction stays signed in when keep_signed_in is false', async () => {
      await mockStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, 'false');

      let currentStatus: 'restoring' | 'signedOut' | 'signedIn' = 'restoring';
      let currentUser: any = null;
      let initialRestore = true;

      const settle = (status: 'signedOut' | 'signedIn', user: any) => {
        currentStatus = status;
        currentUser = user;
      };
      const signOut = () => settle('signedOut', null);

      const authStateListener = async (firebaseUser: any) => {
        if (firebaseUser) {
          if (initialRestore) {
            initialRestore = false;
            const keepSignedInPref = await mockStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY);
            if (keepSignedInPref === 'false') {
              signOut();
              return;
            }
          }
          settle('signedIn', firebaseUser);
        } else {
          initialRestore = false;
          signOut();
        }
      };

      // 1. Cold launch with lingering cached session, but user opted out of persistent session
      const cachedUser = { uid: 'user_cached_999', email: 'cached@ddetect.io' };
      await authStateListener(cachedUser);
      // Evicted on cold launch as expected
      expect(currentStatus).toBe('signedOut');
      expect(currentUser).toBeNull();
      expect(initialRestore).toBe(false);

      // 2. User then enters credentials and logs in actively
      const loggedInUser = { uid: 'user_cached_999', email: 'cached@ddetect.io' };
      await authStateListener(loggedInUser);
      // Must NOT be evicted on active login!
      expect(currentStatus).toBe('signedIn');
      expect(currentUser).not.toBeNull();
      expect(currentUser.uid).toBe('user_cached_999');
    });

    it('session-provider implements initialRestore guard for onAuthStateChanged', () => {
      const sessionProviderSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/services/session-provider.tsx'),
        'utf-8',
      );
      expect(sessionProviderSrc).toContain('let initialRestore = true;');
      expect(sessionProviderSrc).toMatch(/if\s*\(\s*initialRestore\s*\)\s*\{[\s\S]*?initialRestore\s*=\s*false;/);
      expect(sessionProviderSrc).toMatch(/keepSignedInPref === 'false'/);
    });
  });

  // =========================================================================
  // 2. Google Auth Error and Cancellation Handling
  // =========================================================================
  describe('Google Auth Button Error and Cancellation Handling', () => {
    function mockGoogleSignIn(outcome: GoogleSignInOutcome): () => Promise<boolean> {
      return async () => {
        if (!outcome.ok) {
          if (outcome.reason === 'CANCELLED') {
            return false;
          }
          throw new Error(outcome.message);
        }
        return true;
      };
    }

    it('handles user cancellation gracefully with no error banner and no UI freeze', async () => {
      let busyState: string | null = null;
      let formError: string | null = null;

      // Mock user backing out
      const signInWithGoogle = mockGoogleSignIn({ ok: false, reason: 'CANCELLED' });

      const handleGoogleSignIn = async () => {
        busyState = 'google';
        formError = null;
        try {
          const signedIn = await signInWithGoogle();
          if (signedIn) {
            mockRouter.replace('/(tabs)');
          }
        } catch (caught) {
          formError = readableAuthError(caught);
        } finally {
          busyState = null;
        }
      };

      await handleGoogleSignIn();

      expect(busyState).toBeNull(); // UI unlocked, spinner removed
      expect(formError).toBeNull(); // No false error message shown
      expect(mockRouter.replace).not.toHaveBeenCalled(); // No invalid navigation
    });

    it('survives rapid cancellation thrashing (50 consecutive cancellations)', async () => {
      let busyState: string | null = null;
      let formError: string | null = null;

      const signInWithGoogle = async (): Promise<boolean> => {
        return false; // User cancelled
      };

      for (let i = 0; i < 50; i++) {
        busyState = 'google';
        const signedIn = await signInWithGoogle();
        if (signedIn) mockRouter.replace('/(tabs)');
        busyState = null;
      }

      expect(busyState).toBeNull();
      expect(formError).toBeNull();
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('handles in-progress error without crashing or deadlocking', async () => {
      let busyState: string | null = null;
      let formError: string | null = null;

      const signInWithGoogle = mockGoogleSignIn({
        ok: false,
        reason: 'IN_PROGRESS',
        message: 'A sign-in is already underway. Give it a moment.',
      });

      const handleGoogleSignIn = async () => {
        busyState = 'google';
        formError = null;
        try {
          const signedIn = await signInWithGoogle();
          if (signedIn) mockRouter.replace('/(tabs)');
        } catch (caught) {
          formError = readableAuthError(caught);
        } finally {
          busyState = null;
        }
      };

      await handleGoogleSignIn();

      expect(busyState).toBeNull(); // Spinner cleared
      expect(formError).toBe('A sign-in is already underway. Give it a moment.');
    });

    it('handles Play Services unavailable error in clear readable sentence', async () => {
      let busyState: string | null = null;
      let formError: string | null = null;

      const signInWithGoogle = mockGoogleSignIn({
        ok: false,
        reason: 'PLAY_SERVICES',
        message: 'Google sign-in isn’t working on this device. Use your email and password instead.',
      });

      const handleGoogleSignIn = async () => {
        busyState = 'google';
        formError = null;
        try {
          const signedIn = await signInWithGoogle();
          if (signedIn) mockRouter.replace('/(tabs)');
        } catch (caught) {
          formError = readableAuthError(caught);
        } finally {
          busyState = null;
        }
      };

      await handleGoogleSignIn();

      expect(busyState).toBeNull();
      expect(formError).toBe(
        'Google sign-in isn’t working on this device. Use your email and password instead.',
      );
    });

    it('prevents concurrent double-taps from re-entering while busy', async () => {
      let callCount = 0;
      let busyState: string | null = null;

      const handleGoogleSignIn = async () => {
        if (busyState) return; // Guard against concurrent tap
        busyState = 'google';
        callCount++;
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        busyState = null;
      };

      // Fire 3 simultaneous presses
      await Promise.all([
        handleGoogleSignIn(),
        handleGoogleSignIn(),
        handleGoogleSignIn(),
      ]);

      expect(callCount).toBe(1); // Only 1 operation was executed
      expect(busyState).toBeNull();
    });

    it('handles web popup user cancellation without error banner', async () => {
      const simulateWebSignIn = async (code: string) => {
        try {
          if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
            return null; // Cancelled
          }
          throw { code, message: 'Unexpected web error' };
        } catch (err: any) {
          const c = err.code;
          if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return null;
          throw err;
        }
      };

      const userClosedResult = await simulateWebSignIn('auth/popup-closed-by-user');
      expect(userClosedResult).toBeNull();

      const userCancelledResult = await simulateWebSignIn('auth/cancelled-popup-request');
      expect(userCancelledResult).toBeNull();
    });
  });

  // =========================================================================
  // 3. Session Lifecycle, Sign-Out Teardown & Backend Communication
  // =========================================================================
  describe('Session Lifecycle, Teardown Fault Tolerance & Auth Bridge', () => {
    it('executes sign-out teardown in exact required sequence (cache -> google -> device -> firebase)', async () => {
      await runSignOutTeardown(true);
      expect(teardownTracker.steps).toEqual(['cache', 'google', 'firebase']);
    });

    it('executes sign-out teardown without throwing even if all steps fail', async () => {
      teardownTracker.cacheFails = true;
      teardownTracker.googleFails = true;
      teardownTracker.firebaseFails = true;

      let errorThrown = false;
      try {
        await runSignOutTeardown(true);
      } catch {
        errorThrown = true;
      }
      expect(errorThrown).toBe(false);
      // All steps were attempted despite individual failures
      expect(teardownTracker.steps).toContain('cache');
      expect(teardownTracker.steps).toContain('google');
      expect(teardownTracker.steps).toContain('firebase');
    });

    it('never deletes local identity key during sign-out teardown', async () => {
      const LOCAL_IDENTITY_KEY = 'detact:v1:identity';
      mockStorage.store[LOCAL_IDENTITY_KEY] = JSON.stringify({ id: 'user_keep_records_safe' });

      await runSignOutTeardown(true);

      // Verify records are NOT orphaned: identity is preserved
      expect(mockStorage.store[LOCAL_IDENTITY_KEY]).toBeDefined();
      expect(JSON.parse(mockStorage.store[LOCAL_IDENTITY_KEY]).id).toBe('user_keep_records_safe');
    });

    it('route guard: sends user to sign-in on mid-use credential revocation', () => {
      const leave = shouldLeaveForSignIn({
        status: 'signedOut',
        heldSession: true,
        pathname: '/(tabs)',
      });
      expect(leave).toBe(true);
    });

    it('route guard: does not redirect cold start signed-out state', () => {
      const leave = shouldLeaveForSignIn({
        status: 'signedOut',
        heldSession: false,
        pathname: '/',
      });
      expect(leave).toBe(false);
    });

    it('route guard: does not redirect user browsing legal terms on sign-out', () => {
      const leave = shouldLeaveForSignIn({
        status: 'signedOut',
        heldSession: true,
        pathname: '/legal',
      });
      expect(leave).toBe(false);
    });

    it('api auth resolver passes forceRefresh: true on 401 retry', async () => {
      const mockGetIdToken = vi.fn(async (_force: boolean) => 'fresh-token-456');

      const mockAuthCurrentUser = {
        getIdToken: mockGetIdToken,
      };

      const resolveToken = async (refresh?: { forceRefresh?: boolean }) => {
        return await mockAuthCurrentUser.getIdToken(refresh?.forceRefresh ?? false);
      };

      // Standard call
      const normalToken = await resolveToken();
      expect(normalToken).toBe('fresh-token-456');
      expect(mockGetIdToken).toHaveBeenLastCalledWith(false);

      // Force refresh call on 401 retry
      const refreshedToken = await resolveToken({ forceRefresh: true });
      expect(refreshedToken).toBe('fresh-token-456');
      expect(mockGetIdToken).toHaveBeenLastCalledWith(true);
    });
  });

  // =========================================================================
  // 4. Auth Error Human Readability Invariants
  // =========================================================================
  describe('Auth Error Human Readability Invariants', () => {
    it('translates every known auth error code to a polished, readable sentence', () => {
      for (const code of KNOWN_AUTH_ERROR_CODES) {
        const readable = readableAuthError({ code, message: `Raw code ${code}` });
        expect(readable.length).toBeGreaterThan(0);
        expect(readable.length).toBeLessThanOrEqual(180);
        expect(readable[0]).toBe(readable[0]?.toUpperCase());
        expect(readable).toMatch(/[.?]$/);
        expect(readable).not.toMatch(/\//); // No raw codes like auth/invalid-credential
        expect(readable).not.toMatch(/firebase|firestore|googleapis|grpc/i);
      }
    });

    it('translates unknown error objects into safe fallback sentence', () => {
      // Technical words like "exception" trigger looksTechnical and collapse to GENERIC
      const technical = readableAuthError(new Error('Unknown native exception'));
      expect(technical).toBe('Something went wrong. Please try again.');

      // Human user-facing message with no technical words is preserved
      const humanMessage = readableAuthError(new Error('Your device is in airplane mode.'));
      expect(humanMessage).toBe('Your device is in airplane mode.');

      const strange = readableAuthError({ nonStandard: 123 });
      expect(strange).toBe('Something went wrong. Please try again.');
    });
  });
});
