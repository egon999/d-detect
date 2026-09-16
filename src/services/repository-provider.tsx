/**
 * Repository provider.
 *
 * Chooses the storage adapter once, at app start, and hands it to the rest of the app
 * through context. Every screen talks to the `Repository` port and nothing else, so the
 * app runs identically against AsyncStorage on the device and Firestore in the cloud —
 * and the demo runs on the device even with no Firebase project configured at all.
 *
 * The adapter is chosen asynchronously because the Firebase adapter can only be built with
 * a valid config. Rather than blocking the first paint on that, `ready` is exposed and the
 * root layout shows the splash until it flips. A cold start on this app is a few hundred
 * milliseconds; showing the splash for that long is the correct behaviour anyway.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { createAsyncStorageStore } from '@data/local/async-storage-store';
import { LocalRepository } from '@data/local/local-repository';
import { isFirebaseConfigured } from '@data/firebase/config';
import { createFirebaseRepository } from '@data/firebase/firebase-repository';
import type { Repository } from '@data/repository';
import { RemoteRepository } from '@data/remote/remote-repository';
import { apiBaseUrl } from './api-client';

export type RepositoryKind = Repository['kind'];

export interface RepositoryContextValue {
  repository: Repository;
  /** Where data is being read from and written to. Surfaced in Settings. */
  kind: RepositoryKind;
  /** False until the adapter has been constructed. */
  ready: boolean;
  /**
   * Present when the app fell back to local storage despite Firebase being configured —
   * e.g. a malformed config. Shown in Settings so the fallback is never silent.
   */
  fallbackReason: string | null;
  /**
   * Switches this session to the cloud adapter, or back to the device.
   *
   * Called by the session layer when identity changes, because **which adapter is correct
   * depends on who is signed in, not only on whether a project is configured.** See the
   * note on `useSyncedRepository` below.
   */
  setCloudEnabled: (enabled: boolean) => void;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export interface RepositoryProviderProps {
  children: React.ReactNode;
}

/**
 * How long the Firebase adapter may take to build before the app gives up and starts
 * locally.
 *
 * `createFirebaseRepository` is not supposed to be slow — it does no network I/O, it just
 * constructs handles. But "not supposed to be slow" is not the same as "cannot hang", and
 * this provider renders nothing until it resolves, which means anything that hangs here
 * hangs the whole app behind the splash screen. That failure mode is severe enough, and the
 * fallback cheap enough, that a deadline is worth having. Four seconds is far beyond any
 * legitimate construction time.
 */
const FIREBASE_INIT_TIMEOUT_MS = 4000;

export function RepositoryProvider({ children }: RepositoryProviderProps) {
  const [value, setValue] = useState<RepositoryContextValue | null>(null);

  /**
   * Whether this session is allowed to use the cloud adapter.
   *
   * Starts `false` and is raised by the session layer once a Firebase user exists. This is
   * the fix for a bug that made the app look completely broken on device: the adapter used
   * to be chosen from `isFirebaseConfigured()` alone, so a user in **local mode** — the demo
   * path, or anyone who tapped "continue on this device" — got the *Firestore* adapter and a
   * device-generated `ownerId` like `user_a1b2c3`. Firestore then rejected every read and
   * every write with `permission-denied`, because Security Rules require
   * `request.auth.uid == ownerId` and there was no `request.auth` at all.
   *
   * The result was an app where nothing loaded and nothing saved, with the failure surfacing
   * as an unexplained permissions error rather than as "you are not signed in".
   *
   * Confirmed against the live project: an unauthenticated write carrying a device-style
   * `ownerId` returns HTTP 403.
   */
  const [cloudEnabled, setCloudEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      // Built first and unconditionally, so there is always something to fall back to. The
      // constructor touches no I/O, so this is cheap even when Firebase wins.
      const local = new LocalRepository(createAsyncStorageStore());

      const useLocal = (fallbackReason: string | null) => {
        if (!cancelled) {
          setValue({
            repository: local,
            kind: 'local',
            ready: true,
            fallbackReason,
            setCloudEnabled,
          });
        }
      };

      // No authenticated cloud identity yet: the device adapter is not a fallback here, it
      // is the correct choice. Signing in flips `cloudEnabled` and re-runs this effect.
      if (!cloudEnabled) {
        useLocal(null);
        return;
      }

      if (apiBaseUrl()) {
        if (!cancelled) setValue({ repository: new RemoteRepository(), kind: 'remote', ready: true, fallbackReason: null, setCloudEnabled });
        return;
      }

      let configured = false;
      try {
        configured = isFirebaseConfigured();
      } catch (error) {
        // Reading config should not be able to throw, but if it does the app still starts.
        useLocal(error instanceof Error ? error.message : 'Firebase config unreadable');
        return;
      }

      if (!configured) {
        useLocal(null);
        return;
      }

      try {
        const firebase = await withTimeout(
          createFirebaseRepository(),
          FIREBASE_INIT_TIMEOUT_MS,
          'Firebase took too long to initialise',
        );
        if (!cancelled) {
          setValue({
            repository: firebase,
            kind: 'firebase',
            ready: true,
            fallbackReason: null,
            setCloudEnabled,
          });
        }
      } catch (error) {
        // A configured-but-unreachable backend must not make the app unusable. The user
        // keeps working locally and Settings tells them so.
        useLocal(error instanceof Error ? error.message : 'Firebase could not be initialised');
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [cloudEnabled]);

  // Memoised so consumers do not re-render on every provider render.
  const stable = useMemo(() => value, [value]);

  if (!stable) {
    // Nothing is rendered until the adapter exists — this is the boot splash window.
    return null;
  }

  return <RepositoryContext.Provider value={stable}>{children}</RepositoryContext.Provider>;
}

export function useRepository(): RepositoryContextValue {
  const value = useContext(RepositoryContext);
  if (!value) {
    throw new Error('useRepository must be used inside <RepositoryProvider>.');
  }
  return value;
}

/**
 * Rejects if the promise has not settled within `ms`.
 *
 * The underlying work is not cancelled — it cannot be, and it does not matter: if Firebase
 * arrives after the deadline the app is already running locally, and the abandoned handle
 * is garbage collected.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export { AsyncStorage };
