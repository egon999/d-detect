/**
 * Font loading.
 *
 * The loader map is derived *from* `FONT_FAMILY` in `tokens.ts` rather than written out
 * beside it, so the name a style asks for and the name the asset was registered under
 * cannot drift apart. Adding a weight means adding it in one place.
 *
 * `useFonts` is the right call here rather than the `expo-font` config plugin: the config
 * plugin embeds fonts at build time, which requires a native build, and this project
 * runs in Expo Go during development. The plugin is the better choice for the final
 * standalone build — see DEVELOPMENT.md, which records that switch.
 */

import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from '@expo-google-fonts/ibm-plex-mono';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';

import { FONT_FAMILY } from './tokens';

/**
 * Eight faces total. Every weight in the type scale must appear here or the style will
 * silently fall back to the system font, which is a visible inconsistency rather than
 * an error — hence the exhaustive record type below.
 *
 * Italics are deliberately absent: nothing in the product uses them, and each face adds
 * to the cold-start font load.
 */
const FONT_ASSETS: Record<(typeof FONT_FAMILY)[keyof typeof FONT_FAMILY], number> = {
  [FONT_FAMILY.sansRegular]: PlusJakartaSans_400Regular,
  [FONT_FAMILY.sansMedium]: PlusJakartaSans_500Medium,
  [FONT_FAMILY.sansSemiBold]: PlusJakartaSans_600SemiBold,
  [FONT_FAMILY.sansBold]: PlusJakartaSans_700Bold,
  [FONT_FAMILY.sansExtraBold]: PlusJakartaSans_800ExtraBold,
  [FONT_FAMILY.monoRegular]: IBMPlexMono_400Regular,
  [FONT_FAMILY.monoMedium]: IBMPlexMono_500Medium,
  [FONT_FAMILY.monoSemiBold]: IBMPlexMono_600SemiBold,
};

export interface FontsState {
  loaded: boolean;
  error: Error | null;
}

/**
 * Loads the type faces.
 *
 * A font failure is reported but not thrown: the app renders in the system font rather
 * than showing a blank screen. Degrading to the wrong typeface is a cosmetic problem,
 * and blocking the app on it would turn a cosmetic problem into an unusable one.
 */
export function useAppFonts(): FontsState {
  const [loaded, error] = useFonts(FONT_ASSETS);

  const [state, setState] = useState<FontsState>({ loaded, error: error ?? null });

  useEffect(() => {
    setState({ loaded, error: error ?? null });
  }, [loaded, error]);

  useEffect(() => {
    if (error) {
      // The font names only — never the whole asset map, which is large and useless.
      console.warn('[fonts] failed to load type faces; falling back to system font');
    }
  }, [error]);

  return state;
}

export { FONT_FAMILY };
