import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ currentUser: { uid: 'user_test', getIdToken: vi.fn(async () => 'TOKEN_SENTINEL') } as { uid: string; getIdToken: () => Promise<string> } | null }));
vi.mock('../src/data/firebase/auth', () => ({ firebaseAuth: async () => auth }));
import { apiBaseUrl, apiJson, apiRequest } from '../src/services/api-client';
beforeEach(() => { vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://127.0.0.1:8787'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('platform authenticated transport', () => {
  it('uses the Firebase bearer header and never places credentials in a URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiJson('/api/workspace', {}, 'user_test');
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/api/workspace');
    expect(fetchSpy.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer TOKEN_SENTINEL' });
  });
  it('disallows cleartext internet destinations and credentials embedded in config', () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://internet.example');
    expect(apiBaseUrl).toThrow('HTTPS');
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://user:password@example.com');
    expect(apiBaseUrl).toThrow('HTTPS');
  });
  it('rejects another owner before contacting the backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(apiRequest('/api/workspace', {}, 'user_other')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not expose sensitive server error bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private evidence and gsk_SECRET', { status: 500 }));
    await expect(apiRequest('/api/workspace')).rejects.toThrow('platform service is unavailable');
  });
  it('rejects malformed successful JSON instead of manufacturing data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(apiJson('/api/workspace')).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
