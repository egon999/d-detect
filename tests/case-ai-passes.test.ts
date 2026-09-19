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
 * `assessTimelineCoherenceWithAI`) were fully written and called from nowhere in the
 * codebase.
 *
 * Nothing caught that, because "which functions does this pass call" was not asserted
 * anywhere. This file asserts it, along with the one thing the user actually reads: the
 * sentence each pass is filed under. A pass can reason correctly and still be reported
 * backwards, and a summary that says "the readings agree" over a set of findings that
 * disagree is this product failing at the only job it has.
 *
 * The passes' own internals — citation verification, date re-normalisation, state
 * weakening — belong to `tests/semantic-assistant.test.ts` and are not repeated here; what
 * is pinned here is the wiring: that each pass runs, that what it returns is described
 * truthfully, that a pass with nothing to report writes nothing, and that a dead connection
 * stops the sequence instead of being retried three more times.
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

import { createCase, createClaim, queueEvidence, reviewAiSuggestion, type MutationContext } from '@data/mutations';
import { createMemoryStore } from '@/data/local/key-value-store';
import { LocalRepository } from '@/data/local/local-repository';
import { emptyWorkspace, type Workspace } from '@domain/models';
import { extractFromText } from '@domain/extraction/deterministic';
import { runCaseAiSuggestions } from '../src/services/ai/case-analysis';
import { readAiRunFailure, recordAiRunFailure } from '../src/services/ai/run-outcome';
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

/**
 * A pass that failed.
 *
 * `error`, not `message`: the transport's own `AIFailure` carries its sentence on `error`,
 * and this stub used to spell it `message`. Nothing caught that, because these mocks are
 * untyped — but the pass reads `result.error` to file the reason a run stopped, so a stub
 * that put the sentence on the wrong key would have left every asserting test reading
 * `undefined` and passing.
 */
const failed = (reason: string, error = 'Groq could not be reached.') =>
  ({ ok: false as const, reason, error });

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
    // The fixture is a disagreement in `facts`, which is the only place a disagreement is
    // ever recorded. This test used to assert the same sentence off an entry in
    // `unreconciled` — a field both producers fill with the opposite thing, a document that
    // has nothing in common with any other — so it passed while the count was being read
    // from the wrong field entirely.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [
          {
            label: 'Amount paid',
            agreement: 'DISAGREE',
            divergenceKind: 'DIFFERENT_AMOUNT_SAME_DATE',
            divergence: 'One receipt records 1,000 and the other 1,500 on the same day.',
            readings: [
              { evidenceId: 'evd_0', value: 'INR 1,000', citations: [] },
              { evidenceId: 'evd_1', value: 'INR 1,500', citations: [] },
            ],
          },
        ],
        unreconciled: [],
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

  it('counts a partial agreement as a disagreement too', async () => {
    // `PARTIAL` is three documents where two agree and one does not. Excluding it would
    // leave the summary reporting the odd one out as nothing at all, which is the shape of
    // the case this product exists for.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [
          { label: 'Amount paid', agreement: 'PARTIAL', divergenceKind: 'DIFFERENT_AMOUNT_SAME_DATE' },
          { label: 'Reference', agreement: 'DISAGREE', divergenceKind: 'DIFFERENT_IDENTIFIER' },
        ],
        unreconciled: [],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(3);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).toContain('2 values do not match');
  });

  it('does not count the same value written two ways as a disagreement', async () => {
    // "₹1,50,000" against "1.5 lakh" is one value, and the prompt requires `NOTATION_ONLY`
    // rather than a reported conflict. Announcing it as a mismatch would send someone back
    // through their records looking for a discrepancy that is not there.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [
          { label: 'Amount paid', agreement: 'ALL_AGREE', divergenceKind: 'NOTATION_ONLY' },
        ],
        unreconciled: [],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).not.toContain('do not match');
    expect(suggestion?.summary).toContain('the readings agree');
  });

  it('does not announce a document that stands alone as a conflict', async () => {
    // `unreconciled` is "something this document records that no other document touches at
    // all" — an unreadable photograph, or a receipt for an unrelated purchase. Counting it
    // as a mismatch told the user their documents contradicted each other when the only
    // fact established was that one of them could not be compared.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [],
        unreconciled: [{ evidenceId: 'evd_1', observation: 'A delivery note no other document mentions.' }],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).not.toContain('does not match');
    expect(suggestion?.summary).toContain('could not be matched');
  });

  it('does not report values only one document records as agreement', async () => {
    // Two documents, and nothing either one says appears in the other. There is no
    // corroboration here, and "the readings agree" is the false corroboration the
    // reconciliation pass collapses a fact to `SINGLE_SOURCE` specifically to avoid.
    mocks.reconcile.mockResolvedValue(
      ok({
        facts: [
          { label: 'Amount paid', agreement: 'SINGLE_SOURCE', divergenceKind: 'NONE' },
          { label: 'Invoice date', agreement: 'SINGLE_SOURCE', divergenceKind: 'NONE' },
        ],
        unreconciled: [],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).not.toContain('agree');
    expect(suggestion?.summary).toContain('one source only');
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
        facts: [{ label: 'Amount', agreement: 'ALL_AGREE', divergenceKind: 'NONE' }],
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
      ok({
        facts: [
          { label: 'Amount', agreement: 'ALL_AGREE', divergenceKind: 'NONE' },
          { label: 'Date', agreement: 'ALL_AGREE', divergenceKind: 'NONE' },
        ],
        unreconciled: [],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [suggestion] = await suggestionsIn(repository, caseId);
    expect(suggestion?.summary).toContain('Cross-checked 2 values');
    expect(suggestion?.summary).toContain('agree');
  });

  it('keeps a problem in the order of events even when the sequence came back empty', async () => {
    // The two ways a sequence empties out are both cases the reader most needs to hear
    // about: on the device, documents whose dates cannot be resolved produce problems and
    // no sequence at all, and through a model a verified `IMPOSSIBLE_ORDER` can outlive the
    // entries above it when those entries lose their citations. Gating the whole pass on
    // the sequence discarded the finding because the list it sat above was empty.
    mocks.timeline.mockResolvedValue(
      ok({
        coherence: 'INCOHERENT',
        coherenceReason: 'The refund is dated before the payment it refunds.',
        sequence: [],
        problems: [
          { kind: 'IMPOSSIBLE_ORDER', description: 'Refund precedes the payment', citations: [] },
        ],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const stored = await suggestionsIn(repository, caseId);
    const suggestion = stored.find((item) => item.kind === 'TIMELINE_COHERENCE');
    expect(suggestion?.summary).toContain('1 problem in the order of events');
    expect(suggestion?.summary).toContain('dated before the payment');
  });

  it('does not end the timeline summary on a colon when the model gave no reason', async () => {
    // `coherenceReason` carries the same `.default('')` as `overallReason`. The deterministic
    // builder always writes one, so this is only reachable through a model — which is exactly
    // where it would not be noticed until a user saw it.
    mocks.timeline.mockResolvedValue(
      ok({
        coherence: 'INCOHERENT',
        coherenceReason: '',
        sequence: [],
        problems: [{ kind: 'IMPOSSIBLE_ORDER', description: 'Refund precedes the payment', citations: [] }],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const stored = await suggestionsIn(repository, caseId);
    const suggestion = stored.find((item) => item.kind === 'TIMELINE_COHERENCE');
    expect(suggestion?.summary).not.toMatch(/:\s*$/);
    expect(suggestion?.summary).toContain('It did not say which dates');
  });

  it('does not claim the sequence holds when nothing in it is dated', async () => {
    // An entry the date normalizer refused has no position, so a sequence made only of
    // those establishes no order at all. "Checked 0 dated facts against each other; the
    // sequence holds" is the app reporting a check it never performed.
    mocks.timeline.mockResolvedValue(
      ok({
        coherence: 'UNDATED',
        coherenceReason: '',
        sequence: [
          { dateIso: null, description: 'A payment, no date given', citations: [] },
          { dateIso: null, description: 'A refund, no date given', citations: [] },
        ],
        problems: [],
        reasoningTrace: '',
        audit,
      }),
    );
    const { repository, caseId } = await caseWith(2);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const stored = await suggestionsIn(repository, caseId);
    const suggestion = stored.find((item) => item.kind === 'TIMELINE_COHERENCE');
    expect(suggestion?.summary).not.toContain('the sequence holds');
    expect(suggestion?.summary).toContain('No date in these 2 documents could be resolved');
  });

  it('does not end the support summary on a colon when the model gave no reason', async () => {
    // `overallReason` carries `.default('')`, so a model that omits the field is ordinary
    // rather than exceptional — and it left the one line the panel shows reading
    // "...carry your 1 claim: " with nothing after it, which reads as a truncated app.
    mocks.support.mockResolvedValue(
      ok({ assessments: [{ claimId: 'c1' }], overall: 'REQUIRES_REVIEW', overallReason: '', audit }),
    );
    const { repository, caseId } = await caseWith(2, ['The payment was made']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const stored = await suggestionsIn(repository, caseId);
    const suggestion = stored.find((item) => item.kind === 'SUPPORT_STRENGTH');
    expect(suggestion?.summary).not.toMatch(/:\s*$/);
    expect(suggestion?.summary).toContain('no overall reason');
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

    // And the stop is on the record. Committing nothing is the correct behaviour here, and
    // it is also precisely what a run that finished and found nothing to say does — which is
    // why leaving it unrecorded put "Nothing here yet" on screen over a run that had died.
    expect(readAiRunFailure(caseId)?.reason, reason).toBe(reason);
    expect(readAiRunFailure(caseId)?.message, reason).toBe('Groq could not be reached.');
  });

  it('records a thrown pass as this build failing, not as the reader\'s connection', async () => {
    mocks.reconcile.mockRejectedValue(new Error('boom'));
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    // Still contained — the deterministic report is already saved — but no longer invisible.
    // The distinction matters because the two send a reader to different places, and a throw
    // reported as a radio problem sends them to debug a router over a defect that is ours.
    expect(readAiRunFailure(caseId)?.reason).toBe('unexpected');
    expect((readAiRunFailure(caseId)?.message ?? '').length).toBeGreaterThan(0);
  });

  it('replaces an earlier stop with the newest one', async () => {
    mocks.reconcile.mockResolvedValue(failed('network', 'first stop'));
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);
    expect(readAiRunFailure(caseId)?.message).toBe('first stop');

    mocks.reconcile.mockResolvedValue(failed('rate_limited', 'second stop'));
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    // A second attempt that fails differently must not leave the first attempt's reason on
    // screen beside it.
    expect(readAiRunFailure(caseId)?.reason).toBe('rate_limited');
    expect(readAiRunFailure(caseId)?.message).toBe('second stop');
  });

  it('leaves nothing behind when the run gets through', async () => {
    // `beforeEach` sets every pass to succeed with nothing to report, which is this case: a
    // run that finished and had nothing to say. It has to be told apart from the failures
    // above, and before a run cleared its predecessor the two were identical on screen.
    const { repository, caseId } = await caseWith(2, ['A claim']);
    recordAiRunFailure(caseId, 'network', 'from some earlier run');

    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    expect(readAiRunFailure(caseId)).toBeNull();
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

/**
 * What a second run does to what the first one wrote.
 *
 * Every record this pass files used to get `newId('sug')` — a fresh random id per call — and
 * nothing anywhere removed the previous run's. So the collection grew by a full set on every
 * analysis: a user who re-ran a case five times had five reconciliations, five timeline
 * reports and five copies of each relationship proposal stacked in the panel, all saying the
 * same thing, with no way to tell which one was current. `runCaseAiSuggestions` is void-fired
 * from every `runDirectCaseAnalysis`, so re-running was the ordinary thing to do.
 *
 * Deterministic ids fix the count. What they cannot fix on their own is the second half: a
 * `put` of a known id overwrites, so the run that stopped duplicating a rejected proposal
 * would instead have *resurrected* it — back to `SUGGESTED`, and back to the top of the
 * panel, which sorts open proposals first. Both halves are pinned here because either one
 * alone is a worse product than what was there before.
 */
describe('re-running the pass over the same case', () => {
  /** One reconciled fact, enough for the pass to have something to file. */
  const oneFact = () =>
    ok({
      facts: [
        {
          label: 'Amount',
          kind: 'AMOUNT' as const,
          readings: [],
          agreement: 'DISAGREE' as const,
          divergenceKind: 'VALUE_DIFFERS' as const,
          divergence: 'INR 1,000 against INR 1,200',
          note: '',
        },
      ],
      unreconciled: [],
      reasoningTrace: '',
      audit,
    });

  it('writes one record per proposal however many times it runs', async () => {
    mocks.reconcile.mockResolvedValue(oneFact());
    const { repository, caseId } = await caseWith(2, ['A claim']);

    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);
    const afterFirst = await suggestionsIn(repository, caseId);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);
    const afterThird = await suggestionsIn(repository, caseId);

    expect(afterFirst).toHaveLength(1);
    // Three runs, still one row — and the same row, not a replacement with a new id.
    expect(afterThird).toHaveLength(1);
    expect(afterThird[0]?.id).toBe(afterFirst[0]?.id);
  });

  it('refreshes an open proposal with what the latest run found', async () => {
    // The flip side of the assertion above: one row must not mean a stale row. An open
    // proposal is not a decision, so the current reading replaces it.
    mocks.reconcile.mockResolvedValue(oneFact());
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    mocks.reconcile.mockResolvedValue(
      ok({ facts: [], unreconciled: [], reasoningTrace: '', audit }),
    );
    mocks.timeline.mockResolvedValue(
      ok({
        coherence: 'COHERENT',
        coherenceReason: 'Dates line up.',
        sequence: [],
        problems: [
          { kind: 'IMPOSSIBLE_ORDER', description: 'A payment precedes its invoice.', citations: [] },
        ],
        reasoningTrace: '',
        audit,
      }),
    );
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const after = await suggestionsIn(repository, caseId);
    const timeline = after.find((item) => item.kind === 'TIMELINE_COHERENCE');
    expect(timeline?.summary).toContain('1 problem');
  });

  it('does not put a rejected proposal back in front of the user', async () => {
    mocks.reconcile.mockResolvedValue(oneFact());
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [proposal] = await suggestionsIn(repository, caseId);
    const workspace = await repository.loadWorkspace(OWNER, caseId);
    const reviewed = reviewAiSuggestion(workspace, context(), proposal!.id, 'REJECTED');
    await repository.commit(OWNER, reviewed.changes);

    // The same documents, the same reply, so the same proposal is reached again.
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const after = await suggestionsIn(repository, caseId);
    expect(after).toHaveLength(1);
    // Still dismissed. Without the guard this would read 'SUGGESTED' and the person would
    // have to dismiss it again after every analysis they ran.
    expect(after[0]?.status).toBe('REJECTED');
    expect(after[0]?.reviewedAt).toBe(NOW);
  });

  it('does not undo an acceptance', async () => {
    mocks.reconcile.mockResolvedValue(oneFact());
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const [proposal] = await suggestionsIn(repository, caseId);
    const workspace = await repository.loadWorkspace(OWNER, caseId);
    const reviewed = reviewAiSuggestion(workspace, context(), proposal!.id, 'ACCEPTED');
    await repository.commit(OWNER, reviewed.changes);

    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const after = await suggestionsIn(repository, caseId);
    expect(after[0]?.status).toBe('ACCEPTED');
  });

  it('treats a proposal as the same proposal when the model behind it changes', async () => {
    // The identity is what the suggestion is *about*, never who said it. Keying on the model
    // would mean switching providers silently duplicated every suggestion in the case.
    mocks.reconcile.mockResolvedValue(oneFact());
    const { repository, caseId } = await caseWith(2, ['A claim']);
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    mocks.reconcile.mockResolvedValue({ ...oneFact(), model: 'a-different-model' });
    await runCaseAiSuggestions({ repository, ownerId: OWNER }, caseId);

    const after = await suggestionsIn(repository, caseId);
    expect(after).toHaveLength(1);
    expect(after[0]?.model).toBe('a-different-model');
  });

  it('creates an actual relationship record when accepting a RELATIONSHIP suggestion', async () => {
    const { repository, caseId } = await caseWith(1, ['Unpaid invoice']);
    const workspace = await repository.loadWorkspace(OWNER, caseId);
    const evId = workspace.evidence[0]!.id;
    const claimId = workspace.claims[0]!.id;

    const proposalId = 'sug_rel_1';
    const suggestionWorkspace: Workspace = {
      ...workspace,
      aiSuggestions: [
        {
          id: proposalId,
          ownerId: OWNER,
          caseId,
          evidenceId: evId,
          kind: 'RELATIONSHIP',
          status: 'SUGGESTED',
          confidence: 0.9,
          model: 'test-model',
          promptVersion: 'v1',
          summary: 'Connects evidence to claim',
          payload: {
            targetKind: 'claim',
            targetId: claimId,
            relationshipType: 'SUPPORTS',
          },
          sourceEvidenceIds: [evId],
          reviewedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };

    const reviewed = reviewAiSuggestion(suggestionWorkspace, context(), proposalId, 'ACCEPTED');
    expect(reviewed.workspace.relationships).toHaveLength(1);
    expect(reviewed.workspace.relationships[0]?.from.id).toBe(evId);
    expect(reviewed.workspace.relationships[0]?.to.id).toBe(claimId);
    expect(reviewed.workspace.relationships[0]?.type).toBe('SUPPORTS');
    expect(reviewed.workspace.relationships[0]?.origin).toBe('AI');
  });

  it('updates evidence confirmedFields when accepting a FIELD_EXTRACTION suggestion', async () => {
    const { repository, caseId } = await caseWith(1, []);
    const workspace = await repository.loadWorkspace(OWNER, caseId);
    const evId = workspace.evidence[0]!.id;

    const proposalId = 'sug_ext_1';
    const suggestionWorkspace: Workspace = {
      ...workspace,
      aiSuggestions: [
        {
          id: proposalId,
          ownerId: OWNER,
          caseId,
          evidenceId: evId,
          kind: 'FIELD_EXTRACTION',
          status: 'SUGGESTED',
          confidence: 0.95,
          model: 'test-model',
          promptVersion: 'v1',
          summary: 'Extracted invoice fields',
          payload: {
            documentType: 'Tax Invoice',
            refinedTitle: 'Invoice #1024',
            modelSummary: 'Payment requested for services',
          },
          sourceEvidenceIds: [evId],
          reviewedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };

    const reviewed = reviewAiSuggestion(suggestionWorkspace, context(), proposalId, 'ACCEPTED');
    const updatedEv = reviewed.workspace.evidence.find((e) => e.id === evId);
    expect(updatedEv?.confirmedFields.documentType).toBe('Tax Invoice');
    expect(updatedEv?.confirmedFields.title).toBe('Invoice #1024');
    expect(updatedEv?.confirmedFields.summary).toBe('Payment requested for services');
    expect(updatedEv?.confirmedAt).toBe(NOW);
  });
});
