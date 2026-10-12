import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { en, type Translations } from './locales/en';
import { hi } from './locales/hi';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';

export type SupportedLanguage = 'en' | 'hi' | 'es' | 'fr' | 'de';

export interface LanguageOption {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
];

const DICTIONARIES: Record<SupportedLanguage, Translations> = {
  en,
  hi,
  es,
  fr,
  de,
};

const STORAGE_KEY = 'detact:v1:app-language';

interface LanguageContextValue {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => Promise<void>;
  t: (path: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function resolvePath(obj: any, path: string): string | undefined {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>('en');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored && (stored === 'en' || stored === 'hi' || stored === 'es' || stored === 'fr' || stored === 'de')) {
          setLanguageState(stored);
        }
      })
      .catch(() => {});
  }, []);

  const setLanguage = useCallback(async (newLang: SupportedLanguage) => {
    setLanguageState(newLang);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, newLang);
    } catch {}
  }, []);

  const t = useCallback(
    (path: string, vars?: Record<string, string | number>): string => {
      const activeDict = DICTIONARIES[language] ?? en;
      let template = resolvePath(activeDict, path) ?? resolvePath(en, path) ?? path;

      if (vars) {
        for (const [key, value] of Object.entries(vars)) {
          template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
        }
      }

      return template;
    },
    [language],
  );

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t,
    }),
    [language, setLanguage, t],
  );

  return React.createElement(LanguageContext.Provider, { value }, children);
}

export function useTranslation() {
  const context = useContext(LanguageContext);
  if (!context) {

    return {
      language: 'en' as SupportedLanguage,
      setLanguage: async () => {},
      t: (path: string, vars?: Record<string, string | number>) => {
        let template = resolvePath(en, path) ?? path;
        if (vars) {
          for (const [key, value] of Object.entries(vars)) {
            template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
          }
        }
        return template;
      },
    };
  }
  return context;
}
