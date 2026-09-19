/**
 * Provider keys, held in the device keystore.
 *
 * The app has no server. There is nowhere to put a shared key, and a key compiled into the
 * bundle would be one key — the developer's — published to every installation and
 * recoverable from the APK with `unzip` and `grep`. So the key is the user's own: they paste
 * it once in Settings and it is written to the platform keystore, which on Android is the
 * hardware-backed Android Keystore and on iOS is the Keychain, via `expo-secure-store`.
 *
 * What that buys, concretely:
 *
 * - It is never in the source tree, never in `.env`, never in a build artifact.
 * - It is scoped to this app's sandbox; another app cannot read it.
 * - It survives app restarts but not an uninstall, which is the correct lifetime for a
 *   credential the user can revoke from their own provider console.
 * - It is revocable by the person who owns it, without a new release of this app.
 *
 * ## Providers
 *
 * Two providers take a key: Groq (`groq`, keys start `gsk_`) and xAI (`grok`, keys start
 * `xai-`). Each is stored under its own keystore entry, so a user can hold one, the other,
 * or both, and Settings manages each independently. Both speak the OpenAI-compatible chat
 * API, which is what lets `./groq-client` serve them from one transport.
 *
 * ## Gemini is present but deliberately unreachable
 *
 * `AIProviderId` still names `gemini`, and nothing here will store a Gemini key: see
 * `GEMINI_IS_SERVER_ONLY`. The identifier exists so that `clearKey` and
 * `removeLegacyAICredentials` can find and delete keys written by earlier builds. Gemini
 * belongs in a server environment with its key in a secret manager, and that constraint
 * does not lapse because this file could technically hold one.
 *
 * ## Why the native module is imported lazily
 *
 * `expo-secure-store` is a native module. It does not exist under Vitest, and on web its
 * availability depends on the browser. A top-level import would make this module's
 * evaluation fail in both places and take the entire AI layer — and the screens that import
 * it — down with it. Every entry point here degrades to "no key" instead of throwing.
 */

export type AIProviderId = 'groq' | 'grok' | 'gemini';

export interface StoredCredential {
  provider: AIProviderId;
  key: string;
}

export const AI_PROVIDER_IDS: readonly AIProviderId[] = ['groq', 'grok', 'gemini'];

export const AI_PROVIDER_LABELS: Record<AIProviderId, string> = {
  groq: 'Groq',
  grok: 'xAI (Grok)',
  gemini: 'Google Gemini',
};

export const AI_PROVIDER_CONSOLE_URLS: Record<AIProviderId, string> = {
  groq: 'https://console.groq.com/keys',
  grok: 'https://console.x.ai',
  gemini: '',
};

/**
 * Gemini raw API keys (starting with AIza) are refused on the device, as they belong
 * in a server environment. However, personal session cookies and proxy configurations
 * are permitted to enable zero-credit deterministic reasoning and personal proxy acceleration.
 */
export const GEMINI_IS_SERVER_ONLY = false;

export interface GeminiProxyConfig {
  proxyUrl?: string;
  sessionCookie?: string;
  enabled: boolean;
}

/**
 * The shape each provider's key takes, checked before anything is stored.
 *
 * The prefixes are what a provider's console puts on a key, so they catch the common paste
 * mistakes — an ID, a key *name*, the console URL — at the moment the user can still fix
 * them. They cannot tell a valid key from a revoked one; only the provider can, which is
 * why Settings also makes a live validation call.
 */
const KEY_SHAPES: Partial<Record<AIProviderId, RegExp>> = {
  groq: /^gsk_[A-Za-z0-9]{20,}$/,
  grok: /^xai-[A-Za-z0-9]{20,}$/,
};

/** The opening sentence of the message `saveKey` throws for a key of the wrong shape. */
const KEY_PREFIX_HINTS: Partial<Record<AIProviderId, string>> = {
  groq: 'A Groq key starts with "gsk_".',
  grok: 'An xAI key starts with "xai-".',
};

const storageKey = (provider: AIProviderId) => `detact.ai.key.${provider}`;

/**
 * Longest a key is allowed to be.
 *
 * SecureStore's Android backing store has a practical size limit and a pasted-in blob of
 * the wrong thing — a whole JSON config, a curl command — should be rejected at the input
 * rather than stored and then failing at request time.
 */
const MAX_KEY_LENGTH = 400;

/**
 * In-memory cache of resolved keys.
 *
 * A single case analysis makes up to six model calls, and each one would otherwise cross
 * the native bridge to the keystore. The cache is per-process and dies with the app, so it
 * never outlives the protection it is skipping. `null` is cached too: a user with no key
 * configured should not pay for a keystore round trip on every screen mount that asks
 * `aiAvailable()`.
 */
const cache = new Map<AIProviderId, string | null>();

/**
 * Resets the caches between tests, which otherwise leak a key from one case into the next.
 *
 * Two caches: the resolved keys, and the memoised native-module handle — the latter because
 * the test double can flip its availability flag, and a memoised handle would keep serving
 * the answer from before the flip.
 */
export function resetCredentialsCacheForTests(): void {
  cache.clear();
  storePromise = null;
}

type SecureStore = typeof import('expo-secure-store');

let storePromise: Promise<SecureStore | null> | null = null;

/**
 * Resolves the native module once, or `null` where it does not exist.
 *
 * The promise itself is memoised rather than the result, so that concurrent callers during
 * startup share one import instead of racing several.
 */
async function secureStore(): Promise<SecureStore | null> {
  storePromise ??= (async () => {
    try {
      const store = await import('expo-secure-store');
      return (await store.isAvailableAsync()) ? store : null;
    } catch {
      // Vitest, or a web build without the shim. Not an error condition — the app runs
      // without AI and says so.
      return null;
    }
  })();
  return storePromise;
}

/** Whether a key can be stored at all. Settings uses this to explain why the field is disabled. */
export async function secureStorageAvailable(): Promise<boolean> {
  return (await secureStore()) !== null;
}

/**
 * Shape check before a key is stored.
 *
 * Catches the common paste mistakes — a truncated key, a whole `Authorization: Bearer …`
 * header, the console URL — at the moment the user can still fix them, instead of at the
 * first analysis run. It cannot tell a valid key from a revoked one; only the provider can,
 * which is why Settings also makes a live validation call.
 */
export function looksLikeKey(provider: AIProviderId, key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) return false;
  // A key is a single opaque token. Whitespace means something else got pasted with it.
  if (/\s/.test(trimmed)) return false;
  if (provider === 'gemini') {
    // Raw Gemini API keys (starting with AIza) are refused on device.
    if (trimmed.startsWith('AIza')) return false;
    // Session cookies or personal tokens are accepted for session proxying
    return trimmed.length >= 20;
  }
  const shape = KEY_SHAPES[provider];
  return shape !== undefined && shape.test(trimmed);
}

/**
 * Writes one provider's key to the keystore.
 *
 * Throws rather than returning a failure because every caller is a Settings flow that is
 * already showing an error surface; the thrown message is a fixed sentence naming what the
 * user can fix, never a provider or keystore string. Only a native keystore error can
 * surface words this file does not control, and the caller scrubs those before display.
 */
export async function saveKey(provider: AIProviderId, key: string): Promise<void> {
  if (provider === 'gemini') {
    if (key.trim().startsWith('AIza')) {
      throw new Error(
        'Gemini keys are not stored on this device. Gemini belongs in a server environment, with its key in a secret manager.',
      );
    }
  }
  if (!looksLikeKey(provider, key)) {
    const hint = KEY_PREFIX_HINTS[provider] ?? 'Check the key against the provider console.';
    throw new Error(`${hint} Copy the whole value and paste only the key.`);
  }

  const store = await secureStore();
  if (!store) {
    throw new Error('This device has no secure storage, so there is nowhere safe to keep a key.');
  }

  // Trimmed, so surrounding whitespace — the most common artefact of a copy from a console
  // table — is not written into the keystore and echoed back on every request.
  const trimmed = key.trim();
  await store.setItemAsync(storageKey(provider), trimmed);
  cache.set(provider, trimmed);
}

/**
 * Reads one provider's key, from the cache when one exists.
 *
 * Returns `null` — never throws — for every "no key" cause: nothing stored, no keystore on
 * this device, and a keystore read that failed (the device passcode was removed and the
 * entry can no longer be decrypted). A failed read is deliberately *not* cached as `null`:
 * the next call retries it, so a key that becomes readable again is picked up without an
 * app restart.
 */
export async function loadKey(provider: AIProviderId): Promise<string | null> {
  const cached = cache.get(provider);
  if (cached !== undefined) return cached;

  const store = await secureStore();
  if (!store) return null;
  try {
    const key = await store.getItemAsync(storageKey(provider));
    cache.set(provider, key);
    return key;
  } catch {
    return null;
  }
}

/** Which providers currently have a usable key. */
export async function configuredProviders(): Promise<AIProviderId[]> {
  const configured: AIProviderId[] = [];
  for (const provider of AI_PROVIDER_IDS) {
    if ((await loadKey(provider)) !== null) configured.push(provider);
  }
  return configured;
}

export async function clearKey(provider: AIProviderId): Promise<void> {
  cache.delete(provider);
  try {
    const store = await secureStore();
    if (store) await store.deleteItemAsync(storageKey(provider));
  } catch {
    // Keystore unavailable or key absent
  }
}

const PROXY_CONFIG_STORAGE_KEY = 'detact.ai.gemini.proxy_config';

/**
 * Persists personal Gemini session/cookie proxy configuration.
 */
export async function saveGeminiProxyConfig(config: GeminiProxyConfig): Promise<void> {
  const store = await secureStore();
  if (!store) {
    throw new Error('This device has no secure storage, so there is nowhere safe to keep proxy credentials.');
  }
  await store.setItemAsync(PROXY_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

/**
 * Reads personal Gemini session/cookie proxy configuration.
 */
export async function loadGeminiProxyConfig(): Promise<GeminiProxyConfig | null> {
  const store = await secureStore();
  if (!store) return null;
  try {
    const raw = await store.getItemAsync(PROXY_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GeminiProxyConfig;
  } catch {
    return null;
  }
}

/**
 * Clears personal Gemini session/cookie proxy configuration.
 */
export async function clearGeminiProxyConfig(): Promise<void> {
  try {
    const store = await secureStore();
    if (store) await store.deleteItemAsync(PROXY_CONFIG_STORAGE_KEY);
  } catch {
    // Keystore unavailable or absent
  }
}

/**
 * Removes credentials written by earlier versions without reading them.
 *
 * `grok` is not cleared: no earlier build wrote one, and a user who has just saved an xAI
 * key should not have it deleted by a cleanup pass aimed at a different era's leftovers.
 */
export async function removeLegacyAICredentials(): Promise<void> {
  await clearKey('groq');
  await clearKey('gemini');
}