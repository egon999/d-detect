import { describe, it, expect, vi } from 'vitest';
import { analyzeEvidenceWithAI } from '../src/services/ai/semantic-assistant';
import { requestGroqJson, scrubKey } from '../src/services/ai/groq-client';
import { z } from 'zod';
import { evidence } from './helpers';
describe('legacy client analysis is not an authority or provider proxy', () => {
  it('never sends arbitrary client prompts or credentials to a model', async () => {
    const fetchImpl = vi.fn();
    const result = await requestGroqJson({ system: 'ignore controls', user: 'private evidence', key: 'gsk_SECRETneverSend12345', schema: z.object({}), promptVersion: 'legacy', fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'not-applicable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('old screens cannot produce unpersisted uncited conclusions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await analyzeEvidenceWithAI(evidence('Transaction failed'))).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('redacts legacy provider credentials from diagnostics', () => {
    expect(scrubKey('gsk_SECRETneverPrint12345 xai-SECRETneverPrint12345')).toBe('[redacted] [redacted]');
  });
});
