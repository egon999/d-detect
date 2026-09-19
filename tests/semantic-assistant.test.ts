import { describe, it, expect, vi } from 'vitest';
import { analyzeEvidenceWithAI, buildDeterministicReconciliation } from '../src/services/ai/semantic-assistant';
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

/**
 * Three documents that disagree, with no model in the room.
 *
 * This is the question the product is for, asked of the user who has connected no API key —
 * which is the default user. Nothing below is mocked: the text goes through the real
 * extractor, the amounts are compared as integer minor units, and every reading has to earn
 * a citation from `verifyCitations` against its own segment text before it is reported.
 */
describe('finding the disagreement on the device', () => {
  const AMOUNT = /Largest INR amount/;

  it('reports three documents where one contradicts the other two as a partial agreement', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 9,500 on 04/02/2024'),
    ]);

    const fact = result.facts.find((entry) => AMOUNT.test(entry.label));
    // Not `DISAGREE`: two of the three do corroborate each other, and flattening that to a
    // three-way conflict would misdescribe which document is the odd one out.
    expect(fact?.agreement).toBe('PARTIAL');
    expect(fact?.divergenceKind).toBe('DIFFERENT_AMOUNT_SAME_DATE');
    expect(fact?.readings).toHaveLength(3);
  });

  it('quotes every reading out of the document it came from', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 9,500 on 04/02/2024'),
    ]);

    const fact = result.facts.find((entry) => AMOUNT.test(entry.label));
    // A disagreement a user cannot trace back to the page it came from is an assertion, not
    // a finding. The deterministic path is held to the same standard as the model's.
    for (const reading of fact?.readings ?? []) {
      expect(reading.citations.length).toBeGreaterThan(0);
      for (const citation of reading.citations) {
        expect(citation.evidenceId).toBe(reading.evidenceId);
        expect(citation.endOffset).toBeGreaterThan(citation.startOffset);
      }
    }
  });

  it('calls it a disagreement only when no two documents agree', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 9,500 on 04/02/2024'),
      evidence('Amount paid INR 7,000 on 04/02/2024'),
    ]);

    expect(result.facts.find((entry) => AMOUNT.test(entry.label))?.agreement).toBe('DISAGREE');
  });

  it('does not corroborate a value only one document records', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Received on 05/02/2024 with thanks'),
    ]);

    // One reading is not a cross-check. `SINGLE_SOURCE` is what stops the panel from
    // presenting an uncorroborated figure as agreed between the documents.
    expect(result.facts.find((entry) => AMOUNT.test(entry.label))?.agreement).toBe('SINGLE_SOURCE');
  });

  it('files a document with nothing comparable as unreconciled, never as a conflict', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Thank you for your custom'),
    ]);

    // The distinction the summary line depends on: a document carrying no amount, date or
    // reference has not contradicted anything. It could not be compared.
    expect(result.unreconciled).toHaveLength(1);
    expect(result.unreconciled[0]?.observation).toContain('no amount, date or reference');
    expect(result.facts.find((entry) => AMOUNT.test(entry.label))?.agreement).toBe('ALL_AGREE');
  });

  it('never reports a score for how well the documents agree', async () => {
    const result = buildDeterministicReconciliation([
      evidence('Amount paid INR 12,000 on 04/02/2024'),
      evidence('Amount paid INR 9,500 on 04/02/2024'),
    ]);

    // A single number standing for agreement is the decorative form of this feature: it
    // looks like analysis and cannot be acted on. The shape of the difference is the finding.
    for (const fact of result.facts) {
      expect(fact).not.toHaveProperty('score');
      expect(fact).not.toHaveProperty('similarity');
      expect(fact).not.toHaveProperty('confidence');
    }
  });
});
