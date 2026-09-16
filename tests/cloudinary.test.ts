import { describe, it, expect, vi } from 'vitest';
import { getCloudinaryConfig, uploadToCloudinary } from '../src/services/storage/cloudinary';
describe('public evidence upload migration', () => {
  it('cannot send private evidence to an unsigned public destination', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(getCloudinaryConfig().isConfigured).toBe(false);
    expect(await uploadToCloudinary({ uri: 'file:///private.pdf', name: 'private.pdf', mimeType: 'application/pdf' })).toMatchObject({ ok: false, retryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
