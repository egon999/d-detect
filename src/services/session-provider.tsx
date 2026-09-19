/**
 * Session.
 *
 * Owns "who is using the app", and answers it in a way that works with or without a
 * Firebase project.
 *
 * Two modes, chosen by the same config check the repository provider uses:
 *
 *   - **Cloud mode.** Firebase Auth with email and password. The Firebase UID is the
 *     `ownerId` on every record, so Security Rules can authorise a document from its own
 *     fields without a lookup.
 *   - **Local mode.** A stable device-local identity, held in AsyncStorage. This is what
 *     makes the app demonstrable on a phone with no backend: everything that is keyed on
 *     `ownerId` still works, because the identifier is real, it is just not issued by a
 *     server. The difference is surfaced in Settings rather than hidden.
 *
 * `ownerId` is the only identity value the rest of the app sees. No screen reads a Firebase
 * user object, so swapping the implementation does not touch a single screen.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { firebaseAuth } from '@data/firebase/auth';
import { isFirebaseConfigured } from '@data/firebase/config';
import type { Repository } from '@data/repository';
import { newId } from '@domain/ids';
import type { UserProfile } from '@domain/models';
import { useRepository } from './repository-provider';
import { sessionAccount } from './auth/account';

const LOCAL_IDENTITY_KEY = 'detact:v1:identity';
const OFFLINE_ACTIVE_KEY = 'detact:v1:offline-active';

export interface SessionUser {
  /** The value written to every record's `ownerId`. */
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  phone?: string;
  address?: string;
  providerIds: string[];
  emailVerified?: boolean;
  createdAt?: number;
}

export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface SessionValue {
  status: SessionStatus;
  user: SessionUser | null;
  /** True when this identity is device-local rather than issued by Firebase Auth. */
  isLocal: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  /** Resolves `true` when a session was established, `false` when the user backed out. */
  signInWithGoogle: () => Promise<boolean>;
  signOut: () => Promise<void>;
  /** Enters local mode with no credentials. */
  continueOffline: (displayName?: string) => Promise<void>;
  /** Sends password reset email */
  sendPasswordReset: (email?: string) => Promise<void>;
  /** Updates current user password */
  updateUserPassword: (newPassword: string, currentPassword: string) => Promise<void>;
  /** Updates current user profile details */
  updateUserProfile: (
    displayName: string,
    photoURL?: string,
    details?: { phone?: string; address?: string },
  ) => Promise<void>;
  error: Error | null;
}

const SessionContext = createContext<SessionValue | null>(null);

interface LocalIdentity {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  phone?: string;
  address?: string;
  createdAt: number;
}

/**
 * Reads, or creates, the device-local identity.
 *
 * The id is generated once and persisted, never regenerated. A fresh id on each launch
 * would orphan every case the user had created, which is precisely the kind of bug that
 * only appears the second time someone opens the app.
 */
async function loadOrCreateLocalIdentity(displayName?: string): Promise<LocalIdentity> {
  const raw = await AsyncStorage.getItem(LOCAL_IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LocalIdentity;
      if (parsed.id) {
        // A name supplied later (a sign-in attempt that fell back offline) updates the
        // label without changing the identity.
        if (displayName && displayName !== parsed.displayName) {
          const updated = { ...parsed, displayName };
          await AsyncStorage.setItem(LOCAL_IDENTITY_KEY, JSON.stringify(updated));
          return updated;
        }
        return parsed;
      }
    } catch {
      // A corrupt identity is replaced rather than fatal. Losing local cases is
      // unfortunate; refusing to start the app is worse.
    }
  }

  const identity: LocalIdentity = {
    id: newId('user'),
    email: 'local@device',
    displayName: displayName?.trim() || 'Local user',
    createdAt: Date.now(),
  };
  await AsyncStorage.setItem(LOCAL_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

/**
 * Takes the session off this device, in the one order that is correct.
 *
 * Lifted out of the `signOut` callback below so that the order can be held in place by a
 * test. Every step here is independently plausible in any position — only the sequence is
 * load-bearing — and this repo has no component-render harness, so an ordering reachable
 * only through React is an ordering nothing can defend. What the UI *becomes* stays with the
 * caller; this is only what the device forgets.
 *
 * `cloudEnabled` is a parameter rather than a read, because the value that belongs here is
 * `isFirebaseConfigured()` — whether a project exists at all, not whether this session used it.
 */
export async function runSignOutTeardown(
  repository: Pick<Repository, 'dropLocalCache'>,
  cloudEnabled: boolean,
): Promise<void> {
  // Clear the native Google session first. Signing out of Firebase alone leaves the Google
  // account selected on the device, so the next "Continue with Google" skips the chooser and
  // silently signs the same person back in — which reads as a broken sign-out button.
  try {
    const { signOutOfGoogle } = await import('./auth/google');
    await signOutOfGoogle();
  } catch {
    // Non-fatal. A stale Google session must not block leaving the app.
  }

  await AsyncStorage.removeItem(OFFLINE_ACTIVE_KEY);
  if (cloudEnabled) {
      const auth = await firebaseAuth();
      if (auth) {
        const { signOut: firebaseSignOut } = await import('firebase/auth');
        await firebaseSignOut(auth);
      }
  }
  // Keep the device identity: deleting it would strand every locally owned case.

  // Last, and only once every step above has been acknowledged.
  //
  // Firestore is initialised with `persistentLocalCache` (see `createFirebaseRepository`), so
  // the adapter keeps an on-disk copy of every document it has ever read — `extraction.sourceText`,
  // the full extracted text of a user's evidence, included. Signing out of Auth does not touch
  // that copy. Without this call the cached evidence stays on the handset and stays readable,
  // which on a shared or handed-on phone is one person's material left behind for the next.
  //
  // It is awaited *after* the steps above rather than started alongside them: dropping the
  // cache discards whatever is still queued in it and terminates the client the Firebase
  // sign-out is still talking to, so a concurrent start would race an acknowledgement that has
  // not arrived and leave the store in a state neither operation describes.
  //
  // And it completes *before* the caller's state updates, because those are what replace this
  // adapter — `setUser(null)` / `setStatus('signedOut')` drive the effect that flips
  // `setCloudEnabled`, and `Repository.dropLocalCache` is explicit that the instance is
  // unusable once dropped. The rebuild has to follow the drop, not precede it.
  //
  // Optional on the port, and called as one: the device adapter is the store of record and
  // caches nothing behind itself, so it implements no `dropLocalCache`. An adapter with
  // nothing to drop is not a failure.
  try {
    await repository.dropLocalCache?.();
  } catch (error) {
    // Caught, so the caller still reaches its state updates. Rethrowing would abandon the
    // sign-out half-done — a session still reading `signedIn` against a credential that has
    // already been revoked — and a cache that would not drop must not also cost the user the
    // sign-out they asked for.
    //
    // But logged, because this is not the silent non-event the Google branch above is. A failed
    // drop is precisely the remanence this call exists to prevent, and this line is the only
    // signal that it happened. `[session]` matches the auth listener's prefix in this file.
    console.warn(
      '[session] cached documents could not be dropped on sign-out:',
      error instanceof Error ? error.message : 'unknown',
    );
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { repository, ready, kind, setCloudEnabled } = useRepository();
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLocal, setIsLocal] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cloudEnabled = isFirebaseConfigured();

  /**
   * Keeps the storage adapter and the identity in agreement.
   *
   * These two decisions must be made together. A Firebase identity needs the Firestore
   * adapter, because that is where its data lives and where its uid is the authorisation
   * key; a device identity needs the local adapter, because Firestore will reject every
   * operation it attempts. Letting them diverge is what made the app fail with
   * `permission-denied` on every screen.
   *
   * `isLocal` is the discriminator rather than `status`, because a signed-in *local* user
   * and a signed-in *cloud* user are both `signedIn` — the distinction that matters to
   * storage is which kind of identity it is.
   */
  useEffect(() => {
    setCloudEnabled(status === 'signedIn' && user !== null && !isLocal);
  }, [status, user, isLocal, setCloudEnabled]);

  // Restores the session on launch.
  //
  // Every path out of this effect ends in a non-`restoring` status. That is the contract:
  // the splash screen and the root route both key off it, so a path that silently does
  // nothing is a frozen app. The failsafe below guarantees the contract even if the auth
  // listener never fires — which is exactly what happens when the device is offline and
  // the SDK is waiting on a token refresh it cannot complete.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let unsubAuth: (() => void) | undefined;

    // Generous, because the legitimate slow path here is a cold-radio token refresh. The
    // cost of being wrong is small: a signed-in user briefly lands on the sign-in screen
    // and the listener corrects it a moment later when it does fire.
    const failsafe = setTimeout(() => {
      if (cancelled) return;
      setStatus((curr) => (curr === 'restoring' ? 'signedOut' : curr));
    }, 2500);

    async function restore() {
      /**
       * Restores a previously chosen device identity, if there is one.
       *
       * Returns whether it found one, so the caller can decide what "no cloud user" means.
       * A user who chose to work on this device must stay signed in across restarts exactly
       * as a cloud user does — otherwise choosing offline mode silently means "sign me out
       * every time I close the app".
       */
      async function restoreLocalIdentity(): Promise<boolean> {
        const stored = await AsyncStorage.getItem(LOCAL_IDENTITY_KEY);
        if (cancelled || !stored) return false;
        try {
          const identity = JSON.parse(stored) as LocalIdentity;
          if (!identity.id) return false;
          setUser({
            id: identity.id,
            email: identity.email,
            displayName: identity.displayName,
            photoURL: identity.photoURL,
            phone: identity.phone,
            address: identity.address,
            providerIds: [],
            createdAt: identity.createdAt,
          });
          setIsLocal(true);
          setStatus('signedIn');
          return true;
        } catch {
          return false;
        }
      }

      if (cloudEnabled) {
        try {
          const auth = await firebaseAuth();
          if (cancelled) return;

          if (auth) {
            const { onAuthStateChanged } = await import('firebase/auth');
            if (cancelled) return;

            unsubAuth = onAuthStateChanged(
              auth,
              (firebaseUser) => {
                if (cancelled) return;
                clearTimeout(failsafe);
                if (firebaseUser) {
                  setUser(sessionAccount(firebaseUser));
                  setIsLocal(false);
                  setStatus('signedIn');
                } else {
                  // No cloud user signed in.
                  // Only restore local identity if the user explicitly chose offline mode earlier!
                  void AsyncStorage.getItem(OFFLINE_ACTIVE_KEY).then((active) => {
                    if (cancelled) return;
                    if (active === 'true') {
                      void restoreLocalIdentity().then((found) => {
                        if (cancelled || found) return;
                        setUser(null);
                        setIsLocal(false);
                        setStatus('signedOut');
                      });
                    } else {
                      setUser(null);
                      setIsLocal(false);
                      setStatus('signedOut');
                    }
                  });
                }
              },
              () => {
                if (cancelled) return;
                clearTimeout(failsafe);
                console.warn('[session] auth listener error; checking for a device identity');
                void AsyncStorage.getItem(OFFLINE_ACTIVE_KEY).then((active) => {
                  if (cancelled) return;
                  if (active === 'true') {
                    void restoreLocalIdentity().then((found) => {
                      if (!cancelled && !found) setStatus('signedOut');
                    });
                  } else {
                    setUser(null);
                    setIsLocal(false);
                    setStatus('signedOut');
                  }
                });
              },
            );
            return;
          }
        } catch {
          console.warn('[session] could not attach auth listener; falling back to local');
        }
      }

      // Local / offline fallback.
      try {
        clearTimeout(failsafe);
        const active = await AsyncStorage.getItem(OFFLINE_ACTIVE_KEY);
        if (active === 'true') {
          const found = await restoreLocalIdentity();
          if (!cancelled && !found) setStatus('signedOut');
        } else {
          if (!cancelled) setStatus('signedOut');
        }
      } catch {
        if (!cancelled) {
          clearTimeout(failsafe);
          setStatus('signedOut');
        }
      }
    }

    void restore();
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      if (unsubAuth) unsubAuth();
    };
  }, [ready, cloudEnabled]);

  // Keeps the profile document in step with the session, so a display name and photo have somewhere
  // to live that survives a reinstall.
  useEffect(() => {
    if (status !== 'signedIn' || !user || !ready || (isLocal ? kind !== 'local' : kind === 'local')) return;
    let cancelled = false;

    async function syncProfile() {
      try {
        const existing = await repository.loadProfile(user!.id);
        if (cancelled) return;
        if (existing) {
          let changed = false;
          const nextProfile = { ...existing };
          if (user!.displayName && existing.displayName !== user!.displayName) {
            nextProfile.displayName = user!.displayName;
            changed = true;
          }
          if (existing.email !== user!.email) {
            nextProfile.email = user!.email;
            changed = true;
          }
          if (user!.photoURL && existing.photoURL !== user!.photoURL) {
            nextProfile.photoURL = user!.photoURL;
            changed = true;
          } else if (!user!.photoURL && existing.photoURL) {
            // Restore saved photoURL back into current session
            setUser((prev) => (prev ? { ...prev, photoURL: existing.photoURL ?? undefined } : prev));
          }
          if (existing.phone && !user!.phone) {
            setUser((prev) => (prev ? { ...prev, phone: existing.phone } : prev));
          }
          if (existing.address && !user!.address) {
            setUser((prev) => (prev ? { ...prev, address: existing.address } : prev));
          }
          if (changed) {
            nextProfile.updatedAt = Date.now();
            await repository.saveProfile(nextProfile);
          }
          return;
        }
        const now = Date.now();
        const profile: UserProfile = {
          id: user!.id,
          ownerId: user!.id,
          createdAt: now,
          updatedAt: now,
          email: user!.email,
          displayName: user!.displayName,
          photoURL: user!.photoURL ?? null,
          phone: user!.phone,
          address: user!.address,
        };
        await repository.saveProfile(profile);
      } catch (err) {
        if (!cancelled) setError(new Error('Your account details could not be synced. Check your connection and try again.'));
      }
    }

    void syncProfile();

    return () => {
      cancelled = true;
    };
  }, [status, user, repository, ready, kind, isLocal]);

  const continueOffline = useCallback(
    async (displayName?: string) => {
      setError(null);
      const identity = await loadOrCreateLocalIdentity(displayName);
      await AsyncStorage.setItem(OFFLINE_ACTIVE_KEY, 'true');
      setUser({ id: identity.id, email: identity.email, displayName: identity.displayName, photoURL: identity.photoURL, providerIds: [], createdAt: identity.createdAt });
      setIsLocal(true);
      setStatus('signedIn');
    },
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      if (!cloudEnabled) {
        const wrapped = new Error(
          'Cloud sign-in is unavailable in this build. Use "Continue on this device" to work offline.',
        );
        setError(wrapped);
        throw wrapped;
      }

      try {
        const auth = await firebaseAuth();
        if (!auth) {
          const wrapped = new Error(
            'Could not reach the authentication service. Check your connection, or use "Continue on this device".',
          );
          setError(wrapped);
          throw wrapped;
        }
        const { signInWithEmailAndPassword } = await import('firebase/auth');
        const credential = await signInWithEmailAndPassword(auth, email, password);
        const account = credential.user;
        try {
          await AsyncStorage.removeItem(OFFLINE_ACTIVE_KEY);
        } catch {}
        setUser(sessionAccount(account));
        setIsLocal(false);
        setStatus('signedIn');
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [cloudEnabled],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      setError(null);
      if (!cloudEnabled) {
        const wrapped = new Error(
          'Account creation is unavailable in this build. Use "Continue on this device" to work offline.',
        );
        setError(wrapped);
        throw wrapped;
      }

      try {
        const auth = await firebaseAuth();
        if (!auth) {
          const wrapped = new Error(
            'Could not reach the authentication service. Check your connection, or use "Continue on this device".',
          );
          setError(wrapped);
          throw wrapped;
        }
        const { createUserWithEmailAndPassword, updateProfile } = await import('firebase/auth');
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (displayName) await updateProfile(credential.user, { displayName });
        try {
          await AsyncStorage.removeItem(OFFLINE_ACTIVE_KEY);
        } catch {}
        setUser(sessionAccount(credential.user));
        setIsLocal(false);
        setStatus('signedIn');
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [cloudEnabled],
  );

  const signInWithGoogle = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!cloudEnabled) {
      const wrapped = new Error('Cloud sign-in is unavailable in this build. Please sign in with email or continue locally.');
      setError(wrapped);
      throw wrapped;
    }

    if (Platform.OS === 'web') {
      try {
        const { signInGoogleWeb } = await import('./auth/google.web');
        const account = await signInGoogleWeb();
        if (!account) return false;
        await AsyncStorage.removeItem(OFFLINE_ACTIVE_KEY);
        setUser(sessionAccount(account));
        setIsLocal(false);
        setStatus('signedIn');
        return true;
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    }

    const { getGoogleIdToken } = await import('./auth/google');
    const outcome = await getGoogleIdToken();

    if (!outcome.ok) {
      if (outcome.reason === 'CANCELLED') {
        // Backing out is not a failure. Returning quietly leaves the screen exactly as it was,
        // with no error banner for someone who simply changed their mind — but the caller has
        // to be able to tell this apart from success, or it navigates a cancelled sign-in
        // straight into the app.
        return false;
      }
      const wrapped = new Error(outcome.message);
      setError(wrapped);
      throw wrapped;
    }

    try {
      const auth = await firebaseAuth();
      if (!auth) {
        const wrapped = new Error('Could not reach the authentication service. Check your connection.');
        setError(wrapped);
        throw wrapped;
      }
      // `signInWithCredential` is the only Google path that exists in Firebase's React Native
      // build. See src/services/auth/google.ts for why popup and redirect are not options.
      const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth');
      const credential = await signInWithCredential(
        auth,
        GoogleAuthProvider.credential(outcome.idToken),
      );
      const account = credential.user;
      try {
        await AsyncStorage.removeItem(OFFLINE_ACTIVE_KEY);
      } catch {}
      const photoURL = account.photoURL ?? outcome.user?.photo ?? undefined;
      const displayName = account.displayName ?? outcome.user?.name ?? (account.email?.split('@')[0] ?? 'User');
      setUser({
        ...sessionAccount(account),
        displayName,
        photoURL,
      });
      setIsLocal(false);
      setStatus('signedIn');
      return true;
    } catch (caught) {
      const wrapped = describeAuthError(caught);
      setError(wrapped);
      throw wrapped;
    }
  }, [cloudEnabled]);

  const sendPasswordReset = useCallback(
    async (targetEmail?: string) => {
      setError(null);
      const emailToReset = targetEmail?.trim() || user?.email;
      if (!emailToReset || !emailToReset.includes('@') || emailToReset.endsWith('@device')) {
        throw new Error('Please provide a valid email address to send the password reset link.');
      }
      if (!cloudEnabled) {
        throw new Error('Password reset is unavailable in this build.');
      }
      try {
        const auth = await firebaseAuth();
        if (!auth) throw new Error('Could not connect to authentication service.');
        const { sendPasswordResetEmail } = await import('firebase/auth');
        await sendPasswordResetEmail(auth, emailToReset);
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [cloudEnabled, user],
  );

  const updateUserPassword = useCallback(
    async (newPassword: string, currentPassword: string) => {
      setError(null);
      if (!newPassword || newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters.');
      }
      if (!cloudEnabled) {
        throw new Error('Password changes are unavailable in this build.');
      }
      try {
        const auth = await firebaseAuth();
        if (!auth?.currentUser) throw new Error('You must be signed in with an email account to change password.');
        if (!auth.currentUser.providerData.some((provider) => provider.providerId === 'password')) {
          throw new Error('Manage your password with your connected sign-in provider.');
        }
        if (!currentPassword || !auth.currentUser.email) throw new Error('Enter your current password to confirm this change.');
        const { updatePassword, reauthenticateWithCredential, EmailAuthProvider } = await import('firebase/auth');
        await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, currentPassword));
        await updatePassword(auth.currentUser, newPassword);
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [cloudEnabled],
  );

  const updateUserProfile = useCallback(
    async (
      displayName: string,
      photoURL?: string,
      details?: { phone?: string; address?: string },
    ) => {
      setError(null);
      if (!user) throw new Error('Sign in before updating your profile.');
      const name = displayName.trim();
      if (!name || name.length > 120) throw new Error('Use a display name between 1 and 120 characters.');
      if (!ready || (isLocal ? kind !== 'local' : kind === 'local')) throw new Error('Your account is still connecting. Try again shortly.');
      const cleanPhone = details?.phone !== undefined ? details.phone.trim() : user.phone;
      const cleanAddress = details?.address !== undefined ? details.address.trim() : user.address;
      const updatedUser: SessionUser = {
        ...user,
        displayName: name,
        photoURL: photoURL !== undefined ? photoURL : user.photoURL,
        ...(cleanPhone !== undefined ? { phone: cleanPhone } : {}),
        ...(cleanAddress !== undefined ? { address: cleanAddress } : {}),
      };
      try {
        if (isLocal) {
          const stored = await AsyncStorage.getItem(LOCAL_IDENTITY_KEY);
          if (!stored) throw new Error('Your device account could not be read.');
          const parsed = JSON.parse(stored) as LocalIdentity;
          await AsyncStorage.setItem(
            LOCAL_IDENTITY_KEY,
            JSON.stringify({
              ...parsed,
              displayName: name,
              photoURL: updatedUser.photoURL,
              phone: cleanPhone,
              address: cleanAddress,
            }),
          );
        } else {
          const auth = await firebaseAuth();
          if (!auth?.currentUser || auth.currentUser.uid !== user.id) throw new Error('Your session expired. Sign in again.');
          const { updateProfile } = await import('firebase/auth');
          await updateProfile(auth.currentUser, { displayName: name, photoURL: updatedUser.photoURL ?? null });
        }
        setUser(updatedUser);
        const existing = await repository.loadProfile(user.id);
        await repository.saveProfile({
          id: user.id,
          ownerId: user.id,
          createdAt: existing?.createdAt ?? Date.now(),
          email: user.email,
          displayName: name,
          photoURL: updatedUser.photoURL ?? null,
          phone: cleanPhone,
          address: cleanAddress,
          updatedAt: Date.now(),
        });
      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [user, isLocal, repository, ready, kind],
  );

  const signOut = useCallback(async () => {
    await runSignOutTeardown(repository, cloudEnabled);

    // Only now. These four are what rebuild the adapter — see the note at the foot of
    // `runSignOutTeardown` on why the rebuild has to follow the drop rather than race it.
    setUser(null);
    setIsLocal(false);
    setStatus('signedOut');
    setError(null);
  }, [cloudEnabled, repository]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      isLocal,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      continueOffline,
      sendPasswordReset,
      updateUserPassword,
      updateUserProfile,
      error,
    }),
    [
      status,
      user,
      isLocal,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      continueOffline,
      sendPasswordReset,
      updateUserPassword,
      updateUserProfile,
      error,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Turns an SDK error into a sentence a person can act on.
 *
 * Firebase's messages are already reasonable, but several of them are identical to a user
 * ("auth/invalid-credential" covers both a wrong password and an unknown account) and one
 * of them — network failure — is not the user's mistake at all. The mapping here says what
 * happened without confirming whether an account exists, which is the behaviour the
 * Firebase docs recommend and also the safer one.
 *
 * `auth/invalid-credential` is the case that matters most. Email Enumeration Protection is on
 * by default for every project created since September 2023, and it collapses
 * `auth/wrong-password` and `auth/user-not-found` into this single code on purpose — telling
 * someone which of the two it was tells an attacker which email addresses are registered. The
 * two legacy codes are kept as fallbacks for older projects, mapped to the same sentence.
 */
function describeAuthError(caught: unknown): Error {
  const code = (caught as { code?: string }).code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return new Error('That email and password do not match an account.');
    case 'auth/invalid-email':
      return new Error('That does not look like an email address.');
    case 'auth/email-already-in-use':
      return new Error('An account already exists for that email.');
    case 'auth/weak-password':
      return new Error('Please use a password of at least six characters.');
    case 'auth/too-many-requests':
      return new Error('Too many attempts. Please wait a moment and try again.');
    case 'auth/user-disabled':
      return new Error('This account has been disabled.');
    case 'auth/operation-not-allowed':
      return new Error('That sign-in method is not enabled for this project.');
    case 'auth/account-exists-with-different-credential':
      return new Error('That email is already registered with a different sign-in method.');
    case 'auth/invalid-credential-or-provider-id':
      return new Error('Google could not verify that account. Please try email sign-in.');
    case 'auth/network-request-failed':
      return new Error('No connection to your account. Check your connection and try again.');
    case 'auth/requires-recent-login':
      return new Error('Please sign in again to confirm this account change.');
    case 'auth/popup-blocked':
      return new Error('Your browser blocked Google sign-in. Allow pop-ups for this site and try again.');
    default:
      return caught instanceof Error ? caught : new Error('Sign-in failed.');
  }
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}

/** The signed-in user's id, or null. The value every repository call needs. */
export function useOwnerId(): string | null {
  return useSession().user?.id ?? null;
}
