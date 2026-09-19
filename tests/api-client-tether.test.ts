import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tethered Android release.
 *
 * `vitest.config.mts` aliases `react-native` to `react-native-web`, so `Platform.OS` is
 * `'web'` in every other test file and the native branch of `apiBaseUrl()` is never entered.
 * That is why this shipped: the guard that discards a loopback address on a device was
 * unreachable by the suite, and the only configuration it affects is the one that is not the
 * default. This file mocks the platform as Android so that branch is actually executed.
 *
 * What is being protected here is a real release path, not a hypothetical. DEVELOPMENT.md
 * documents the Android release as tethered — `EXPO_PUBLIC_API_BASE_URL=http://localhost:8787`
 * plus `adb reverse tcp:8787 tcp:8787`, which maps the handset's loopback onto the development
 * machine's — and `plugins/with-android-security.js` whitelists cleartext to exactly
 * `localhost` and `127.0.0.1` to permit it. The guard discarded that address anyway, so the
 * build fell through to the device-local adapter and reported nothing. The failure mode was
 * silence: an APK built to use the PC backend simply was not using one.
 */
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const { apiBaseUrl } = await import('../src/services/api-client');

// The production branch. Under Vitest `NODE_ENV` is `test`, which short-circuits the guard
// entirely — leaving it set would pass these tests without ever reaching the code they name.
beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('loopback platform API on a device', () => {
  it('discards a loopback address when the build did not opt in', () => {
    // An untethered handset: `localhost` is the phone itself and nothing serves there. The
    // address is dropped so requests fail fast instead of timing out on every call.
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:8787');
    expect(apiBaseUrl()).toBeNull();

    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://127.0.0.1:8787');
    expect(apiBaseUrl()).toBeNull();
  });

  it('keeps a loopback address when the build opted into the tether', () => {
    vi.stubEnv('EXPO_PUBLIC_API_ALLOW_LOOPBACK', '1');

    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:8787');
    expect(apiBaseUrl()).toBe('http://localhost:8787');

    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://127.0.0.1:8787');
    expect(apiBaseUrl()).toBe('http://127.0.0.1:8787');
  });

  it('treats any value other than the exact opt-in as not opted in', () => {
    // A truthy-looking flag must not enable a tether. Expo inlines these as strings, so
    // `EXPO_PUBLIC_API_ALLOW_LOOPBACK=false` would otherwise read as enabled.
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:8787');

    for (const value of ['0', 'false', 'true', 'yes', '']) {
      vi.stubEnv('EXPO_PUBLIC_API_ALLOW_LOOPBACK', value);
      expect(apiBaseUrl()).toBeNull();
    }
  });

  it('does not let the opt-in widen what an address is allowed to be', () => {
    // The tether permits a loopback host on a device. It grants nothing else: cleartext to a
    // public host stays rejected, so the flag cannot be used to point a release at plain HTTP.
    vi.stubEnv('EXPO_PUBLIC_API_ALLOW_LOOPBACK', '1');

    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://evidence.example');
    expect(apiBaseUrl).toThrow('HTTPS');

    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://user:password@example.com');
    expect(apiBaseUrl).toThrow('HTTPS');
  });

  it('leaves a remote HTTPS address untouched on a device', () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://evidence.example');
    expect(apiBaseUrl()).toBe('https://evidence.example');
  });

  it('still reports no platform API when none is configured', () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', '');
    expect(apiBaseUrl()).toBeNull();
  });
});
