import { describe, expect, it } from 'vitest';

import { itemsNeedingAttention, type AttentionItem } from '@domain/analysis/attention';
import type { AnalysisResult, Case, Evidence, Workspace } from '@domain/models';

import { CASE_ID, OWNER, claim, evidence, resetIds, testCase, workspace } from './helpers';

/**
 * Tests for the "needs attention" read model.
 *
 * The module's own claim is that every row is backed by a stored record, so these tests
 * are written the other way round from most: rather than asserting a row appears, most of
 * them assert a row is *absent* for a record that does not warrant one. A list that
 * over-reports is the failure mode that matters here — the screen it feeds replaced a
 * hard-coded array of four invented notifications.
 */

const stamps = { ownerId: OWNER, caseId: CASE_ID, createdAt: 1_000, updatedAt: 1_000 };

let findingCounter = 0;

function finding(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    ...stamps,
    id: `res_${(findingCounter += 1)}`,
    resultType: 'POSSIBLE_CONFLICT',
    severity: 'HIGH',
    title: 'Amounts do not agree',
    explanation: 'The invoice says INR 85,000 and the receipt says INR 40,000.',
    caveat: '',
    supportingEvidenceIds: [],
    relatedClaimIds: [],
    relatedEventIds: [],
    triggeredRuleIds: ['amount-mismatch@2'],
    aiSuggestionIds: [],
    inputs: {},
    confidence: 'EXACT_MATCH',
    status: 'OPEN',
    provisional: false,
    unconfirmedReads: [],
    reviewedAt: null,
    reviewNote: '',
    ...overrides,
  };
}

/** The ids of the rows produced, in the order the module returned them. */
function ids(items: AttentionItem[]): string[] {
  return items.map((item) => item.id);
}

/**
 * A workspace whose case is already analysed and up to date.
 *
 * The shared `testCase()` helper leaves `lastAnalyzedAt` null, which is itself one of the
 * conditions under test — so using it as the baseline would add a `case-unanalysed` row to
 * every assertion about findings, evidence and claims. Analysed at the same moment the case
 * was last touched, which is inside the staleness tolerance, so the case contributes
 * nothing and each test below sees only the rows it is about.
 */
function ws(parts: Partial<Workspace> = {}): Workspace {
  return workspace({ cases: [testCase({ lastAnalyzedAt: 1_000 })], ...parts });
}

describe('itemsNeedingAttention', () => {
  it('returns nothing for an empty workspace', () => {
    expect(itemsNeedingAttention(ws())).toEqual([]);
  });

  describe('open findings', () => {
    it('surfaces a finding nobody has looked at', () => {
      const items = itemsNeedingAttention(ws({ analysisResults: [finding()] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe('finding');
      expect(items[0]?.severity).toBe('HIGH');
      // The record's own words, not a sentence composed about the record.
      expect(items[0]?.title).toBe('Amounts do not agree');
      expect(items[0]?.detail).toBe('The invoice says INR 85,000 and the receipt says INR 40,000.');
      // Findings render inline on the case screen; there is no per-finding route on disk.
      expect(items[0]?.href).toBe(`/case/${CASE_ID}`);
      expect(items[0]?.target).toEqual({ route: 'case', caseId: CASE_ID });
    });

    it.each(['REVIEWED', 'DISMISSED', 'RESOLVED'] as const)(
      'drops a finding a person has already actioned (%s)',
      (status) => {
        expect(itemsNeedingAttention(ws({ analysisResults: [finding({ status })] }))).toEqual([]);
      },
    );

    it('ranks by updatedAt, not createdAt', () => {
      // Findings have deterministic ids, so a re-run over unchanged data rewrites the same
      // document. The useful recency is "as of the last analysis", which is `updatedAt`.
      const older = finding({ id: 'res_old', createdAt: 9_000, updatedAt: 1_000 });
      const newer = finding({ id: 'res_new', createdAt: 1_000, updatedAt: 9_000 });

      const items = itemsNeedingAttention(ws({ analysisResults: [older, newer] }));

      expect(ids(items)).toEqual(['finding:res_new', 'finding:res_old']);
    });
  });

  describe('evidence', () => {
    it('flags a failed item with the reason that was recorded', () => {
      const failed = evidence('', {
        id: 'evd_failed',
        state: 'FAILED',
        failureReason: 'The PDF is encrypted and could not be opened.',
      });

      const items = itemsNeedingAttention(ws({ evidence: [failed] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('evidence-failed:evd_failed');
      expect(items[0]?.severity).toBe('HIGH');
      expect(items[0]?.detail).toBe('The PDF is encrypted and could not be opened.');
      expect(items[0]?.href).toBe(`/case/${CASE_ID}/evidence/evd_failed`);
      expect(items[0]?.target).toEqual({
        route: 'evidence',
        caseId: CASE_ID,
        evidenceId: 'evd_failed',
      });
    });

    it('admits when a failure has no recorded reason rather than guessing one', () => {
      const failed = evidence('', { id: 'evd_x', state: 'FAILED', failureReason: null });

      const items = itemsNeedingAttention(ws({ evidence: [failed] }));

      expect(items[0]?.detail).toBe('Processing failed and no reason was recorded.');
    });

    it('flags an item waiting on review at MEDIUM, below an outright failure', () => {
      const review = evidence('Some text', { id: 'evd_r', state: 'REVIEW_REQUIRED' });

      const items = itemsNeedingAttention(ws({ evidence: [review] }));

      expect(items[0]?.id).toBe('evidence-review:evd_r');
      expect(items[0]?.severity).toBe('MEDIUM');
    });

    it('flags a stored file that yielded no text, at LOW', () => {
      // Nothing went wrong: the app simply has a document it cannot reason about. This is
      // an unreadable file's situation, and it is easy to miss precisely because no step
      // reported an error.
      const empty = evidence('', { id: 'evd_blank', state: 'EXTRACTED' });

      const items = itemsNeedingAttention(ws({ evidence: [empty] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('evidence-no-text:evd_blank');
      expect(items[0]?.severity).toBe('LOW');
      expect(items[0]?.detail).toMatch(/no text was read/i);
    });

    it('never reports both a state problem and no-text for the same item', () => {
      // `REVIEW_REQUIRED` with no readable text satisfies the wording of both conditions.
      // One row per item, or the list double-counts exactly the items in the worst shape.
      const both = evidence('', { id: 'evd_both', state: 'REVIEW_REQUIRED' });

      const items = itemsNeedingAttention(ws({ evidence: [both] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('evidence-review:evd_both');
    });

    it('does not ask a note to have a document in it', () => {
      // A NOTE carries its content in `note` and has no file to read, so it can never
      // satisfy the no-text condition and must not be asked to.
      const note: Evidence = evidence('', {
        id: 'evd_note',
        kind: 'NOTE',
        state: 'CONFIRMED',
        note: 'Client agreed to the revised schedule over the phone.',
        fileName: null,
        mimeType: null,
        storagePath: null,
      });

      expect(itemsNeedingAttention(ws({ evidence: [note] }))).toEqual([]);
    });

    it('flags a stored document nothing has read yet, at INFO', () => {
      // There is no background worker — `requestEvidenceProcessing` runs inline, in the
      // screen that started it — so a QUEUED row is a document that sits unread until a
      // person presses Process. It is the one kind of outstanding work in the app that
      // cannot make any progress on its own, which is precisely why it belongs here.
      const queued = evidence('', { id: 'evd_q', state: 'QUEUED' });

      const items = itemsNeedingAttention(ws({ evidence: [queued] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('evidence-unread:evd_q');
      // Neutral, which is the tone `PROCESSING_TONE` already gives QUEUED on the evidence
      // list. A colour that disagreed with itself between two screens would stop carrying
      // information, and nothing has gone wrong here for a louder one to report.
      expect(items[0]?.severity).toBe('INFO');
      expect(items[0]?.detail).toMatch(/nothing has been read from this yet/i);
      // An unread document is a pending task, never a problem with the evidence.
      expect(items[0]?.detail).not.toMatch(/fail|error|wrong|corrupt/i);
      // The row opens the screen the Process button lives on, so the action it names is one
      // tap from the row that names it.
      expect(items[0]?.href).toBe(`/case/${CASE_ID}/evidence/evd_q`);
      expect(items[0]?.target).toEqual({
        route: 'evidence',
        caseId: CASE_ID,
        evidenceId: 'evd_q',
      });
    });

    it('asks a queued statement to be read too, though it has no file', () => {
      // The no-text rule must never be put to a NOTE, because it asks whether a *document*
      // yielded text. This rule asks only whether anything has been read out of the record,
      // which a statement that was queued and never extracted answers honestly: nothing has.
      const statement: Evidence = evidence('', {
        id: 'evd_note_q',
        kind: 'NOTE',
        state: 'QUEUED',
        note: 'Client agreed to the revised schedule over the phone.',
        fileName: null,
        mimeType: null,
        storagePath: null,
        extraction: null,
      });

      expect(ids(itemsNeedingAttention(ws({ evidence: [statement] })))).toEqual([
        'evidence-unread:evd_note_q',
      ]);
    });

    it('does not call a queued item unread when an earlier run already read it', () => {
      // `reconcileInterruptedEvidence` demotes an interrupted *re*-read back to QUEUED, and
      // that record still carries the reading its first run produced. The row's sentence is
      // a claim about the contents, so it has to lose to the contents.
      const reread = evidence('Total: INR 85,000.00', { id: 'evd_reread', state: 'QUEUED' });

      expect(itemsNeedingAttention(ws({ evidence: [reread] }))).toEqual([]);
    });

    it('sorts an unread document below a file that was read and came back empty', () => {
      // Neither is an error and neither is loud. The difference the ordering records is that
      // one has had its chance to be read and may need a better scan, while the other has
      // simply not been read yet.
      const items = itemsNeedingAttention(
        ws({
          evidence: [
            evidence('', { id: 'evd_unread', state: 'QUEUED' }),
            evidence('', { id: 'evd_empty', state: 'EXTRACTED' }),
          ],
        }),
      );

      expect(ids(items)).toEqual(['evidence-no-text:evd_empty', 'evidence-unread:evd_unread']);
    });

    it.each(['UPLOADING', 'PROCESSING'] as const)(
      'stays quiet about a run belonging to a live process (%s)',
      (state) => {
        // Not because these resolve on their own — nothing in this app does. A row still in
        // either state belongs to a run in the *current* process, and the leftovers of any
        // other process do not survive to be found here: `reconcileInterruptedEvidence`
        // rewrites them at the first load of a case.
        const inFlight = evidence('', { state });

        expect(itemsNeedingAttention(ws({ evidence: [inFlight] }))).toEqual([]);
      },
    );

    it('leaves an unfinished upload to the reconcile that turns it into a FAILED row', () => {
      // `recordEvidenceFile` writes the stored path and QUEUED in one commit, so an
      // UPLOADING row with no original is an upload whose bytes never landed. This module
      // says nothing about it: `reconcileInterruptedEvidence` rewrites it to FAILED with a
      // recorded reason at the first load of the case, and the FAILED rule surfaces it then.
      const stranded = evidence('', {
        id: 'evd_up',
        state: 'UPLOADING',
        storagePath: null,
        sha256: null,
      });

      expect(itemsNeedingAttention(ws({ evidence: [stranded] }))).toEqual([]);
    });

    it('treats whitespace-only extraction as no text at all', () => {
      const blank = evidence('   \n\t  ', { id: 'evd_ws', state: 'ANALYZED' });

      const items = itemsNeedingAttention(ws({ evidence: [blank] }));

      expect(ids(items)).toEqual(['evidence-no-text:evd_ws']);
    });

    it('ignores a deleted item', () => {
      const gone = evidence('', { state: 'FAILED', deletedAt: 5_000 });

      expect(itemsNeedingAttention(ws({ evidence: [gone] }))).toEqual([]);
    });
  });

  describe('claims', () => {
    it('flags a claim with evidence on both sides as MEDIUM', () => {
      const mixed = claim('Payment was made in full', { id: 'clm_m', state: 'MIXED_REVIEW' });

      const items = itemsNeedingAttention(ws({ claims: [mixed] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('claim:clm_m');
      expect(items[0]?.severity).toBe('MEDIUM');
      expect(items[0]?.title).toBe('Payment was made in full');
      expect(items[0]?.href).toBe(`/case/${CASE_ID}/claim/clm_m`);
      expect(items[0]?.target).toEqual({ route: 'claim', caseId: CASE_ID, claimId: 'clm_m' });
    });

    it('flags an unlinked claim at INFO, and says it is not a verdict', () => {
      // An unsupported claim is a perfectly ordinary state that says nothing about whether
      // the claim is true. It does not get to be red, and the wording has to say so.
      const bare = claim('Delivery was late', { id: 'clm_u', state: 'UNSUPPORTED' });

      const items = itemsNeedingAttention(ws({ claims: [bare] }));

      expect(items[0]?.severity).toBe('INFO');
      expect(items[0]?.detail).toMatch(/says nothing about whether it is true/i);
    });

    it.each(['SUPPORTED', 'CONTRADICTED'] as const)('leaves a settled claim alone (%s)', (state) => {
      expect(itemsNeedingAttention(ws({ claims: [claim('Settled', { state })] }))).toEqual([]);
    });
  });

  describe('cases behind their analysis', () => {
    it('flags a case with contents that has never been analysed, with no date', () => {
      const items = itemsNeedingAttention(
        workspace({
          cases: [testCase({ lastAnalyzedAt: null })],
          claims: [claim('Something happened', { state: 'SUPPORTED' })],
        }),
      );

      const row = items.find((item) => item.kind === 'case');
      expect(row?.id).toBe(`case-unanalysed:${CASE_ID}`);
      expect(row?.severity).toBe('LOW');
      // Genuinely unknown rather than missing. There is no last-analysed moment to print,
      // and a relative time here would be invented.
      expect(row?.at).toBeNull();
    });

    it('does not nag about an empty case', () => {
      // Telling a user to analyse the case they created thirty seconds ago is the sort of
      // nagging that gets a notification list ignored for good.
      expect(itemsNeedingAttention(ws({ cases: [testCase({ lastAnalyzedAt: null })] }))).toEqual([]);
    });

    it('flags a case edited after its last analysis, dated by the run', () => {
      const stale = testCase({ updatedAt: 50_000, lastAnalyzedAt: 10_000 });

      const items = itemsNeedingAttention(ws({ cases: [stale] }));

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(`case-stale:${CASE_ID}`);
      // The row is about how old the analysis is, so it carries the run, not the edit.
      expect(items[0]?.at).toBe(10_000);
    });

    it('tolerates the write the analysis run makes to the case itself', () => {
      // `applyAnalysisRun` writes `lastAnalyzedAt` and bumps `updatedAt` a few milliseconds
      // either side of it. Without the tolerance every freshly analysed case would report
      // itself out of date the instant it finished.
      const justRun = testCase({ updatedAt: 10_500, lastAnalyzedAt: 10_000 });

      expect(itemsNeedingAttention(ws({ cases: [justRun] }))).toEqual([]);
    });
  });

  describe('suppression', () => {
    const noisy: Partial<Workspace> = {
      analysisResults: [finding({ id: 'res_s' })],
      claims: [claim('Unsettled', { id: 'clm_s', state: 'MIXED_REVIEW' })],
      evidence: [evidence('', { id: 'evd_s', state: 'FAILED' })],
    };

    it.each(['CLOSED', 'ARCHIVED'] as const)(
      'suppresses every row for a case the user has finished with (%s)',
      (status) => {
        // Surfacing an archived case's open findings would make the list impossible to
        // ever empty, which is what trains people to ignore it.
        const items = itemsNeedingAttention(
          workspace({ ...noisy, cases: [testCase({ status })] }),
        );

        expect(items).toEqual([]);
      },
    );

    it('suppresses every row for a deleted case', () => {
      const items = itemsNeedingAttention(
        workspace({ ...noisy, cases: [testCase({ deletedAt: 7_000 })] }),
      );

      expect(items).toEqual([]);
    });

    it('keeps rows whose case is simply absent from this workspace', () => {
      // Absence is not evidence of archival — the case may be in another shard or
      // mid-write. Dropping a real finding is the worse of the two errors.
      const items = itemsNeedingAttention(ws({ ...noisy, cases: [] }));

      expect(ids(items)).toContain('finding:res_s');
      // ...but the row cannot name a case it does not have, and says null rather than
      // filling in a placeholder title.
      expect(items[0]?.caseTitle).toBeNull();
    });

    it('carries the case title when the workspace has the case', () => {
      const items = itemsNeedingAttention(
        workspace({ ...noisy, cases: [testCase({ title: 'Unpaid design retainer' })] }),
      );

      for (const item of items) {
        expect(item.caseTitle).toBe('Unpaid design retainer');
      }
    });
  });

  describe('ordering and identity', () => {
    it('sorts by severity first, then recency', () => {
      const items = itemsNeedingAttention(
        workspace({
          analysisResults: [
            finding({ id: 'res_hi', severity: 'HIGH', updatedAt: 1_000 }),
            finding({ id: 'res_med', severity: 'MEDIUM', updatedAt: 9_000 }),
            finding({ id: 'res_info', severity: 'INFO', updatedAt: 9_000 }),
            finding({ id: 'res_low', severity: 'LOW', updatedAt: 9_000 }),
          ],
        }),
      );

      // HIGH wins despite being the oldest of the four.
      expect(ids(items)).toEqual([
        'finding:res_hi',
        'finding:res_med',
        'finding:res_low',
        'finding:res_info',
      ]);
    });

    it('produces the same order twice for entries written in the same millisecond', () => {
      // An analysis run writes all its findings at one timestamp. Without the id tiebreak
      // their order would follow whatever the storage adapter returned, so the list would
      // shuffle between two visits that changed nothing.
      const same = [
        finding({ id: 'res_c', updatedAt: 4_000 }),
        finding({ id: 'res_a', updatedAt: 4_000 }),
        finding({ id: 'res_b', updatedAt: 4_000 }),
      ];

      const forwards = itemsNeedingAttention(ws({ analysisResults: same }));
      const backwards = itemsNeedingAttention(ws({ analysisResults: [...same].reverse() }));

      expect(ids(forwards)).toEqual(['finding:res_a', 'finding:res_b', 'finding:res_c']);
      expect(ids(backwards)).toEqual(ids(forwards));
    });

    it('sorts an undated row to the end of its band without NaN scrambling the order', () => {
      // `-Infinity - -Infinity` is NaN, and a comparator that returns NaN sorts
      // unpredictably. Two undated rows must still order deterministically.
      const unanalysed: Case[] = [
        testCase({ id: 'case_b', title: 'B', lastAnalyzedAt: null }),
        testCase({ id: 'case_a', title: 'A', lastAnalyzedAt: null }),
      ];

      const items = itemsNeedingAttention({
        ...workspace(),
        cases: unanalysed,
        claims: [
          claim('x', { id: 'clm_a', caseId: 'case_a', state: 'SUPPORTED' }),
          claim('y', { id: 'clm_b', caseId: 'case_b', state: 'SUPPORTED' }),
        ],
      });

      expect(ids(items)).toEqual(['case-unanalysed:case_a', 'case-unanalysed:case_b']);
    });

    it('gives every row an id that is stable across re-derivation', () => {
      // The screen re-derives on every load. An id from `newId()` would differ each time
      // and the list would reshuffle under the reader's finger.
      const parts: Partial<Workspace> = {
        cases: [testCase({ updatedAt: 50_000, lastAnalyzedAt: 10_000 })],
        analysisResults: [finding({ id: 'res_1' })],
        claims: [claim('Unsettled', { id: 'clm_1', state: 'MIXED_REVIEW' })],
        evidence: [evidence('', { id: 'evd_1', state: 'FAILED' })],
      };

      expect(ids(itemsNeedingAttention(ws(parts)))).toEqual(
        ids(itemsNeedingAttention(ws(parts))),
      );
    });

    it('prefixes ids by kind so two collections cannot collide as React keys', () => {
      const shared = 'x_1';
      const items = itemsNeedingAttention(
        workspace({
          claims: [claim('Unsettled', { id: shared, state: 'MIXED_REVIEW' })],
          evidence: [evidence('', { id: shared, state: 'FAILED' })],
        }),
      );

      expect(new Set(ids(items)).size).toBe(items.length);
    });

    it('does not mutate the workspace it was given', () => {
      const results = [
        finding({ id: 'res_z', updatedAt: 1_000 }),
        finding({ id: 'res_y', updatedAt: 9_000 }),
      ];
      const before = results.map((result) => result.id);

      itemsNeedingAttention(ws({ analysisResults: results }));

      expect(results.map((result) => result.id)).toEqual(before);
    });
  });

  it('reports every condition at once for a case in genuine trouble', () => {
    resetIds();

    const items = itemsNeedingAttention(
      workspace({
        cases: [testCase({ title: 'Unpaid retainer', updatedAt: 50_000, lastAnalyzedAt: 10_000 })],
        analysisResults: [finding({ id: 'res_1', updatedAt: 20_000 })],
        claims: [claim('Paid in full', { id: 'clm_1', state: 'MIXED_REVIEW', updatedAt: 20_000 })],
        evidence: [
          evidence('', { id: 'evd_1', state: 'FAILED', updatedAt: 30_000 }),
          evidence('', { id: 'evd_2', state: 'EXTRACTED', updatedAt: 30_000 }),
        ],
      }),
    );

    expect(ids(items)).toEqual([
      'evidence-failed:evd_1',
      'finding:res_1',
      'claim:clm_1',
      'evidence-no-text:evd_2',
      `case-stale:${CASE_ID}`,
    ]);
    // Every row names the case it belongs to, so the screen can group without a lookup.
    for (const item of items) {
      expect(item.caseId).toBe(CASE_ID);
      expect(item.caseTitle).toBe('Unpaid retainer');
    }
  });
});
