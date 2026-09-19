import { describe, expect, it } from 'vitest';

import { applyChanges, MAX_ATOMIC_CHANGES } from '@data/repository';
import {
  aiSuggestionSchema,
  analysisResultSchema,
  caseAnalysisSchema,
  emptyWorkspace,
  processingJobSchema,
  workspaceSchema,
  type AIExtractionSuggestion,
  type AnalysisResult,
  type CaseAnalysis,
  type ProcessingJob,
  type Workspace,
} from '@domain/models';
import { planCaseHandover } from '@services/migration-plan';

import { CASE_ID, OWNER, claim, evidence, event, link, ref, testCase, workspace } from './helpers';

/**
 * Handing a case over from device storage to a signed-in account.
 *
 * The thing under test is a data-preservation guarantee, so that is what is asserted: every
 * collection crosses, every id survives, and nothing that was read from a real file is
 * downgraded on the way. Two fields change — the owner and the storage path — and both are
 * forced by the ownership checks in `commit` and `validatePrivateEvidencePath`.
 *
 * The plan's changes are replayed through `applyChanges` and then through `workspaceSchema`,
 * so a re-owned record that no longer validates fails here rather than at the Firestore write.
 */

const DEVICE = 'user_device';
const ACCOUNT = 'user_account';
const NOW = 9_000;

/** The path shape `evidenceStoragePath` produces, which is the only shape the planner rewrites. */
const storedAt = (ownerId: string, evidenceId: string) =>
  `users/${ownerId}/cases/${CASE_ID}/${evidenceId}/original.pdf`;

const scoped = { ownerId: DEVICE, caseId: CASE_ID, createdAt: 1_000, updatedAt: 1_000 };

const finding = (id: string): AnalysisResult =>
  analysisResultSchema.parse({
    ...scoped,
    id,
    resultType: 'AMOUNT_MISMATCH',
    severity: 'HIGH',
    title: 'Two documents state different amounts',
    explanation: 'The invoice and the receipt disagree by INR 45,000.',
    confidence: 'EXACT_MATCH',
    status: 'OPEN',
    supportingEvidenceIds: ['evd_invoice'],
    inputs: { Difference: 'INR 45,000.00' },
    triggeredRuleIds: ['amount-mismatch'],
  });

const job = (id: string): ProcessingJob =>
  processingJobSchema.parse({ ...scoped, id, state: 'ANALYZED', evidenceId: 'evd_invoice', attempts: 1 });

const suggestion = (id: string): AIExtractionSuggestion =>
  aiSuggestionSchema.parse({
    ...scoped,
    id,
    kind: 'FIELD_EXTRACTION',
    status: 'SUGGESTED',
    model: 'llama-3.3-70b-versatile',
    promptVersion: 'field-extraction-1',
    summary: 'Reads the invoice number as INV2024018.',
    confidence: 0.82,
    evidenceId: 'evd_invoice',
  });

const analysis = (id: string): CaseAnalysis =>
  caseAnalysisSchema.parse({
    ...scoped,
    id,
    jobId: 'job_analysis',
    schemaVersion: '1',
    summary: 'Two sources describe the same transaction with different totals.',
    claims: [],
    agreements: [],
    contradictions: [],
    timeline: [],
    limitations: ['One source could not be read.'],
    coverage: { totalEvidence: 2, processedEvidence: 2, excludedEvidenceIds: [], truncated: false },
    model: 'llama-3.3-70b-versatile',
    promptVersion: 'case-analysis-1',
  });

/**
 * A case as it exists on the device: every collection populated, one source with a real
 * extraction and a stored file, one typed note with no file.
 */
function deviceWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const invoice = evidence('Invoice INV2024018 dated 12 March 2024 for INR 85,000.', {
    id: 'evd_invoice',
    storagePath: storedAt(DEVICE, 'evd_invoice'),
    ownerId: DEVICE,
    confirmedAt: 4_000,
    confirmedFields: { 'amounts.0': '85000' },
  });
  const note = evidence('Client said the balance is disputed.', {
    id: 'evd_note',
    ownerId: DEVICE,
    kind: 'NOTE',
    fileName: null,
    mimeType: null,
    storagePath: null,
    sha256: null,
  });
  const paid = event('Part payment received', '2024-03-28', { id: 'evt_paid', ownerId: DEVICE });
  const balance = claim('INR 45,000 is still owed', {
    id: 'clm_balance',
    ownerId: DEVICE,
    state: 'SUPPORTED',
    requiredEventIds: [paid.id],
  });

  return workspace({
    cases: [testCase({ ownerId: DEVICE, lastAnalyzedAt: 5_000, updatedAt: 5_000 })],
    evidence: [invoice, note],
    events: [paid],
    claims: [balance],
    relationships: [
      link(ref.evidence(invoice.id), ref.claim(balance.id), 'SUPPORTS', {
        id: 'rel_supports',
        ownerId: DEVICE,
      }),
    ],
    analysisResults: [finding('res_mismatch')],
    auditLogs: [
      {
        ...scoped,
        id: 'aud_added',
        action: 'EVIDENCE_UPLOADED',
        actorId: DEVICE,
        entityRefs: [ref.evidence(invoice.id)],
        summary: 'Added the invoice.',
        metadata: { kind: 'PDF' },
      },
    ],
    processingJobs: [job('job_invoice')],
    aiSuggestions: [suggestion('sug_invoice')],
    caseAnalyses: [analysis('ana_first')],
    ...overrides,
  });
}

const plannedWorkspace = (plan: { changes: ReturnType<typeof planCaseHandover>['changes'] }) =>
  workspaceSchema.parse(applyChanges(emptyWorkspace(), plan.changes));

describe('planCaseHandover', () => {
  const source = deviceWorkspace();
  const plan = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW);
  const moved = plannedWorkspace(plan);

  it('carries every collection across rather than only the ones the screen shows', () => {
    // The planner writes the nine collections out one by one instead of looping, which is what
    // keeps each record checked against its own type. The cost of that is that a collection
    // added later can be forgotten, so the count is asserted here.
    expect(new Set(plan.changes.map((change) => change.collection))).toEqual(
      new Set([
        'cases',
        'claims',
        'events',
        'evidence',
        'relationships',
        'analysisResults',
        'auditLogs',
        'processingJobs',
        'aiSuggestions',
        'caseAnalyses',
      ]),
    );
    expect(plan.changes.every((change) => change.op === 'put')).toBe(true);
  });

  it('re-owns every record without renaming any of them', () => {
    const records = [
      ...moved.cases,
      ...moved.claims,
      ...moved.events,
      ...moved.evidence,
      ...moved.relationships,
      ...moved.analysisResults,
      ...moved.auditLogs,
      ...moved.processingJobs,
      ...moved.aiSuggestions,
      ...moved.caseAnalyses,
    ];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record.ownerId).toBe(ACCOUNT);

    // Ids are preserved so cross-references stay valid and a second run overwrites rather than
    // duplicating. Re-mapping ids here would silently break `requiredEventIds` and every
    // relationship endpoint.
    expect(moved.claims[0]?.id).toBe('clm_balance');
    expect(moved.claims[0]?.requiredEventIds).toEqual(['evt_paid']);
    expect(moved.relationships[0]).toMatchObject({
      from: { kind: 'evidence', id: 'evd_invoice' },
      to: { kind: 'claim', id: 'clm_balance' },
    });
  });

  it('keeps extraction, confirmations, hashes and dates exactly as they were', () => {
    const invoice = moved.evidence.find((item) => item.id === 'evd_invoice')!;
    const original = source.evidence.find((item) => item.id === 'evd_invoice')!;

    // The point of the whole feature: signing in must not cost the user their work. Anything
    // re-derivable from the stored file crosses untouched.
    expect(invoice.extraction).toEqual(original.extraction);
    expect(invoice.extraction?.amounts.length).toBeGreaterThan(0);
    expect(invoice.sha256).toBe(original.sha256);
    expect(invoice.state).toBe('CONFIRMED');
    expect(invoice.confirmedAt).toBe(4_000);
    expect(invoice.confirmedFields).toEqual({ 'amounts.0': '85000' });
    expect(moved.claims[0]?.state).toBe('SUPPORTED');
    expect(moved.events[0]?.occurredAt).toEqual(source.events[0]?.occurredAt);
    expect(moved.analysisResults[0]).toMatchObject({ resultType: 'AMOUNT_MISMATCH', status: 'OPEN' });
  });

  it('repoints the storage path onto the account and reports the file that must follow', () => {
    const invoice = moved.evidence.find((item) => item.id === 'evd_invoice')!;
    expect(invoice.storagePath).toBe(storedAt(ACCOUNT, 'evd_invoice'));
    expect(plan.fileMoves).toEqual([
      {
        evidenceId: 'evd_invoice',
        from: storedAt(DEVICE, 'evd_invoice'),
        to: storedAt(ACCOUNT, 'evd_invoice'),
      },
    ]);
  });

  it('asks for no file move for a source that never had one', () => {
    const note = moved.evidence.find((item) => item.id === 'evd_note')!;
    expect(note.storagePath).toBeNull();
    expect(plan.fileMoves.map((move) => move.evidenceId)).not.toContain('evd_note');
  });

  it('re-stamps the case and clears the analysis timestamp it can no longer vouch for', () => {
    expect(plan.caseRecord).toMatchObject({
      id: CASE_ID,
      ownerId: ACCOUNT,
      updatedAt: NOW,
      lastAnalyzedAt: null,
    });
    // Everything else about the case is untouched, including the title the user typed.
    expect(plan.caseRecord.title).toBe('Test case');
  });

  it('counts what it moved, so the screen cannot promise more than the commit writes', () => {
    expect(plan).toMatchObject({ claimCount: 1, eventCount: 1, evidenceCount: 2 });
  });

  it('records the handover in the history and says whether the originals came too', () => {
    const entry = moved.auditLogs.find((item) => item.metadata['source'] === 'device-storage')!;
    expect(entry.actorId).toBe(ACCOUNT);
    expect(entry.summary).toMatch(/2 sources carried across, 1 with the original file/);
    // The pre-existing history survives alongside it, re-attributed to the account so the
    // ownership check does not reject it.
    const older = moved.auditLogs.find((item) => item.id === 'aud_added')!;
    expect(older).toMatchObject({ ownerId: ACCOUNT, actorId: ACCOUNT, summary: 'Added the invoice.' });
    // Bounded, and no document text: this is written into a log a support engineer may read.
    expect(entry.summary.length).toBeLessThan(400);
    for (const value of Object.values(entry.metadata)) expect(value.length).toBeLessThan(80);
  });

  it('plans the same handover twice without producing a second copy of the case', () => {
    const again = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW);
    expect(again.changes).toEqual(plan.changes);
  });

  it('leaves the device workspace it was given untouched', () => {
    // The device copy is still the only copy until the commit succeeds. A planner that mutated
    // its input would corrupt it before anything was written.
    expect(deviceWorkspace()).toEqual(source);
  });
});

/**
 * Pressing Move twice.
 *
 * `handOverDeviceCase` can fail after the batch has landed but before its acknowledgement
 * arrives, and the screen's only offer is to press Move again with a fresh `Date.now()`. So a
 * second attempt at the same handover is an ordinary path, not an edge case, and it has two
 * separate ways to go wrong: a second entry in the trail saying the case was moved again, or —
 * once the id is stable but the bytes are not — an update to an append-only document that
 * `unchanged()` in `rules/firestore.rules` refuses, taking the whole atomic batch with it and
 * stranding the case on the device for good.
 *
 * Both are tested against a *different clock*, because the clock is the only thing that differs
 * between two attempts at one handover.
 */
describe('planCaseHandover on a retry', () => {
  const source = deviceWorkspace();
  const first = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, 9_000);
  const retry = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, 4_000_000);

  const handoverEntries = (space: Workspace) =>
    space.auditLogs.filter((item) => item.metadata['source'] === 'device-storage');

  const auditChange = (plan: ReturnType<typeof planCaseHandover>) =>
    plan.changes.find(
      (change) =>
        change.op === 'put' &&
        change.collection === 'auditLogs' &&
        change.record.metadata['source'] === 'device-storage',
    );

  it('writes the same handover document byte for byte whatever the clock says', () => {
    // Not merely the same id. `unchanged()` is deep equality of the whole document, and the
    // rule's own comment rests on this function reproducing the same bytes rather than the
    // same shape. A stable id with a moving `createdAt` is the unwritable-retry failure.
    expect(auditChange(retry)).toEqual(auditChange(first));
  });

  it('lets the clock reach exactly one field of one row', () => {
    // The case record is a mutable row whose collection permits an ordinary owner update, so
    // its `updatedAt` should record the write. Nothing else may differ between two attempts.
    expect(retry.caseRecord.updatedAt).toBe(4_000_000);
    expect(first.caseRecord.updatedAt).toBe(9_000);
    expect({ ...retry.caseRecord, updatedAt: 0 }).toEqual({ ...first.caseRecord, updatedAt: 0 });

    const withoutCase = (plan: ReturnType<typeof planCaseHandover>) =>
      plan.changes.filter((change) => change.collection !== 'cases');
    expect(withoutCase(retry)).toEqual(withoutCase(first));
  });

  it('leaves one record of the move after both attempts are committed', () => {
    // The end state a user sees. `buildAuditChain` hashes each entry over the one before it, so
    // two entries here would not merely repeat themselves — the history would assert that the
    // case was moved twice.
    const committed = workspaceSchema.parse(
      applyChanges(applyChanges(emptyWorkspace(), first.changes), retry.changes),
    );
    expect(handoverEntries(committed)).toHaveLength(1);
    expect(committed.auditLogs).toHaveLength(2);
  });

  it('timestamps the entry from the records it moved rather than from the clock', () => {
    const entry = handoverEntries(plannedWorkspace(first))[0]!;

    // The latest stamp on any row crossing — here the case's own `updatedAt` of 5_000 — which
    // is the tightest instant this function can prove the handover was at or after, and the
    // only candidate that is a pure function of the plan. An honest lower bound, deliberately
    // preferred over an exact time that makes the entry either duplicated or unwritable.
    expect(entry.createdAt).toBe(5_000);
    expect(entry.updatedAt).toBe(5_000);
    expect(entry.createdAt).not.toBe(9_000);

    // And it sorts last in the case's own history, because it is at or after everything that
    // crossed with it. An entry about the move that reads as older than the records it moved
    // would put the trail in an order that never happened.
    for (const other of plannedWorkspace(first).auditLogs) {
      if (other.id === entry.id) continue;
      expect(entry.createdAt).toBeGreaterThanOrEqual(other.createdAt);
    }
  });

  it('gives a handover that carries a different set of rows its own entry', () => {
    // Two attempts that move the same rows are one handover. A later move that carries a row
    // the first did not is a different event, and pretending otherwise would overwrite the
    // record of the first with a claim about rows it never touched.
    const withExtra = deviceWorkspace({
      claims: [
        claim('INR 45,000 is still owed', { id: 'clm_balance', ownerId: DEVICE }),
        claim('Added after the first attempt', { id: 'clm_later', ownerId: DEVICE }),
      ],
    });
    const later = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, withExtra, 9_000);

    expect(auditChange(later)).not.toEqual(auditChange(first));
    const committed = workspaceSchema.parse(
      applyChanges(applyChanges(emptyWorkspace(), first.changes), later.changes),
    );
    expect(handoverEntries(committed)).toHaveLength(2);
  });

  it('cannot confuse the owner it came from with the owner it went to', () => {
    /*
      `deterministicId` SORTS its parts before hashing, so the id is a function of the multiset
      rather than of the tuple. Feeding it bare ids would make a move from A to B and a move
      from B to A the same multiset and therefore the same document — one overwriting the
      other's record of the opposite event.

      Every part is prefixed with what it is, and `ID_PATTERN` forbids `:` inside an id, so
      `from:x` can never be read as `to:x` and the sorted multiset still determines the tuple
      it came from.
    */
    const onlyTheCase = (ownerId: string) =>
      workspace({
        cases: [testCase({ ownerId, updatedAt: 5_000 })],
        evidence: [],
        events: [],
        claims: [],
        relationships: [],
        analysisResults: [],
        auditLogs: [],
        processingJobs: [],
        aiSuggestions: [],
        caseAnalyses: [],
      });

    const out = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, onlyTheCase(DEVICE), NOW);
    const back = planCaseHandover(ACCOUNT, DEVICE, CASE_ID, onlyTheCase(ACCOUNT), NOW);

    const idOf = (plan: ReturnType<typeof planCaseHandover>) => {
      const change = auditChange(plan)!;
      return change.op === 'put' ? change.record.id : '';
    };
    expect(idOf(out)).not.toBe(idOf(back));
  });
});

describe('planCaseHandover boundaries', () => {
  it('drops a storage path it cannot rewrite instead of pointing it into another account', () => {
    // A path from a different scheme cannot be rewritten safely — guessing could produce a
    // path that resolves to some other record's file. The record crosses with its extracted
    // text and loses only the link to the file.
    const source = deviceWorkspace({
      evidence: [
        evidence('Receipt for INR 40,000.', {
          id: 'evd_foreign',
          ownerId: DEVICE,
          storagePath: 'legacy/evd_foreign.pdf',
        }),
      ],
    });
    const plan = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW);
    const moved = plannedWorkspace(plan);
    const record = moved.evidence.find((item) => item.id === 'evd_foreign')!;

    expect(record.storagePath).toBeNull();
    expect(record.extraction?.amounts.length).toBeGreaterThan(0);
    expect(plan.fileMoves).toEqual([]);
  });

  it('refuses a case that is not in device storage under that owner', () => {
    const source = deviceWorkspace();
    expect(() => planCaseHandover('user_someone_else', ACCOUNT, CASE_ID, source, NOW)).toThrow(
      /not stored on this device/,
    );
    expect(() => planCaseHandover(DEVICE, ACCOUNT, 'case_absent', source, NOW)).toThrow(
      /not stored on this device/,
    );
  });

  it('refuses a case already deleted on the device', () => {
    const source = deviceWorkspace({
      cases: [testCase({ ownerId: DEVICE, deletedAt: 6_000 })],
    });
    expect(() => planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW)).toThrow(
      /not stored on this device/,
    );
  });

  it('leaves behind records belonging to another owner or another case', () => {
    const source = deviceWorkspace({
      claims: [
        claim('Mine', { id: 'clm_mine', ownerId: DEVICE }),
        claim('Another account on this device', { id: 'clm_other_owner', ownerId: 'user_other' }),
        claim('A different case', { id: 'clm_other_case', ownerId: DEVICE, caseId: 'case_other' }),
      ],
    });
    const plan = planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW);
    const moved = plannedWorkspace(plan);
    expect(moved.claims.map((item) => item.id)).toEqual(['clm_mine']);
    expect(plan.claimCount).toBe(1);
  });

  it('carries a soft-deleted record across rather than dropping the deletion', () => {
    // Deliberate: the record still exists on the device, and losing the row would resurrect it
    // in a later sync or make the audit trail refer to something that is not there.
    const source = deviceWorkspace({
      claims: [claim('Removed by the user', { id: 'clm_removed', ownerId: DEVICE, deletedAt: 7_000 })],
    });
    const moved = plannedWorkspace(planCaseHandover(DEVICE, ACCOUNT, CASE_ID, source, NOW));
    expect(moved.claims[0]).toMatchObject({ id: 'clm_removed', ownerId: ACCOUNT, deletedAt: 7_000 });
  });

  it('caps a handover at exactly what one batch commits atomically', () => {
    // The cap is asserted against `MAX_ATOMIC_CHANGES` rather than a literal on purpose. It
    // was a literal — 450, chosen to sit under Firestore's 500-write batch limit — while the
    // Firestore adapter sliced at 400, so a case between the two committed as two batches and
    // a failure on the second left the half-moved case this test claims to rule out. Pinning a
    // number here would have passed throughout. Pinning the relationship is what catches it.
    const many = (count: number) =>
      deviceWorkspace({
        cases: [testCase({ ownerId: DEVICE })],
        claims: Array.from({ length: count }, (_, index) =>
          claim(`Claim ${index}`, { id: `clm_bulk_${index}`, ownerId: DEVICE }),
        ),
        evidence: [],
        events: [],
        relationships: [],
        analysisResults: [],
        auditLogs: [],
        processingJobs: [],
        aiSuggestions: [],
        caseAnalyses: [],
      });

    // Each workspace above contributes the case and the handover audit entry on top of claims.
    const atCap = MAX_ATOMIC_CHANGES - 2;
    expect(planCaseHandover(DEVICE, ACCOUNT, CASE_ID, many(atCap), NOW).changes).toHaveLength(
      MAX_ATOMIC_CHANGES,
    );

    const oversized = many(atCap + 1);
    const before = JSON.stringify(oversized);
    expect(() => planCaseHandover(DEVICE, ACCOUNT, CASE_ID, oversized, NOW)).toThrow(
      /too large to move in one step/,
    );
    // The refusal has to leave the device copy exactly as it was: the error message promises
    // the case is still there, and that promise is the reason refusing beats splitting.
    expect(JSON.stringify(oversized)).toBe(before);
  });
});
