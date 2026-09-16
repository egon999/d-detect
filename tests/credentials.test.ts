import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', async () => (await import('./secure-store-double')).secureStoreDouble);

import {
  AI_PROVIDER_IDS,
  clearKey,
  configuredProviders,
  loadKey,
  looksLikeKey,
  removeLegacyAICredentials,
  resetCredentialsCacheForTests,
  saveKey,
} from '../src/services/ai/credentials';
import {
  failNextSecureStoreRead,
  resetSecureStoreDouble,
  secureStoreSize,
  setSecureStoreAvailable,
} from './secure-store-double';

/**
 * Bring-your-own-key storage.
 *
 * Every test runs against the in-memory keystore double, because the keystore is now the
 * only place a key can come from and "nothing stored" is the only state plain Node can
 * reach. Both resets run before each test: the double's map, and the module's own caches —
 * the resolved native-module handle and the per-provider key cache.
 */

const GROQ_KEY = `gsk_${'a'.repeat(28)}`;
const XAI_KEY = `xai-${'b'.repeat(28)}`;

beforeEach(() => {
  resetSecureStoreDouble();
  resetCredentialsCacheForTests();
});

describe('saving and loading a key', () => {
  it('round-trips a Groq key through the keystore', async () => {
    await saveKey('groq', GROQ_KEY);
    expect(await loadKey('groq')).toBe(GROQ_KEY);
  });

  it('round-trips an xAI key through the keystore', async () => {
    await saveKey('grok', XAI_KEY);
    expect(await loadKey('grok')).toBe(XAI_KEY);
  });

  it('trims the pasted value before storing, so console copy artefacts never reach a request', async () => {
    await saveKey('grok', `  ${XAI_KEY}\n`);
    expect(await loadKey('grok')).toBe(XAI_KEY);
  });

  it('keeps each provider\u2019s key under its own entry', async () => {
    await saveKey('groq', GROQ_KEY);
    await saveKey('grok', XAI_KEY);
    expect(await loadKey('groq')).toBe(GROQ_KEY);
    expect(await loadKey('grok')).toBe(XAI_KEY);
    expect(await configuredProviders()).toEqual(['groq', 'grok']);
  });

  it('lists only the providers that actually have a key', async () => {
    await saveKey('grok', XAI_KEY);
    expect(await configuredProviders()).toEqual(['grok']);
  });

  it('reports a failed keystore read as no key, and retries the read rather than caching the failure', async () => {
    await saveKey('groq', GROQ_KEY);
    resetCredentialsCacheForTests();
    failNextSecureStoreRead();
    expect(await loadKey('groq')).toBeNull();
    // The failure was not memoised as "absent": the very next call sees the key again.
    expect(await loadKey('groq')).toBe(GROQ_KEY);
  });
});

describe('key shape validation', () => {
  it('accepts the Groq key shape', () => {
    expect(looksLikeKey('groq', GROQ_KEY)).toBe(true);
  });

  it('accepts the xAI key shape', () => {
    expect(looksLikeKey('grok', XAI_KEY)).toBe(true);
  });

  it('refuses a key offered to the wrong provider', () => {
    expect(looksLikeKey('groq', XAI_KEY)).toBe(false);
    expect(looksLikeKey('grok', GROQ_KEY)).toBe(false);
  });

  it('refuses truncated keys, headers and pasted commands', () => {
    expect(looksLikeKey('groq', 'gsk_abc')).toBe(false);
    expect(looksLikeKey('grok', 'xai-abc')).toBe(false);
    expect(looksLikeKey('groq', `Bearer ${GROQ_KEY}`)).toBe(false);
    expect(looksLikeKey('groq', `curl -H "Authorization: Bearer ${GROQ_KEY}"`)).toBe(false);
  });

  it('refuses to store a key that fails its shape check', async () => {
    await expect(saveKey('groq', 'not-a-key')).rejects.toThrow(/starts with "gsk_"/);
    await expect(saveKey('grok', GROQ_KEY)).rejects.toThrow(/starts with "xai-"/);
    expect(await loadKey('groq')).toBeNull();
    expect(secureStoreSize()).toBe(0);
  });
});

describe('gemini stays server-only', () => {
  it('refuses to store a Gemini key on the device', async () => {
    await expect(saveKey('gemini', `AIza${'c'.repeat(35)}`)).rejects.toThrow(/Gemini keys are not stored/);
    expect(await loadKey('gemini')).toBeNull();
  });

  it('never appears in the configured list, even to a shape check', () => {
    expect(looksLikeKey('gemini', `AIza${'c'.repeat(35)}`)).toBe(false);
  });

  it('removes keys stored by earlier versions without reading them', async () => {
    await saveKey('groq', GROQ_KEY);
    await removeLegacyAICredentials();
    expect(await loadKey('groq')).toBeNull();
    expect(secureStoreSize()).toBe(0);
  });

  it('leaves a grok key alone: no earlier build could have written one', async () => {
    await saveKey('grok', XAI_KEY);
    await removeLegacyAICredentials();
    expect(await loadKey('grok')).toBe(XAI_KEY);
  });
});

describe('clearKey', () => {
  it('removes the key from the keystore and the cache', async () => {
    await saveKey('groq', GROQ_KEY);
    await clearKey('groq');
    expect(await loadKey('groq')).toBeNull();
    expect(secureStoreSize()).toBe(0);
  });

  it('removes only the provider asked about', async () => {
    await saveKey('groq', GROQ_KEY);
    await saveKey('grok', XAI_KEY);
    await clearKey('groq');
    expect(await loadKey('groq')).toBeNull();
    expect(await loadKey('grok')).toBe(XAI_KEY);
  });

  it('succeeds when there is nothing to remove', async () => {
    await clearKey('grok');
    expect(secureStoreSize()).toBe(0);
  });
});

describe('when secure storage is unavailable', () => {
  it('refuses to save and reports no key', async () => {
    setSecureStoreAvailable(false);
    // Drop the memoised module handle so the new availability is observed.
    resetCredentialsCacheForTests();
    await expect(saveKey('groq', GROQ_KEY)).rejects.toThrow(/no secure storage/i);
    expect(await loadKey('groq')).toBeNull();
    expect(await configuredProviders()).toEqual([]);
  });
});

describe('the provider registry', () => {
  it('names exactly the providers the app knows, with gemini last and cleanup-only', () => {
    expect(AI_PROVIDER_IDS).toEqual(['groq', 'grok', 'gemini']);
  });
});