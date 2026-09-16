import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The case-level AI pass, over a real repository.
 *
 * ## Why this file exists
 *
 * The pass had no test of any kind, and under that cover its wiring had drifted away from
 * the product. It asked a model for a narrative summary of the dispute — fluent, plausible,
 * and a restatement of what the user had just typed in — while the four functions that
 * answer the questions this product exists for (`reconcileDocumentsWithAI`,
 * `assessSupportStrengthWithAI`, `analyzeMissingInformationWithAI`,
 * `assessTimelineCoherenceWithAI`) were fully written, individually tested in
 * `tests/semantic-assistant.test.ts`, and called from nowhere in the codebase.
 *
 * Nothing caught that, because "which functions does this pass call" was not asserted
 * anywhere. This file asserts it. The individual passes' own correctness — citation
 * verification, date re-normalisation, state weakening — belongs to
 * `tests/semantic-assistant.test.ts` and is not repeated here; what is pinned here is the
 * wiring: that each pass runs, that what it returns is filed under a kind that describes
 * it truthfully, that a pass with nothing to report writes nothing, and that a dead
 * connection stops the sequence instead of being retried three more times.
 */

const mocks = vi.hoisted(() => ({
  providers: ['groq'] as string[],
  reconcile: vi.fn(),
  support: vi.fn(),
  missing: vi.fn(),
  timeline: vi.fn(),
  relationships: vi.fn(),
}));

vi.mock('../src/services/ai/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/ai/credentials')>()),
  configuredProviders: async () => mocks.providers,
}));

// Spread the original: this module exports the prompt schemas and helpers the pass pulls in
// alongside these five functions, and a factory naming only the five would fail the file the
// moment production code imported one more thing from it.
vi.mock('../src/services/ai/semantic-assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/ai/semantic-assistant')>()),
  reconcileDocumentsWithAI: mocks.reconcile,
  assessSupportStrengthWithAI: mocks.support,
  analyzeMissingInformationWithAI: mocks.missing,
  assessTimelineCoherenceWithAI: mocks.timeline,
  suggestCaseRelationshipsWithAI: mocks.relationships,
}));

import { createCase, createClaim, queueEvidence, type MutationContext } from '@data/mutations';
import { createMemoryStore } from '@/data/local/key-value-store';
import { LocalRepository } from '@/data/local/local-repository';
import { emptyWorkspace, type Workspace } from '@domain/models';
import { extractFromText } from '@domain/extraction/deterministic';
import { runCaseAiSuggestions } from '../src/services/ai/case-analysis';
import { ON_DEVICE_ENGINE, isOnDeviceSuggestion } from '../src/services/ai/provenance';

const OWNER = 'user_ai';
const NOW = 1_700_000_000_000;
const context = (): MutationContext => ({ ownerId: OWNER, now: NOW });

/** The one line of document text every fixture document carries. */
const SOURCE_TEXT = 'Amount paid INR 1,000 on 04/02/2024';

/** An empty citation audit — the passes' own verification is tested elsewhere. */
const audit = { rejected: [], droppedAssertions: 0, weakenedAssertions: 0 };

const ok = <T,>(data: T) => ({
  ok: true as const,
  data,
  model: 'test-model',
  promptVersion: 'v1',
});

const failed = (reason: string) => ({ ok: false as const, reason, message: 'no' });

/**
 * A case with `count` readable documents, each carrying a segment.
 *
 * `segments.length > 0` is the pass's own filter for "readable": a record whose extraction
 * produced nothing has no text to cite and so nothing to reconcile.
 */
async function caseWith(count: number, claims: string[] = []) {
  const repository = new LocalRepository(createMemoryStore());
  let workspace: Workspace = emptyWorkspace();

  const created = createCase(workspace, context(), { title: 'AI case' });
  await repository.commit(OWNER, created.changes);
  workspace = created.workspace;
  const caseId = workspace.cases[0]!.id;

  for (let index = 0; index < count; index += 1) {
    const queued = queueEvidence(workspace, context(), caseId, {
      id: `evd_${index}`,
      title: `Document ${index}`,
      kind: 'TEXT',
      fileName: `doc${index}.txt`,
      mimeType: 'text/plain',
      sizeBytes: null,
    });
    await repository.commit(OWNER, queued.changes);
    workspace = queued.workspace;
  }

  for (const statement of claims) {
    const claim = createClaim(workspace, context(), caseId, { statement });
    await repository.commit(OWNER, claim.changes);
    workspace = claim.workspace;
  }

  // Extraction is written straight onto the stored records: this file is about which AI
  // passes run, not about how text gets out of a file, which `evidence-pipeline.test.ts`
  // already covers end to end.
  const loaded = await repository.loadWorkspace(OWNER, caseId);
  const { put } = await import('@data/repository');
  await repository.commit(
    OWNER,
    loaded.evidence.map((item) =>
      put('evidence', {
        ...item,
        state: 'EXTRACTED' as const,
        // Built by the real extractor, then given one explicit segment. Hand-writing the
        // record meant maintaining a copy of `extractionSchema`'s required fields here, and
        // the fixture drifted out of validity the moment the schema gained one.
        extraction: {
          ...extractFromText({
            evidenceId: item.id,
            title: item.title,
            text: SOURCE_TEXT,
            method: 'DETERMINISTIC',
          }),
          // Pinned rather than inherited: `segments.length > 0` is the pass's own filter for
          // "readable", and the offsets are what its citation index verifies quotes against.
          segments: [
            {
              id: `seg_${item.id}`,
              text: SOURCE_TEXT,
              startOffset: 0,
              endOffset: SOURCE_TEXT.length,
              method: 'DETERMINISTIC',
              page: 1,
            },
          ],
        },
      }),
    ),
  );

  return { repository, caseId };
}

const suggestionsIn = async (repository: LocalRepository, caseId: string) =>
  (await repository.loadWorkspace(OWNER, caseId)).aiSuggestions;

beforeEach(() => {
  mocks.providers = ['groq'];
  for (const mock of [mocks.reconcile, mocks.support, mocks.missing, mocks.timeline, mocks.relationships]) {
    mock.mockReset();
  }
  // Default: every pass succeeds with nothing to report, so each test sets only the one
  // it is about and the others stay quiet.
  mocks.relationships.mockResolvedValue(ok({ suggestions: [] }));
  mocks.reconcile.mockResolvedValue(ok({ facts: [], unreconciled: [], reasoningTrace: '', audit }));
  mocks.support.mockResolvedValue(ok({ assessments: [], overall: 'REQUIRES_REVIEW', overallReason: '', audit }));
  mocks.missing.mockResolvedValue(
    ok({ gaps: [], alreadyCovered: [], hardLimit: '', reasoningTrace: '', discardedAsGeneric: 0, audit }),
  );
  mocks.timeline.mockResolvedValue(
    ok({ coherence: 'COHERENT', coherenceReason: '', sequence: [], problems: [], reasoningTrace: '', audit }),
  );
});

describe('which questions the case pass actually asks', () => {
  it('runs all four reasoning passes', async () => {
    const { repository, caseId } = await caseWith(2, ['The payment was made']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    // The assertion the old wiring would have failed: these four were dead code.
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.support).toHaveBeenCalledTimes(1);
    expect(mocks.missing).toHaveBeenCalledTimes(1);
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('asks for reconciliation on two documents even with nothing typed in', async () => {
    // The most ordinary case this product has: someone has photographed two receipts and
    // written no claims. The previous guard required a claim or an event and turned them
    // away with no analysis at all.
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    // The two that are meaningless without a claim are correctly not asked.
    expect(mocks.support).not.toHaveBeenCalled();
    expect(mocks.missing).not.toHaveBeenCalled();
  });

  it('asks nothing when there is one document and nothing to assess it against', async () => {
    const { repository, caseId } = await caseWith(1);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.timeline).not.toHaveBeenCalled();
  });

  it('asks nothing at all when no key is configured', async () => {
    mocks.providers = [];
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.support).not.toHaveBeenCalled();
    expect(mocks.missing).not.toHaveBeenCalled();
    expect(mocks.timeline).not.toHaveBeenCalled();
  });
});

describe('with no key connected, on the device', () => {
  /**
   * A user with no API key is the default user of this app, and two of the four questions do
   * not need a model to answer: amounts in one currency are arithmetic and shared identifiers
   * are string equality. The pass used to return at `if (!provider) return`, so that user got
   * nothing — the app declining to do work it could already do, and then showing them a
   * prompt to go and buy a key.
   */
  beforeEach(() => {
    mocks.providers = [];
  });

  it('still compares the documents against each other', async () => {
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const kinds = (await suggestionsIn(repository, caseId)).map((item) => item.kind);
    expect(kinds).toContain('CROSS_DOCUMENT_RECONCILIATION');
  });

  it('records that the device produced it, not a model', async () => {
    // The panel branches on this to show the on-device reading mark instead of the violet
    // AI stamp. A deterministic comparison presented as a model's opinion would break the
    // one guarantee the provenance marks make.
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const stored = await suggestionsIn(repository, caseId);
    expect(stored.length).toBeGreaterThan(0);
    for (const item of stored) {
      expect(item.model).toBe(ON_DEVICE_ENGINE);
      expect(isOnDeviceSuggestion(item)).toBe(true);
      // Still a proposal awaiting a person, exactly like a model's.
      expect(item.status).toBe('SUGGESTED');
    }
  });

  it('does not reach for the network', async () => {
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    for (const mock of [mocks.reconcile, mocks.support, mocks.missing, mocks.timeline, mocks.relationships]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('skips the two questions that need a model to read meaning', async () => {
    // Whether a document *supports* a claim, and what the case is missing, are judgements
    // about meaning. Approximating them on the device would be inventing an answer.
    const { repository, caseId } = await caseWith(2, ['The payment was made']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const kinds = (await suggestionsIn(repository, caseId)).map((item) => item.kind);
    expect(kinds).not.toContain('SUPPORT_STRENGTH');
    expect(kinds).not.toContain('MISSING_INFORMATION');
    expect(kinds).not.toContain('RELATIONSHIP');
  });
});

describe('what it files, and under what name', () => {
  it('files a disagreement under a kind that says so', async () => {
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [],
        unreconciled: [{ description: 'Amounts differ', citations: [] }],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.kind).toBe('CROSS_DOCUMENT_RECONCILIATION');
    // Singular pinned deliberately: "1 value do not match" is the kind of seam that makes
    // a product read as generated, and this codebase inflects its counts everywhere else.
    expect(suggestion?.summary).toContain('1 value does not match');
    // Every stored suggestion is a proposal awaiting a person, never a conclusion.
    expect(suggestion?.status).toBe('SUGGESTED');
    expect(suggestion?.reviewedAt).toBeNull();
  });

  it('never writes the narrative summary the pass used to produce', async () => {
    const { repository, caseId } = await caseWith(2, ['A claim']);
    mocks.support.mockResolvedValue(
      ok({ assessments: [{ claimId: 'c1' }], overall: 'SUPPORTED', overallReason: 'Two sources agree', audit }),
    );
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const kinds = (await suggestionsIn(repository, caseId)).map((item) => item.kind);
    expect(kinds).not.toContain('DISPUTE_SYNTHESIS');
    expect(kinds).toContain('SUPPORT_STRENGTH');
  });

  it('says how many statements it could not trace back to a document', async () => {
    // The honesty mechanism: a panel that shows only what survived verification, and never
    // mentions what did not, is claiming a precision it does not have.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [{ label: 'Amount' }],
        unreconciled: [],
        reasoningTrace: '',
        audit: { rejected: [], droppedAssertions: 3, weakenedAssertions: 1 },
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).toContain('3 further statements');
    expect(suggestion?.summary).toContain('discarded');
  });

  it('writes nothing for a pass that found nothing worth saying', async () => {
    // Every mock returns an empty result by default. An empty suggestion per pass would
    // put four rows of nothing in the panel and teach the user to stop reading it.
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(await suggestionsIn(repository, caseId)).toEqual([]);
  });

  it('reports an agreement as an agreement, not as silence', async () => {
    mocks.reconcile.mockResolvedValue(
      ok({ facts: [{ label: 'Amount' }, { label: 'Date' }], unreconciled: [], reasoningTrace: '', audit }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).toContain('agree');
  });
});

describe('when the connection is the problem', () => {
  it.each(['unavailable', 'rate_limited', 'network'])('stops the sequence on %s', async (reason) => {
    mocks.reconcile.mockResolvedValue(failed(reason));
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    // None of these heal between requests, and three more attempts would spend the user's
    // quota to produce the same error three more times.
    expect(mocks.support).not.toHaveBeenCalled();
    expect(mocks.missing).not.toHaveBeenCalled();
    expect(mocks.timeline).not.toHaveBeenCalled();
  });

  it('carries on past a single malformed reply', async () => {
    // A reply that failed its schema says nothing about the next question.
    mocks.reconcile.mockResolvedValue(failed('invalid_response'));
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(mocks.support).toHaveBeenCalledTimes(1);
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('never lets a thrown pass take the analysis down with it', async () => {
    // The deterministic report is already saved by the time this runs. An optional pass
    // that propagated would turn a completed assessment into a failed one.
    mocks.reconcile.mockRejectedValue(new Error('boom'));
    const { repository, caseId } = await caseWith(2, ['A claim']);

    await expect(runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId)).resolves.toBeUndefined();
  });
});
