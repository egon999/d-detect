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

export function useAppFonts(): FontsState {
  const [loaded, error] = useFonts(FONT_ASSETS);

  const [state, setState] = useState<FontsState>({ loaded, error: error ?? null });

  useEffect(() => {
    setState({ loaded, error: error ?? null });
  }, [loaded, error]);

  useEffect(() => {
    if (error) {

      console.warn('[fonts] failed to load type faces; falling back to system font');
    }
  }, [error]);

  return state;
}

export { FONT_FAMILY };
