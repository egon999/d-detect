import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'detact:v1:onboarding-seen';

let seenThisRun = false;

export async function hasSeenOnboarding(): Promise<boolean> {
  if (seenThisRun) return true;
  try {
    const stored = await AsyncStorage.getItem(ONBOARDING_KEY);
    seenThisRun = stored === 'true';
    return seenThisRun;
  } catch {
    return true;
  }
}

export async function markOnboardingSeen(): Promise<void> {
  seenThisRun = true;
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
  } catch {

  }
}

export const FALLBACK_LOCALE = 'en-IN';

export const FALLBACK_CURRENCY = 'INR';

function canonicalLocale(tag: string | null | undefined): string | null {
  const typed = (tag ?? '').trim();
  if (!typed) return null;
  try {
    return Intl.getCanonicalLocales(typed)[0] ?? null;
  } catch {
    return null;
  }
}

export function deviceLocale(): string | null {
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    return canonicalLocale(tag);
  } catch {
    return null;
  }
}

export function resolveLocale(
  stored: string | null | undefined,
  device: string | null = deviceLocale(),
): string {
  return canonicalLocale(stored) ?? canonicalLocale(device) ?? FALLBACK_LOCALE;
}

export function resolveCurrency(stored: string | null | undefined): string {
  const code = (stored ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : FALLBACK_CURRENCY;
}

function named(display: string | undefined, subtag: string): string | null {
  if (!display) return null;
  return display.toLowerCase() === subtag.toLowerCase() ? null : display;
}

function genericRegion(locale: string): string | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of('ZZ') ?? null;
  } catch {
    return null;
  }
}

export function localeLabel(tag: string): string | null {
  const canonical = canonicalLocale(tag);
  if (!canonical) return null;
  try {
    const parts = new Intl.Locale(canonical);
    const language = named(
      new Intl.DisplayNames([canonical], { type: 'language' }).of(parts.language),
      parts.language,
    );
    if (!language) return null;

    let region: string | null = null;
    if (parts.region) {
      const display = named(
        new Intl.DisplayNames([canonical], { type: 'region' }).of(parts.region),
        parts.region,
      );
      region = display && display !== genericRegion(canonical) ? display : null;
    }

    return region ? `${language} (${region})` : language;
  } catch {
    return null;
  }
}

export function currencyLabel(code: string): string {
  const resolved = resolveCurrency(code);
  try {
    const name = new Intl.DisplayNames([FALLBACK_LOCALE], { type: 'currency' }).of(resolved);
    return name && name !== resolved ? `${name} (${resolved})` : resolved;
  } catch {
    return resolved;
  }
}

const CURRENCY_PREF_KEY = 'detact:v1:currency';

export async function getStoredCurrency(): Promise<string | null> {
  try {
    const val = await AsyncStorage.getItem(CURRENCY_PREF_KEY);
    return val ? resolveCurrency(val) : null;
  } catch {
    return null;
  }
}

export async function setStoredCurrency(code: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CURRENCY_PREF_KEY, resolveCurrency(code));
  } catch {

  }
}
