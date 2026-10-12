import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { firebaseAuth } from '@data/firebase/auth';
import { isFirebaseConfigured } from '@data/firebase/config';
import { deviceSessionUser, personalName, sessionAccount } from './auth/account';
import { asAuthError } from './auth/errors';
import { SESSION_RESTORE_DEADLINE_MS, STORAGE_DEADLINE_MS } from './auth/launch';

export const KEEP_SIGNED_IN_STORAGE_KEY = '@ddetect/keep_signed_in';

const LOCAL_IDENTITY_KEY = 'detact:v1:identity';

const DEVICE_SESSION_ACTIVE_KEY = 'detact:v1:offline-active';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function newLocalIdentityId(): string {
  let body = '';
  for (let i = 0; i < 16; i += 1) {
    body += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `user_${body}`;
}

export interface SessionUser {

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

  isLocal: boolean;

  accountsAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;

  signInWithGoogle: () => Promise<boolean>;
  signOut: () => Promise<void>;

  continueOffline: (displayName?: string) => Promise<void>;

  sendPasswordReset: (email?: string) => Promise<void>;

  updateUserPassword: (newPassword: string, currentPassword: string) => Promise<void>;

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
  email?: string | null;
  displayName?: string | null;
  photoURL?: string;
  phone?: string;
  address?: string;
  createdAt: number;
}

async function loadOrCreateLocalIdentity(displayName?: string): Promise<LocalIdentity> {
  const chosenName = personalName(displayName);
  const raw = await AsyncStorage.getItem(LOCAL_IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LocalIdentity;
      if (parsed.id) {

        if (chosenName && chosenName !== parsed.displayName) {
          const updated = { ...parsed, displayName: chosenName };
          await AsyncStorage.setItem(LOCAL_IDENTITY_KEY, JSON.stringify(updated));
          return updated;
        }
        return parsed;
      }
    } catch {

    }
  }

  const identity: LocalIdentity = {
    id: newLocalIdentityId(),
    ...(chosenName ? { displayName: chosenName } : {}),
    createdAt: Date.now(),
  };
  await AsyncStorage.setItem(LOCAL_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function runSignOutTeardown(cloudEnabled: boolean): Promise<void> {

  try {
    const { clearApiCache } = await import('@api');
    clearApiCache();
  } catch {

  }

  try {
    const { signOutOfGoogle } = await import('./auth/google');
    await signOutOfGoogle();
  } catch {

  }

  try {
    await AsyncStorage.removeItem(DEVICE_SESSION_ACTIVE_KEY);
  } catch {

  }

  if (cloudEnabled) {
    try {
      const auth = await firebaseAuth();
      if (auth) {
        const { signOut: firebaseSignOut } = await import('firebase/auth');
        await firebaseSignOut(auth);
      }
    } catch {

    }
  }

}

async function readKeyWithDeadline(key: string, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      AsyncStorage.getItem(key),
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

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLocal, setIsLocal] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const cloudEnabled = isFirebaseConfigured();

  useEffect(() => {
    let cancelled = false;
    let unsubAuth: (() => void) | undefined;

    const failsafe = setTimeout(() => {
      if (cancelled) return;
      setStatus((curr) => (curr === 'restoring' ? 'signedOut' : curr));
    }, SESSION_RESTORE_DEADLINE_MS);

    function settle(next: SessionStatus, account: SessionUser | null, local: boolean): void {
      if (cancelled) return;
      setUser(account);
      setIsLocal(local);
      setStatus(next);
      clearTimeout(failsafe);
    }

    const signOut = () => settle('signedOut', null, false);

    async function restore() {

      async function restoreLocalIdentity(): Promise<boolean> {
        const keepSignedInPref = await readKeyWithDeadline(
          KEEP_SIGNED_IN_STORAGE_KEY,
          STORAGE_DEADLINE_MS,
        );
        if (cancelled || keepSignedInPref === 'false') return false;

        const stored = await readKeyWithDeadline(LOCAL_IDENTITY_KEY, STORAGE_DEADLINE_MS);
        if (cancelled || !stored) return false;
        try {
          const identity = JSON.parse(stored) as LocalIdentity;
          if (!identity.id) return false;
          settle('signedIn', deviceSessionUser(identity), true);
          return true;
        } catch {

          return false;
        }
      }

      async function resolveWithoutAccount(): Promise<void> {
        const chosen = await readKeyWithDeadline(DEVICE_SESSION_ACTIVE_KEY, STORAGE_DEADLINE_MS);
        if (cancelled) return;

        if (chosen === 'true' && (await restoreLocalIdentity())) return;
        signOut();
      }

      if (cloudEnabled) {
        try {
          const auth = await firebaseAuth();
          if (cancelled) return;

          if (auth) {
            const { onAuthStateChanged } = await import('firebase/auth');
            if (cancelled) return;

            let initialRestore = true;

            unsubAuth = onAuthStateChanged(
              auth,
              async (firebaseUser) => {
                if (cancelled) return;
                if (firebaseUser) {
                  if (initialRestore) {
                    initialRestore = false;

                    const keepSignedInPref = await readKeyWithDeadline(
                      KEEP_SIGNED_IN_STORAGE_KEY,
                      STORAGE_DEADLINE_MS,
                    );
                    if (cancelled) return;
                    if (keepSignedInPref === 'false') {

                      signOut();
                      return;
                    }
                  }
                  settle('signedIn', sessionAccount(firebaseUser), false);
                } else {
                  initialRestore = false;
                  void resolveWithoutAccount();
                }
              },
              () => {
                if (cancelled) return;
                initialRestore = false;
                console.warn('[session] auth listener error; looking for a stored identity');
                void resolveWithoutAccount();
              },
            );
            return;
          }
        } catch {
          console.warn('[session] could not attach the auth listener');
        }
      }

      await resolveWithoutAccount();
    }

    void restore().catch(() => {

      console.warn('[session] restore failed unexpectedly; signing out');
      signOut();
    });
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      if (unsubAuth) unsubAuth();
    };
  }, [cloudEnabled]);

  const continueOffline = useCallback(
    async (displayName?: string) => {
      setError(null);
      const identity = await loadOrCreateLocalIdentity(displayName);
      await AsyncStorage.setItem(DEVICE_SESSION_ACTIVE_KEY, 'true');
      setUser(deviceSessionUser(identity));
      setIsLocal(true);
      setStatus('signedIn');
    },
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      if (!cloudEnabled) {
        const wrapped = new Error('Signing in isn’t working right now. Please try again later.');
        setError(wrapped);
        throw wrapped;
      }

      try {
        const auth = await firebaseAuth();
        if (!auth) {
          const wrapped = new Error(
            'We couldn’t reach your account. Check your connection and try again.',
          );
          setError(wrapped);
          throw wrapped;
        }
        const { signInWithEmailAndPassword } = await import('firebase/auth');
        const credential = await signInWithEmailAndPassword(auth, email, password);
        const account = credential.user;
        try {
          await AsyncStorage.removeItem(DEVICE_SESSION_ACTIVE_KEY);
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
        const wrapped = new Error('Creating an account isn’t working right now. Please try again later.');
        setError(wrapped);
        throw wrapped;
      }

      try {
        const auth = await firebaseAuth();
        if (!auth) {
          const wrapped = new Error(
            'We couldn’t reach your account. Check your connection and try again.',
          );
          setError(wrapped);
          throw wrapped;
        }
        const { createUserWithEmailAndPassword, updateProfile } = await import('firebase/auth');
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (displayName) await updateProfile(credential.user, { displayName });
        try {
          await AsyncStorage.removeItem(DEVICE_SESSION_ACTIVE_KEY);
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
      const wrapped = new Error('Signing in isn’t working right now. Please try again later.');
      setError(wrapped);
      throw wrapped;
    }

    if (Platform.OS === 'web') {
      try {
        const { signInGoogleWeb } = await import('./auth/google.web');
        const account = await signInGoogleWeb();
        if (!account) return false;
        await AsyncStorage.removeItem(DEVICE_SESSION_ACTIVE_KEY);
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

    try {
      const { getGoogleIdToken } = await import('./auth/google');
      const outcome = await getGoogleIdToken();

      if (!outcome.ok) {
        if (outcome.reason === 'CANCELLED') {

          return false;
        }
        throw new Error(outcome.message);
      }

      const auth = await firebaseAuth();
      if (!auth) {
        throw new Error('We couldn’t reach your account. Check your connection and try again.');
      }

      const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth');
      const credential = await signInWithCredential(
        auth,
        GoogleAuthProvider.credential(outcome.idToken),
      );
      const account = credential.user;
      try {
        await AsyncStorage.removeItem(DEVICE_SESSION_ACTIVE_KEY);
      } catch {}
      const photoURL = account.photoURL ?? outcome.user?.photo ?? undefined;

      const displayName =
        personalName(account.displayName) ||
        personalName(outcome.user?.name) ||
        personalName(sessionAccount(account).displayName);
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
        throw new Error('Enter the email address for your account first.');
      }
      if (!cloudEnabled) {
        throw new Error('Resetting a password isn’t working right now. Please try again later.');
      }
      try {
        const auth = await firebaseAuth();
        if (!auth) throw new Error('We couldn’t reach your account. Check your connection and try again.');
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
        throw new Error('Password changes aren’t available right now.');
      }
      try {
        const auth = await firebaseAuth();
        if (!auth?.currentUser) throw new Error('You must be signed in with an email account to change password.');
        if (!auth.currentUser.providerData.some((provider) => provider.providerId === 'password')) {
          throw new Error('You signed in with Google, so there’s no password to change here.');
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

      } catch (caught) {
        const wrapped = describeAuthError(caught);
        setError(wrapped);
        throw wrapped;
      }
    },
    [user, isLocal],
  );

  const signOut = useCallback(async () => {
    await runSignOutTeardown(cloudEnabled);

    setUser(null);
    setIsLocal(false);
    setStatus('signedOut');
    setError(null);
  }, [cloudEnabled]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      isLocal,
      accountsAvailable: cloudEnabled,
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
      cloudEnabled,
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

function describeAuthError(caught: unknown): Error {
  return asAuthError(caught);
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}

export function useOwnerId(): string | null {
  return useSession().user?.id ?? null;
}
