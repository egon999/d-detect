/**
 * Persisted preferences.
 *
 * Small, non-sensitive settings that belong to the device rather than the account — at
 * present, the colour scheme. They live in AsyncStorage rather than in the user's profile
 * document because they should apply instantly at boot, before any network call, and
 * because they are genuinely per-device — a user may well want dark on their phone and
 * light on a tablet.
 *
 * Nothing here is a secret, and nothing here is case data.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

import type { ThemePreference } from '@ui';
import { sanitizeRecentSearches, searchStorageKey } from './search-index';

const THEME_KEY = 'detact:v1:theme';
const ONBOARDING_KEY = 'detact:v1:onboarding-seen';

/**
 * Whether the user has completed or dismissed the onboarding flow on this device.
 *
 * A missing value (fresh install) is treated as false so new users always see the flow once.
 */
export async function hasSeenOnboarding(): Promise<boolean> {
  return (await AsyncStorage.getItem(ONBOARDING_KEY)) === 'true';
}

/** Records that onboarding has been seen, so subsequent launches skip it. */
export async function markOnboardingSeen(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
}

export async function remembersSearches(ownerId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(searchStorageKey(ownerId, true))) !== 'false';
}

export async function clearSearchHistory(ownerId: string): Promise<void> {
  await AsyncStorage.removeItem(searchStorageKey(ownerId));
  // Older versions did not record an owner. Never attribute those queries to an account.
  await AsyncStorage.removeItem('@ddetact_recent_searches');
}

export async function setRememberSearches(ownerId: string, enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(searchStorageKey(ownerId, true), String(enabled));
  if (!enabled) await clearSearchHistory(ownerId);
}

export async function loadSearchHistory(ownerId: string): Promise<string[]> {
  if (!(await remembersSearches(ownerId))) return [];
  const raw = await AsyncStorage.getItem(searchStorageKey(ownerId));
  if (!raw) return [];
  try { return sanitizeRecentSearches(JSON.parse(raw)); } catch { return []; }
}

export async function rememberSearch(ownerId: string, term: string): Promise<string[]> {
  if (!(await remembersSearches(ownerId))) return [];
  const next = sanitizeRecentSearches([term, ...await loadSearchHistory(ownerId)]);
  await AsyncStorage.setItem(searchStorageKey(ownerId), JSON.stringify(next));
  return next;
}

export interface ThemePreferenceState {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  /** False until the stored value has been read. The root layout waits on this. */
  loaded: boolean;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

/**
 * Reads and writes the colour scheme preference.
 *
 * The root layout holds the splash screen until `loaded` is true. That costs a few
 * milliseconds at boot and buys the absence of a flash of the wrong theme — which, for a
 * user who chose dark and opens the app at night, is a full-screen white flash.
 */
export function useThemePreference(): ThemePreferenceState {
  // Dark is the pre-hydration default, not light. The root layout holds the splash until
  // `loaded`, so this value is rarely painted — but when it is, on a slow first read, a
  // dark frame under a dark splash is invisible where a light one is a full-screen flash.
  const [preference, setPreferenceState] = useState<ThemePreference>('dark');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(THEME_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isThemePreference(stored)) setPreferenceState(stored);
      })
      .catch(() => {
        // An unreadable preference is not worth failing a boot over — the default stands.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    // Not awaited: the theme should change on the same frame as the tap, and a failed
    // write costs the user their preference on next launch rather than anything worse.
    void AsyncStorage.setItem(THEME_KEY, next).catch(() => {});
  }, []);

  return { preference, setPreference, loaded };
}
