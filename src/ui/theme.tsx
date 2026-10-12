import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  darkColors,
  lightColors,
  type ColorScheme,
  type Density,
  type TypeToken,
  DENSITY,
  ELEVATION,
  FOCUS_RING,
  LAYOUT,
  MOTION,
  RADIUS,
  SPACING,
  TABULAR,
  TYPE,
} from './tokens';

export type ColorSchemeName = 'dark' | 'light';
export type ThemeMode = 'system' | 'dark' | 'light';

export const THEME_MODE_STORAGE_KEY = '@detact:theme-mode';

export interface Theme {
  scheme: ColorSchemeName;
  mode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  colors: ColorScheme;
  spacing: typeof SPACING;
  radius: typeof RADIUS;
  type: typeof TYPE;
  motion: typeof MOTION;
  layout: typeof LAYOUT;

  elevation: typeof ELEVATION;
  density: typeof DENSITY;

  spaceFor: (density: Density) => (typeof DENSITY)[Density];
  focusRing: typeof FOCUS_RING;
  tabular: typeof TABULAR;

  text: (token: TypeToken) => (typeof TYPE)[TypeToken];

  tone: (tone: keyof ColorScheme['tones']) => ColorScheme['tones'][keyof ColorScheme['tones']];
}

function buildTheme(
  scheme: ColorSchemeName,
  mode: ThemeMode,
  setThemeMode: (m: ThemeMode) => void,
): Theme {
  const colors = scheme === 'light' ? lightColors : darkColors;
  const cache = new Map<string, unknown>();

  const memo = <T,>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key) as T;
  };

  return {
    scheme,
    mode,
    setThemeMode,
    colors,
    spacing: SPACING,
    radius: RADIUS,
    type: TYPE,
    motion: MOTION,
    layout: LAYOUT,
    elevation: ELEVATION,
    density: DENSITY,
    focusRing: FOCUS_RING,
    tabular: TABULAR,
    spaceFor: (density) => memo(`density:${density}`, () => DENSITY[density]),
    text: (token) => memo(`text:${token}`, () => TYPE[token]),
    tone: (tone) => memo(`tone:${tone}`, () => colors.tones[tone] ?? colors.tones.neutral),
  };
}

const DEFAULT_THEME = buildTheme('dark', 'dark', () => {});

const ThemeContext = createContext<Theme>(DEFAULT_THEME);

export interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const systemScheme = useColorScheme();

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(THEME_MODE_STORAGE_KEY)
      .then((saved) => {
        if (!active) return;
        if (saved === 'dark' || saved === 'light' || saved === 'system') {
          setMode(saved);
        }
      })
      .catch(() => {

      });
    return () => {
      active = false;
    };
  }, []);

  const setThemeMode = useCallback((next: ThemeMode) => {
    setMode(next);
    AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, next).catch(() => {});
  }, []);

  const resolvedScheme: ColorSchemeName =
    mode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : mode;

  const value = useMemo(
    () => buildTheme(resolvedScheme, mode, setThemeMode),
    [resolvedScheme, mode, setThemeMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext);
  return value ?? DEFAULT_THEME;
}
