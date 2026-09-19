/**
 * Theme provider.
 *
 * Exposes the active colour scheme and a `useTheme()` hook. The app is designed
 * light-first — a soft lavender-white canvas with white cards — because the product is
 * read in the same situations a document is: at a desk, in an office, on a train in
 * daylight. Dark is a first-class target rather than an afterthought, for the user going
 * through a case at night.
 *
 * Three pieces of state, deliberately separated:
 *
 *   - `preference` — what the user chose: 'system' | 'dark' | 'light'.
 *   - `scheme`      — what that resolves to right now.
 *   - `setPreference` — the setter, persisted by the settings screen.
 *
 * Anything that renders a colour reads `scheme`. Anything that renders a *control* for
 * choosing the scheme reads `preference`, so the "System" option stays selected while
 * the OS is in dark mode.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';

import {
  darkColors,
  lightColors,
  shadowFor,
  type ColorScheme,
  type ElevationToken,
  type TypeToken,
  ELEVATION,
  LAYOUT,
  MOTION,
  RADIUS,
  SPACING,
  TYPE,
} from './tokens';

export type ColorSchemeName = 'dark' | 'light';
export type ThemePreference = ColorSchemeName | 'system';

export interface Theme {
  scheme: ColorSchemeName;
  colors: ColorScheme;
  spacing: typeof SPACING;
  radius: typeof RADIUS;
  type: typeof TYPE;
  motion: typeof MOTION;
  layout: typeof LAYOUT;
  /**
   * Shadow presets for the *active* scheme.
   *
   * Typed as the light table so the token names are fixed, but in dark mode this holds
   * `ELEVATION_DARK`. Every existing `theme.elevation.medium` call site therefore starts
   * casting a shadow tuned for a near-black canvas without any of them changing — which
   * is the whole reason this is resolved here rather than at each call site.
   */
  elevation: typeof ELEVATION;
  /** Resolves a type token to its style object. Shorthand for `theme.type[t]`. */
  text: (token: TypeToken) => (typeof TYPE)[TypeToken];
  /** Resolves a tone to its fg/bg/border triple for the current scheme. */
  tone: (tone: keyof ColorScheme['tones']) => ColorScheme['tones'][keyof ColorScheme['tones']];
  elevationFor: (token: ElevationToken) => (typeof ELEVATION)[ElevationToken];
}

function buildTheme(scheme: ColorSchemeName): Theme {
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const cache = new Map<string, unknown>();

  /**
   * Memoised per token. Styles are passed straight into `style={...}` props on every
   * render, and a fresh object each time would defeat React Native's style diffing on
   * any list of more than a few rows.
   */
  const memo = <T,>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key) as T;
  };

  // Built once per scheme, so `theme.elevation` stays a stable object identity across
  // renders exactly as it did when it was the imported constant.
  const elevation: typeof ELEVATION = {
    none: shadowFor(scheme, 'none'),
    low: shadowFor(scheme, 'low'),
    medium: shadowFor(scheme, 'medium'),
    high: shadowFor(scheme, 'high'),
  } as typeof ELEVATION;

  return {
    scheme,
    colors,
    spacing: SPACING,
    radius: RADIUS,
    type: TYPE,
    motion: MOTION,
    layout: LAYOUT,
    elevation,
    text: (token) => memo(`text:${token}`, () => TYPE[token]),
    // The `?? neutral` is not dead code, despite the signature constraining `tone` to a key
    // that exists. Callers reach this by indexing a lookup table with a value read back out of
    // storage — `RELATIONSHIP_TONE[edge.type]`, `ACTION_META[log.action]` — and TypeScript
    // types those indexes as present whether or not they are. A record written by an older
    // build with an enum member since renamed therefore arrives here as `undefined`, and every
    // call site dereferences the result on the same expression (`theme.tone(x).fg`). Without
    // the fallback, one stale row anywhere in a case becomes a render-phase TypeError, which
    // the navigation ErrorBoundary catches by replacing the entire app with an error screen.
    // With it, the same row renders in grey. A colour is not worth a crash.
    tone: (tone) => memo(`tone:${tone}`, () => colors.tones[tone] ?? colors.tones.neutral),
    elevationFor: (token) => elevation[token],
  };
}

/**
 * The two themes are built once at module load and reused, so switching schemes swaps a
 * reference rather than rebuilding every memo. `buildTheme` is pure, so this is safe.
 */
const DARK_THEME = buildTheme('dark');
const LIGHT_THEME = buildTheme('light');

interface ThemeContextValue extends Theme {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Initial user choice. The root layout restores the persisted value before first paint. */
  initialPreference?: ThemePreference;
  /** Notified on every change so the caller can persist it. */
  onPreferenceChange?: (next: ThemePreference) => void;
}

export function ThemeProvider({
  children,
  initialPreference = 'dark',
  onPreferenceChange,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const systemScheme = useSystemColorScheme();

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      onPreferenceChange?.(next);
    },
    [onPreferenceChange],
  );

  const resolvedScheme: ColorSchemeName =
    preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo<ThemeContextValue>(() => {
    const base = resolvedScheme === 'dark' ? DARK_THEME : LIGHT_THEME;
    return { ...base, preference, setPreference };
  }, [resolvedScheme, preference, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Reads the theme. Throws rather than falling back to a default: a component that
 * silently renders with the wrong scheme is far harder to debug than one that fails
 * loudly on the first render outside the provider.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside <ThemeProvider>. Wrap the root layout.');
  }
  return value;
}

/**
 * Colours only, for components that never touch spacing or motion. Avoids the
 * destructuring noise in leaf components and gives a narrower dependency to memoise on.
 */
export function useColors(): ColorScheme {
  return useTheme().colors;
}
