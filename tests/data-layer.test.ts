import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogSchema, caseSchema, claimSchema, evidenceSchema } from '@domain/models';
import { createMemoryStore } from '@/data/local/key-value-store';
import { LocalRepository } from '@/data/local/local-repository';
import {
  applyChanges,
  assertOwnership,
  put,
  workspaceForCase,
  type Change,
} from '@/data/repository';
import {
  confirmEvidenceFields,
  createCase,
  createClaim,
  createEvent,
  createFileEvidence,
  createNote,
  deleteEvidence,
  failEvidenceUpload,
  linkEntities,
  MANUAL_ENTRY_SOURCE,
  persistEvidenceExtraction,
  queueEvidence,
  reconcileInterruptedEvidence,
  recordEvidenceFile,
  reviewFinding,
  runCaseAnalysis,
  unlinkEntities,
  updateCase,
  type MutationContext,
} from '@/data/mutations';
import { hashText } from '@domain/hashing';
import { extractFromText } from '@domain/extraction/deterministic';
import { SAMPLE_CASE_ID, seedSampleWorkspace } from './fixtures/build-sample-workspace';
import { CASE_ID, claim, evidence, event, link, OWNER, ref, resetIds, testCase, workspace } from './helpers';

/**
 * The write side.
 *
 * Mutations are pure, so they are tested directly against a workspace with no adapter
 * involved. The adapter is then tested against an in-memory key/value store, which is
 * the same code path AsyncStorage drives on a device.
 */

const NOW = 1_700_000_000_000;

/** Drains pending promise chains. Reads go through two awaited store calls. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let sequence = 0;
const context = (): MutationContext => ({
  ownerId: OWNER,
  now: NOW,
  nextId: (prefix) => `${prefix}_m${(sequence += 1)}`,
});

beforeEach(() => {
  resetIds();
  sequence = 0;
});

const INVOICE = `TAX INVOICE
Invoice Number: INV-2024-018
Invoice Date: 12/03/2024
Total: INR 85,000.00
`;

const RECEIPT = `PAYMENT CONFIRMATION
Against Invoice No: INV-2024-018
Payment Date: 28/03/2024
Total amount paid: INR 40,000.00
`;

describe('applyChanges', () => {
  it('inserts, replaces and deletes in one pass', () => {
    const first = claim('First', { id: 'clm_a' });
    const second = claim('Second', { id: 'clm_b' });
    const base = applyChanges(workspace(), [put('claims', first), put('claims', second)]);
    expect(base.claims).toHaveLength(2);

    const next = applyChanges(base, [
      put('claims', { ...first, statement: 'Edited' }),
      { op: 'delete', collection: 'claims', id: 'clm_b' },
    ]);
    expect(next.claims.map((item) => item.id)).toEqual(['clm_a']);
    expect(next.claims[0]?.statement).toBe('Edited');
  });

  it('leaves untouched collections referentially identical, so lists do not re-render', () => {
    const base = workspace({ evidence: [evidence(INVOICE)] });
    const next = applyChanges(base, [put('claims', claim('New'))]);
    expect(next.evidence).toBe(base.evidence);
    expect(next.claims).not.toBe(base.claims);
  });

  it('does not mutate the workspace it was given', () => {
    const base = workspace();
    const before = base.claims;
    applyChanges(base, [put('claims', claim('New'))]);
    expect(base.claims).toBe(before);
    expect(base.claims).toHaveLength(0);
  });
});

describe('assertOwnership', () => {
  it('refuses to write a record belonging to somebody else', () => {
    const foreign = claim('Not mine', { ownerId: 'user_other' });
    expect(() => assertOwnership(OWNER, [put('claims', foreign)])).toThrow(/user_other/);
  });

  it('allows a change set that is entirely the caller own', () => {
    expect(() => assertOwnership(OWNER, [put('claims', claim('Mine'))])).not.toThrow();
  });
});

describe('workspaceForCase', () => {
  it('keeps only the records of one case', () => {
    const mine = claim('Mine', { id: 'clm_mine' });
    const theirs = claim('Theirs', { id: 'clm_theirs', caseId: 'case_other' });
    const scoped = workspaceForCase(workspace({ claims: [mine, theirs] }), CASE_ID);
    expect(scoped.claims.map((item) => item.id)).toEqual(['clm_mine']);
    expect(scoped.cases.map((item) => item.id)).toEqual([CASE_ID]);
  });
});

describe('mutations', () => {
  it('creates a case and audits it in the same change set', () => {
    const { workspace: next, changes } = createCase(workspace({ cases: [] }), context(), {
      title: '  Website project — unpaid balance  ',
      category: 'Payment dispute',
    });

    expect(next.cases).toHaveLength(1);
    expect(next.cases[0]?.title).toBe('Website project — unpaid balance');
    expect(next.cases[0]?.status).toBe('OPEN');
    expect(() => caseSchema.parse(next.cases[0])).not.toThrow();

    // The audit entry travels with the write rather than being a separate call a
    // caller could forget to make.
    const audits = changes.filter((change) => change.collection === 'auditLogs');
    expect(audits).toHaveLength(1);
    expect(next.auditLogs[0]?.action).toBe('CASE_CREATED');
    expect(() => auditLogSchema.parse(next.auditLogs[0])).not.toThrow();
  });

  it('audits a status change distinctly from an ordinary edit', () => {
    const base = workspace();
    const edited = updateCase(base, context(), CASE_ID, { description: 'More detail' });
    expect(edited.workspace.auditLogs[0]?.action).toBe('CASE_UPDATED');

    const closed = updateCase(base, context(), CASE_ID, { status: 'CLOSED' });
    expect(closed.workspace.auditLogs[0]?.action).toBe('CASE_STATUS_CHANGED');
    expect(closed.workspace.auditLogs[0]?.metadata).toEqual({ from: 'OPEN', to: 'CLOSED' });
  });

  it('starts a new claim as UNSUPPORTED, which describes the evidence and not the truth', () => {
    const { workspace: next } = createClaim(workspace(), context(), CASE_ID, {
      statement: 'The balance is outstanding',
    });
    expect(next.claims[0]?.state).toBe('UNSUPPORTED');
    expect(() => claimSchema.parse(next.claims[0])).not.toThrow();
  });

  it('normalizes a typed event date while keeping what the user actually typed', () => {
    const { workspace: next } = createEvent(workspace(), context(), CASE_ID, {
      title: 'Website delivered',
      occurredAt: '12 March 2024',
    });
    const occurred = next.events[0]?.occurredAt;
    expect(occurred?.iso).toBe('2024-03-12');
    expect(occurred?.original).toBe('12 March 2024');
    expect(occurred?.method).toBe('MANUAL');
    // A hand-typed date is not attributed to any document.
    expect(occurred?.evidenceId).toBe(MANUAL_ENTRY_SOURCE);
  });

  it('flags an ambiguous typed date rather than silently choosing a reading', () => {
    const { workspace: next } = createEvent(workspace(), context(), CASE_ID, {
      title: 'Ambiguous',
      occurredAt: '03/04/2024',
    });
    expect(next.events[0]?.occurredAt?.ambiguous).toBe(true);
  });

  it('keeps an unparseable date visible instead of dropping it', () => {
    const { workspace: next } = createEvent(workspace(), context(), CASE_ID, {
      title: 'Vague',
      occurredAt: 'sometime after the handover',
    });
    expect(next.events[0]?.occurredAt?.iso).toBeNull();
    expect(next.events[0]?.occurredAt?.original).toBe('sometime after the handover');
  });

  it('runs a typed note through the same extractor as an uploaded document', () => {
    const { workspace: next } = createNote(workspace(), context(), CASE_ID, {
      title: 'Call notes',
      text: 'Client confirmed invoice INV-2024-018 on 28/03/2024 for INR 40,000.00.',
    });
    const note = next.evidence[0]!;
    expect(note.extraction?.invoiceNumbers[0]?.normalized).toBe('INV2024018');
    expect(note.extraction?.amounts[0]?.minorUnits).toBe(4_000_000);
    // No file means no hash, so a note can never be reported as an exact duplicate.
    expect(note.sha256).toBeNull();
    expect(note.storagePath).toBeNull();
    expect(() => evidenceSchema.parse(note)).not.toThrow();
  });

  it('marks an uploaded file with no readable text as needing review, not as extracted', () => {
    const { workspace: next } = createFileEvidence(workspace(), context(), CASE_ID, {
      title: 'Scanned receipt',
      kind: 'IMAGE',
      fileName: 'receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 24_000,
      storagePath: 'users/u/cases/c/receipt.jpg',
      sha256: hashText('bytes'),
    });
    const item = next.evidence[0]!;
    expect(item.state).toBe('REVIEW_REQUIRED');
    expect(item.extraction).toBeNull();
    expect(item.failureReason).toMatch(/no text/i);
  });

  it('layers a human correction over the extraction without overwriting it', () => {
    const base = createNote(workspace(), context(), CASE_ID, {
      title: 'Invoice note',
      text: 'Invoice No: INV-2024-018',
    }).workspace;
    const target = base.evidence[0]!;

    const { workspace: next } = confirmEvidenceFields(base, context(), target.id, {
      documentType: 'Invoice',
    });
    const updated = next.evidence[0]!;
    expect(updated.confirmedFields).toEqual({ documentType: 'Invoice' });
    expect(updated.confirmedAt).toBe(context().now);
    // Not CONFIRMED. A document carries many extracted values and fixing one of them is not
    // a statement that the rest were read correctly — and `CONFIRMED` is a green chip with a
    // `check-decagram` on it. The record was already EXTRACTED and stays there.
    expect(updated.state).toBe('EXTRACTED');
    // The machine-read extraction is untouched, so reprocessing can still refresh it.
    expect(updated.extraction).toEqual(target.extraction);
  });

  it('clears a review flag when the person does the review', () => {
    // `REVIEW_REQUIRED` means "a person has to look at this". Correcting the field is a
    // person looking at it. This used to stay REVIEW_REQUIRED forever: the mutation wrote
    // CONFIRMED and the evidence screen mapped over the changes to put the old state back,
    // so the amber chip and the worklist row survived the user doing what was asked.
    const base = createFileEvidence(workspace(), context(), CASE_ID, {
      title: 'Scanned receipt',
      kind: 'IMAGE',
      fileName: 'receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 24_000,
      storagePath: 'users/u/cases/c/receipt.jpg',
      sha256: hashText('bytes'),
    }).workspace;
    const target = base.evidence[0]!;
    expect(target.state).toBe('REVIEW_REQUIRED');

    const { workspace: next } = confirmEvidenceFields(base, context(), target.id, {
      documentType: 'Receipt',
    });
    expect(next.evidence[0]?.state).toBe('CONFIRMED');
  });

  it('records only field names in the audit trail, never the corrected values', () => {
    const base = createNote(workspace(), context(), CASE_ID, { title: 'N', text: 'Invoice No: INV-1' }).workspace;
    const { workspace: next } = confirmEvidenceFields(base, context(), base.evidence[0]!.id, {
      'invoiceNumbers.0': 'INV-2024-018',
    });
    const entry = next.auditLogs.find((item) => item.action === 'EVIDENCE_CONFIRMED')!;
    expect(entry.metadata['fields']).toBe('invoiceNumbers.0');
    expect(JSON.stringify(entry)).not.toContain('INV-2024-018');
  });

  it('tombstones deleted evidence and leaves its links for the audit story', () => {
    const doc = evidence(INVOICE, { id: 'evd_doc' });
    const target = claim('Supported', { id: 'clm_target' });
    const base = workspace({
      evidence: [doc],
      claims: [target],
      relationships: [link(ref.evidence('evd_doc'), ref.claim('clm_target'), 'SUPPORTS')],
    });

    const { workspace: next } = deleteEvidence(base, context(), 'evd_doc');
    expect(next.evidence[0]?.deletedAt).toBe(NOW);
    expect(next.relationships).toHaveLength(1);
    expect(next.auditLogs[0]?.action).toBe('EVIDENCE_DELETED');
  });

  it('hard-deletes a retracted link but keeps the audit entry that it existed', () => {
    const doc = evidence(INVOICE, { id: 'evd_doc' });
    const target = claim('Supported', { id: 'clm_target' });
    const base = workspace({
      evidence: [doc],
      claims: [target],
      relationships: [link(ref.evidence('evd_doc'), ref.claim('clm_target'), 'SUPPORTS', { id: 'rel_x' })],
    });

    const { workspace: next } = unlinkEntities(base, context(), 'rel_x');
    expect(next.relationships).toHaveLength(0);
    expect(next.auditLogs[0]?.action).toBe('EVIDENCE_UNLINKED');
    expect(next.auditLogs[0]?.summary).toContain('Supported');
  });

  it('names both endpoints when a link is created', () => {
    const doc = evidence(INVOICE, { id: 'evd_doc', title: 'Tax invoice' });
    const target = claim('The balance is outstanding', { id: 'clm_target' });
    const { workspace: next } = linkEntities(
      workspace({ evidence: [doc], claims: [target] }),
      context(),
      CASE_ID,
      { from: ref.evidence('evd_doc'), to: ref.claim('clm_target'), type: 'SUPPORTS' },
    );
    expect(next.relationships[0]?.origin).toBe('USER');
    expect(next.auditLogs[0]?.summary).toBe(
      'Linked Tax invoice → The balance is outstanding',
    );
  });

  it('records an accepted model suggestion as AI-originated, not as a human assertion', () => {
    const doc = evidence(INVOICE, { id: 'evd_doc', title: 'Tax invoice' });
    const target = claim('The balance is outstanding', { id: 'clm_target' });
    const { workspace: next } = linkEntities(
      workspace({ evidence: [doc], claims: [target] }),
      context(),
      CASE_ID,
      {
        from: ref.evidence('evd_doc'),
        to: ref.claim('clm_target'),
        type: 'SUPPORTS',
        origin: 'AI',
      },
    );
    expect(next.relationships[0]?.origin).toBe('AI');
    // The audit trail must distinguish approving a suggestion from originating a link.
    expect(next.auditLogs[0]?.action).toBe('SUGGESTION_ACCEPTED');
    expect(next.auditLogs[0]?.metadata.origin).toBe('AI');
  });

  it('refuses a link whose target does not exist, so a hallucinated id cannot dangle', () => {
    const doc = evidence(INVOICE, { id: 'evd_doc' });
    expect(() =>
      linkEntities(workspace({ evidence: [doc] }), context(), CASE_ID, {
        from: ref.evidence('evd_doc'),
        to: ref.claim('clm_never_existed'),
        type: 'SUPPORTS',
        origin: 'AI',
      }),
    ).toThrow(/clm_never_existed/);
  });

  it('refuses a link whose source does not exist', () => {
    const target = claim('Outstanding', { id: 'clm_target' });
    expect(() =>
      linkEntities(workspace({ claims: [target] }), context(), CASE_ID, {
        from: ref.evidence('evd_never_existed'),
        to: ref.claim('clm_target'),
        type: 'SUPPORTS',
      }),
    ).toThrow(/evd_never_existed/);
  });

  it('throws a readable error rather than writing against a record that is not loaded', () => {
    expect(() => deleteEvidence(workspace(), context(), 'evd_missing')).toThrow(/evd_missing/);
  });
});

describe('file evidence pipeline mutations', () => {
  const STORAGE_PATH = 'users/user_test/cases/case_test/evd_file1/original.pdf';
  const DIGEST = hashText('the stored bytes');

  /** The workspace as the upload flow leaves it after the intake commit. */
  function queuedWorkspace() {
    return queueEvidence(workspace(), context(), CASE_ID, {
      id: 'evd_file1', title: 'Bill', kind: 'PDF',
      fileName: 'bill.pdf', mimeType: 'application/pdf', sizeBytes: 1024,
    }).workspace;
  }

  it('creates the intake record first, claiming nothing it does not have yet', () => {
    const item = queuedWorkspace().evidence[0]!;
    expect(item.state).toBe('UPLOADING');
    // No path, no digest, no extraction: an interrupted upload leaves an honest row,
    // not a record that points at bytes that were never written.
    expect(item.storagePath).toBeNull();
    expect(item.sha256).toBeNull();
    expect(item.extraction).toBeNull();
    expect(() => evidenceSchema.parse(item)).not.toThrow();
  });

  it('completes the record once the bytes are stored', () => {
    const { workspace: next, changes } = recordEvidenceFile(queuedWorkspace(), context(), 'evd_file1',
      { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
    const item = next.evidence.find((record) => record.id === 'evd_file1')!;
    expect(item.state).toBe('QUEUED');
    expect(item.storagePath).toBe(STORAGE_PATH);
    expect(item.sha256).toBe(DIGEST);
    expect(item.sizeBytes).toBe(2048);
    // The audit entry travels with the write, as every mutation's does.
    expect(changes.some((change) => change.collection === 'auditLogs')).toBe(true);
    expect(next.auditLogs[0]?.action).toBe('EVIDENCE_UPLOADED');
  });

  it('leaves a recordable state alone when re-filing a retry after processing ran', () => {
    // A retry that arrives after the item was already extracted must not drag it back
    // to QUEUED — the extraction is still the truth about the record.
    const extracted = persistEvidenceExtraction(queuedWorkspace(), context(), 'evd_file1', {
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'DETERMINISTIC' }),
      state: 'EXTRACTED',
      failureReason: null,
    }).workspace;
    const { workspace: next } = recordEvidenceFile(extracted, context(), 'evd_file1',
      { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
    expect(next.evidence.find((record) => record.id === 'evd_file1')?.state).toBe('EXTRACTED');
  });

  it('refuses to re-file an item against different bytes', () => {
    const recorded = recordEvidenceFile(queuedWorkspace(), context(), 'evd_file1',
      { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
    // The digest identifies one set of bytes for the lifetime of the record; a second
    // file under the same id would silently re-identify the evidence.
    expect(() =>
      recordEvidenceFile(recorded.workspace, context(), 'evd_file1',
        { storagePath: STORAGE_PATH, sizeBytes: 4096, sha256: hashText('other bytes') }),
    ).toThrow(/different|sha256|original/i);
  });

  it('refuses to re-file an item that already points at a different stored file', () => {
    const recorded = recordEvidenceFile(queuedWorkspace(), context(), 'evd_file1',
      { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
    expect(() =>
      recordEvidenceFile(recorded.workspace, context(), 'evd_file1',
        { storagePath: 'users/user_test/cases/case_test/evd_file1/elsewhere.pdf', sizeBytes: 2048, sha256: DIGEST }),
    ).toThrow(/different stored original/);
  });

  it('refuses a record that is not in the workspace', () => {
    expect(() =>
      recordEvidenceFile(workspace(), context(), 'evd_missing', { storagePath: STORAGE_PATH, sizeBytes: 1, sha256: DIGEST }),
    ).toThrow(/evd_missing/);
  });

  /**
   * The interrupted upload.
   *
   * `queueEvidence` writes the row before the bytes exist, and `recordEvidenceFile` is the
   * only edge out of `UPLOADING`. Nothing closed the gap between them, so a cancelled,
   * failed or crashed upload left a row that showed a spinner for work running nowhere,
   * had the Process button disabled because it has no `storagePath`, was skipped by the
   * worklist as "in flight", and could never be replaced because re-picking the file mints
   * a new id. The only way out was deleting the case.
   */
  describe('an upload that never finished', () => {
    it('records the failure so the row stops claiming to be in flight', () => {
      const { workspace: next, changes } = failEvidenceUpload(
        queuedWorkspace(), context(), 'evd_file1', 'The connection dropped.',
      );
      const item = next.evidence.find((record) => record.id === 'evd_file1')!;
      expect(item.state).toBe('FAILED');
      expect(item.failureReason).toBe('The connection dropped.');
      expect(changes.some((change) => change.collection === 'auditLogs')).toBe(true);
      expect(() => evidenceSchema.parse(item)).not.toThrow();
    });

    it('refuses when the bytes did land', () => {
      // Not an upload failure: the original is stored. Calling it one would tell the user
      // their file was lost while it is sitting on the device, and it would strand a
      // perfectly readable document in a state that says it cannot be read.
      const recorded = recordEvidenceFile(queuedWorkspace(), context(), 'evd_file1',
        { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST }).workspace;
      expect(() => failEvidenceUpload(recorded, context(), 'evd_file1', 'nope')).toThrow(/already stored/);
    });

    it('takes the bytes and queues the item when the retry finally lands', () => {
      // The other half of the fix. Recording the failure would be a new dead end if the
      // row could not recover from it — the retry stores the same id to the same path.
      const failed = failEvidenceUpload(queuedWorkspace(), context(), 'evd_file1', 'Stopped.').workspace;
      const { workspace: next } = recordEvidenceFile(failed, context(), 'evd_file1',
        { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
      const item = next.evidence.find((record) => record.id === 'evd_file1')!;
      expect(item.state).toBe('QUEUED');
      expect(item.failureReason).toBeNull();
    });
  });

  /**
   * Restart recovery.
   *
   * There is no background worker: processing runs inline in the screen that started it.
   * So after the process is gone, every `UPLOADING` and `PROCESSING` row is describing work
   * that will never resume.
   */
  describe('reconciling records left mid-flight', () => {
    it('writes nothing when there is nothing to recover', () => {
      // A `null` rather than an empty mutation, so the caller skips the commit entirely
      // instead of writing an audit entry about nothing on every cold start.
      expect(reconcileInterruptedEvidence(workspace(), context())).toBeNull();
    });

    it('fails an upload whose bytes never arrived', () => {
      const mutation = reconcileInterruptedEvidence(queuedWorkspace(), context())!;
      const item = mutation.workspace.evidence.find((record) => record.id === 'evd_file1')!;
      expect(item.state).toBe('FAILED');
      expect(item.failureReason).toMatch(/closed before/i);
    });

    it('puts an abandoned reading back in the queue rather than failing it', () => {
      // The original is present and the reading is not, which is exactly what QUEUED
      // means. `FAILED` would report a failure that never happened, and `PROCESSING` is
      // the one state that permanently disables the button that could fix it.
      const base = workspace({
        evidence: [evidence('Total: INR 85,000.00', { id: 'evd_mid', state: 'PROCESSING' })],
      });
      const mutation = reconcileInterruptedEvidence(base, context())!;
      const item = mutation.workspace.evidence.find((record) => record.id === 'evd_mid')!;
      expect(item.state).toBe('QUEUED');
      expect(item.failureReason).toBeNull();
    });

    it('leaves a stored-but-unread item exactly as it is', () => {
      // QUEUED is already the honest label for a document waiting to be read, and the
      // Process button already works on it. Making it *findable* is the worklist's job.
      const base = workspace({
        evidence: [evidence('Total: INR 85,000.00', { id: 'evd_waiting', state: 'QUEUED' })],
      });
      expect(reconcileInterruptedEvidence(base, context())).toBeNull();
    });

    it('audits once per case, not once per record', () => {
      // A launch that recovered eleven rows must not push eleven near-identical lines into
      // the one collection a user reads in bulk.
      const base = workspace({
        evidence: [
          evidence('a', { id: 'evd_a', state: 'PROCESSING' }),
          evidence('b', { id: 'evd_b', state: 'PROCESSING' }),
          evidence('c', { id: 'evd_c', state: 'PROCESSING' }),
        ],
      });
      const mutation = reconcileInterruptedEvidence(base, context())!;
      const audits = mutation.changes.filter((change) => change.collection === 'auditLogs');
      expect(audits).toHaveLength(1);
      expect(mutation.workspace.auditLogs[0]?.summary).toMatch(/3 items/);
      expect(mutation.workspace.auditLogs[0]?.entityRefs).toHaveLength(3);
    });

    it('ignores records the user has already deleted', () => {
      const base = workspace({
        evidence: [evidence('gone', { id: 'evd_gone', state: 'PROCESSING', deletedAt: NOW })],
      });
      expect(reconcileInterruptedEvidence(base, context())).toBeNull();
    });
  });

  it('persists an extraction and clears the failure reason', () => {
    const base = queuedWorkspace();
    const failed = persistEvidenceExtraction(base, context(), 'evd_file1',
      { extraction: null, state: 'REVIEW_REQUIRED', failureReason: 'No text could be read from this file automatically.' }).workspace;
    const { workspace: next, changes } = persistEvidenceExtraction(failed, context(), 'evd_file1', {
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'OCR' }),
      state: 'EXTRACTED',
      failureReason: null,
    });
    const item = next.evidence.find((record) => record.id === 'evd_file1')!;
    expect(item.state).toBe('EXTRACTED');
    expect(item.failureReason).toBeNull();
    expect(item.extraction?.amounts[0]?.minorUnits).toBe(8_500_000);
    expect(item.extraction?.amounts[0]?.method).toBe('OCR');
    expect(next.auditLogs.some((entry) => entry.action === 'EVIDENCE_PROCESSED')).toBe(true);
    // The audit records the state and the extractor, never document contents.
    expect(JSON.stringify(next.auditLogs)).not.toContain('85,000');
  });

  it('requires a reason whenever nothing was extracted', () => {
    expect(() =>
      persistEvidenceExtraction(queuedWorkspace(), context(), 'evd_file1', { extraction: null, state: 'REVIEW_REQUIRED', failureReason: null }),
    ).toThrow(/must say why/);
    expect(() =>
      persistEvidenceExtraction(queuedWorkspace(), context(), 'evd_file1', { extraction: null, state: 'FAILED', failureReason: '  ' }),
    ).toThrow(/must say why/);
  });

  it('requires passages whenever it claims an extraction', () => {
    expect(() =>
      persistEvidenceExtraction(queuedWorkspace(), context(), 'evd_file1', { extraction: null, state: 'EXTRACTED', failureReason: null }),
    ).toThrow(/extraction with passages/);
  });

  it('keeps human corrections and the confirmed state through a reprocess', () => {
    const extracted = persistEvidenceExtraction(queuedWorkspace(), context(), 'evd_file1', {
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'OCR' }),
      state: 'EXTRACTED',
      failureReason: null,
    }).workspace;
    const confirmed = persistEvidenceExtraction(extracted, context(), 'evd_file1', {
      // A no-op outcome is not how confirmation happens; the fields are set directly to
      // mimic `confirmEvidenceFields` having run against the extraction.
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'OCR' }),
      state: 'EXTRACTED',
      failureReason: null,
    }).workspace;
    const withConfirmation = applyChanges(confirmed, [put('evidence', {
      ...confirmed.evidence.find((record) => record.id === 'evd_file1')!,
      confirmedFields: { documentType: 'Invoice' },
      confirmedAt: NOW,
      state: 'CONFIRMED' as const,
    })]);

    const { workspace: next } = persistEvidenceExtraction(withConfirmation, context(), 'evd_file1', {
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 95,000.00', method: 'OCR' }),
      state: 'EXTRACTED',
      failureReason: null,
    });
    const item = next.evidence.find((record) => record.id === 'evd_file1')!;
    // The machine value was genuinely refreshed; the human's correction survived it.
    expect(item.extraction?.amounts[0]?.minorUnits).toBe(9_500_000);
    expect(item.confirmedFields).toEqual({ documentType: 'Invoice' });
    expect(item.confirmedAt).toBe(NOW);
    expect(item.state).toBe('CONFIRMED');
  });

  it('fills in the digest a record was missing', () => {
    const base = queuedWorkspace();
    const { workspace: next } = persistEvidenceExtraction(base, context(), 'evd_file1', {
      extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'DETERMINISTIC' }),
      state: 'EXTRACTED',
      failureReason: null,
      sha256: DIGEST,
      sizeBytes: 2048,
    });
    const item = next.evidence.find((record) => record.id === 'evd_file1')!;
    expect(item.sha256).toBe(DIGEST);
    expect(item.sizeBytes).toBe(2048);
  });

  it('refuses to replace a digest that was already recorded', () => {
    const recorded = recordEvidenceFile(queuedWorkspace(), context(), 'evd_file1',
      { storagePath: STORAGE_PATH, sizeBytes: 2048, sha256: DIGEST });
    expect(() =>
      persistEvidenceExtraction(recorded.workspace, context(), 'evd_file1', {
        extraction: extractFromText({ evidenceId: 'evd_file1', title: 'Bill', text: 'Total: INR 85,000.00', method: 'DETERMINISTIC' }),
        state: 'EXTRACTED',
        failureReason: null,
        sha256: hashText('different bytes entirely'),
      }),
    ).toThrow(/recorded original/);
  });
});
describe('runCaseAnalysis', () => {
  const caseWithFindings = () =>
    workspace({
      evidence: [evidence(INVOICE, { id: 'evd_invoice' }), evidence(RECEIPT, { id: 'evd_receipt' })],
      claims: [claim('Nothing backs this up', { id: 'clm_orphan' })],
    });

  it('writes findings, refreshes claim states and stamps the case in one change set', () => {
    const { workspace: next, changes, findingCount } = runCaseAnalysis(
      caseWithFindings(),
      context(),
      CASE_ID,
    );

    expect(findingCount).toBeGreaterThan(0);
    expect(next.analysisResults.length).toBe(findingCount);
    expect(next.cases[0]?.lastAnalyzedAt).toBe(NOW);
    expect(changes.some((change) => change.collection === 'auditLogs')).toBe(true);
    expect(next.auditLogs[0]?.action).toBe('ANALYSIS_RUN');
  });

  it('writes nothing but the audit entry when a re-run changes no finding', () => {
    const first = runCaseAnalysis(caseWithFindings(), context(), CASE_ID);
    const second = runCaseAnalysis(first.workspace, context(), CASE_ID);

    const rewritten = second.changes.filter((change) => change.collection === 'analysisResults');
    expect(rewritten).toEqual([]);
    // lastAnalyzedAt still moves: the case was genuinely re-analysed.
    expect(second.changes.some((change) => change.collection === 'cases')).toBe(true);
  });

  it('caches the claim state the findings imply', () => {
    const supporting = evidence(INVOICE, { id: 'evd_invoice' });
    const target = claim('Backed by the invoice', { id: 'clm_backed' });
    const base = workspace({
      evidence: [supporting],
      claims: [target],
      relationships: [link(ref.evidence('evd_invoice'), ref.claim('clm_backed'), 'SUPPORTS')],
    });

    const { workspace: next } = runCaseAnalysis(base, context(), CASE_ID);
    expect(next.claims[0]?.state).toBe('SUPPORTED');
  });

  it('keeps a dismissed finding dismissed across a re-run', () => {
    const first = runCaseAnalysis(caseWithFindings(), context(), CASE_ID);
    const target = first.workspace.analysisResults[0]!;
    const dismissed = reviewFinding(first.workspace, context(), target.id, 'DISMISSED', 'Checked');

    const second = runCaseAnalysis(dismissed.workspace, context(), CASE_ID);
    const after = second.workspace.analysisResults.find((item) => item.id === target.id);
    expect(after?.status).toBe('DISMISSED');
    expect(after?.reviewNote).toBe('Checked');
  });

  it('does not edit the finding when it is reviewed, only its review fields', () => {
    const first = runCaseAnalysis(caseWithFindings(), context(), CASE_ID);
    const target = first.workspace.analysisResults[0]!;
    const { workspace: next } = reviewFinding(first.workspace, context(), target.id, 'REVIEWED');
    const after = next.analysisResults.find((item) => item.id === target.id)!;

    expect(after.explanation).toBe(target.explanation);
    expect(after.inputs).toEqual(target.inputs);
    expect(after.status).toBe('REVIEWED');
    expect(after.reviewedAt).toBe(NOW);
  });
});

describe('LocalRepository', () => {
  const repository = () => new LocalRepository(createMemoryStore());

  const seeded = async () => {
    const store = repository();
    const created = createCase(workspace({ cases: [] }), context(), { title: 'Payment dispute' });
    await store.commit(OWNER, created.changes);
    return { store, caseId: created.workspace.cases[0]!.id };
  };

  it('round-trips a case through storage', async () => {
    const { store, caseId } = await seeded();
    const cases = await store.listCases(OWNER);
    expect(cases.map((item) => item.id)).toEqual([caseId]);

    const loaded = await store.loadWorkspace(OWNER, caseId);
    expect(loaded.cases[0]?.title).toBe('Payment dispute');
    expect(loaded.auditLogs).toHaveLength(1);
  });

  it('keeps two cases in separate shards', async () => {
    const store = repository();
    const first = createCase(workspace({ cases: [] }), context(), { title: 'First' });
    await store.commit(OWNER, first.changes);
    const second = createCase(first.workspace, context(), { title: 'Second' });
    await store.commit(OWNER, second.changes);

    const firstId = first.workspace.cases[0]!.id;
    const secondId = second.workspace.cases.find((item) => item.id !== firstId)!.id;

    const loaded = await store.loadWorkspace(OWNER, firstId);
    expect(loaded.cases.map((item) => item.id)).toEqual([firstId]);
    expect(loaded.auditLogs.every((entry) => entry.caseId === firstId)).toBe(true);

    const other = await store.loadWorkspace(OWNER, secondId);
    expect(other.auditLogs.every((entry) => entry.caseId === secondId)).toBe(true);
  });

  it('safely serializes concurrent commits to the same case without losing writes', async () => {
    const { store, caseId } = await seeded();
    const current = await store.loadWorkspace(OWNER, caseId);
    const claim1 = createClaim(current, context(), caseId, { statement: 'Concurrent claim 1' });
    const claim2 = createClaim(current, context(), caseId, { statement: 'Concurrent claim 2' });

    await Promise.all([
      store.commit(OWNER, claim1.changes),
      store.commit(OWNER, claim2.changes),
    ]);

    const loaded = await store.loadWorkspace(OWNER, caseId);
    expect(loaded.claims).toHaveLength(2);
    expect(loaded.claims.map((c) => c.statement).sort()).toEqual([
      'Concurrent claim 1',
      'Concurrent claim 2',
    ]);
  });

  it('hides a soft-deleted case from the list without losing its records', async () => {
    const { store, caseId } = await seeded();
    const current = await store.loadWorkspace(OWNER, caseId);
    const removed = updateCase(current, context(), caseId, {});
    await store.commit(OWNER, [
      put('cases', { ...removed.workspace.cases[0]!, deletedAt: NOW }),
    ]);

    expect(await store.listCases(OWNER)).toEqual([]);
    expect((await store.loadWorkspace(OWNER, caseId)).cases[0]?.deletedAt).toBe(NOW);
  });

  it('refuses a commit that would write another user data', async () => {
    const store = repository();
    const foreign = createCase(workspace({ cases: [] }), { ...context(), ownerId: 'user_other' }, {
      title: 'Not mine',
    });
    await expect(store.commit(OWNER, foreign.changes)).rejects.toThrow(/user_other/);
  });

  it('persists a whole analysis run and reloads it intact', async () => {
    const { store, caseId } = await seeded();
    const loaded = await store.loadWorkspace(OWNER, caseId);
    const withEvidence = createNote(loaded, context(), caseId, {
      title: 'Invoice note',
      text: INVOICE,
    });
    await store.commit(OWNER, withEvidence.changes);

    const orphan = createClaim(withEvidence.workspace, context(), caseId, {
      statement: 'Nothing backs this up',
    });
    await store.commit(OWNER, orphan.changes);

    const analysed = runCaseAnalysis(orphan.workspace, context(), caseId);
    await store.commit(OWNER, analysed.changes);

    const reloaded = await store.loadWorkspace(OWNER, caseId);
    expect(reloaded.analysisResults.length).toBe(analysed.findingCount);
    expect(reloaded.analysisResults.some((item) => item.resultType === 'UNSUPPORTED_CLAIM')).toBe(true);
    expect(reloaded.cases[0]?.lastAnalyzedAt).toBe(NOW);
  });

  it('removes a record the change set deleted', async () => {
    const { store, caseId } = await seeded();
    const loaded = await store.loadWorkspace(OWNER, caseId);
    const note = createNote(loaded, context(), caseId, { title: 'Note', text: 'Invoice No: INV-1' });
    const target = claim('A claim', { id: 'clm_x', caseId });
    await store.commit(OWNER, [...note.changes, put('claims', target)]);

    const linked = linkEntities(await store.loadWorkspace(OWNER, caseId), context(), caseId, {
      from: { kind: 'evidence', id: note.workspace.evidence[0]!.id },
      to: { kind: 'claim', id: 'clm_x' },
      type: 'SUPPORTS',
    });
    await store.commit(OWNER, linked.changes);

    const relationshipId = linked.workspace.relationships[0]!.id;
    const unlinked = unlinkEntities(await store.loadWorkspace(OWNER, caseId), context(), relationshipId);
    await store.commit(OWNER, unlinked.changes);

    expect((await store.loadWorkspace(OWNER, caseId)).relationships).toEqual([]);
  });

  it('notifies a workspace watcher when its case changes', async () => {
    const { store, caseId } = await seeded();
    const seen: number[] = [];
    const stop = store.watchWorkspace(OWNER, caseId, (value) => seen.push(value.evidence.length));
    // The initial value is delivered asynchronously, like a Firestore snapshot.
    await flush();
    expect(seen).toEqual([0]);

    const loaded = await store.loadWorkspace(OWNER, caseId);
    await store.commit(OWNER, createNote(loaded, context(), caseId, { title: 'N', text: 'x' }).changes);
    await flush();
    stop();

    expect(seen.at(-1)).toBe(1);
  });

  it('delivers nothing after unsubscribe, including a read already in flight', async () => {
    const { store, caseId } = await seeded();
    let calls = 0;
    // Unsubscribing in the same tick as subscribing must cancel the initial delivery.
    store.watchCases(OWNER, () => {
      calls += 1;
    })();
    await flush();
    expect(calls).toBe(0);

    const stop = store.watchCases(OWNER, () => {
      calls += 1;
    });
    await flush();
    const before = calls;
    stop();

    const loaded = await store.loadWorkspace(OWNER, caseId);
    await store.commit(OWNER, createNote(loaded, context(), caseId, { title: 'N', text: 'x' }).changes);
    await flush();

    expect(before).toBe(1);
    expect(calls).toBe(before);
  });

  it('survives a corrupted shard instead of making the case unopenable', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    const created = createCase(workspace({ cases: [] }), context(), { title: 'Case' });
    await repo.commit(OWNER, created.changes);
    const caseId = created.workspace.cases[0]!.id;

    await store.setMany([[`detact:v1:${OWNER}:case:${caseId}`, '{ not json']]);
    const loaded = await repo.loadWorkspace(OWNER, caseId);
    expect(loaded.cases[0]?.title).toBe('Case');
    expect(loaded.auditLogs).toEqual([]);
  });

  it('drops a stored record that no longer matches the schema', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await store.setMany([[`detact:v1:${OWNER}:cases`, JSON.stringify([{ id: 'case_bad' }])]]);
    expect(await repo.listCases(OWNER)).toEqual([]);
  });

  /**
   * The shard boundary.
   *
   * The case index has always been validated on the way in; the per-case shard was not, and
   * the keys are versioned `v1` with no migration behind them — so a row written by any
   * build the phone has ever run comes back exactly as it was written. These read a shard
   * the adapter never wrote, which is the only way to stand in for an older build.
   */
  describe('a shard holding records an older build wrote', () => {
    const INDEX_KEY = `detact:v1:${OWNER}:cases`;
    const SHARD_KEY = `detact:v1:${OWNER}:case:${CASE_ID}`;

    const storeHolding = (shard: Record<string, unknown>) =>
      createMemoryStore({
        [INDEX_KEY]: JSON.stringify([testCase()]),
        [SHARD_KEY]: JSON.stringify(shard),
      });

    let warnings: string[] = [];

    beforeEach(() => {
      warnings = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('drops the rows that no longer parse and keeps their valid siblings', async () => {
      const good = claim('Still readable', { id: 'clm_good' });
      const edge = link(ref.evidence('evd_1'), ref.claim('clm_good'), 'SUPPORTS', { id: 'rel_good' });
      const repo = new LocalRepository(
        storeHolding({
          // `PROBABLY_TRUE` and `REFUTES` are not members of their enums. They are the
          // shape this actually takes in practice: a renamed member, still stored.
          claims: [good, { ...good, id: 'clm_stale', state: 'PROBABLY_TRUE' }],
          relationships: [edge, { ...edge, id: 'rel_stale', type: 'REFUTES' }],
        }),
      );

      const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
      expect(loaded.claims.map((item) => item.id)).toEqual(['clm_good']);
      expect(loaded.relationships.map((item) => item.id)).toEqual(['rel_good']);
      // And the case still opens. A boundary that failed the whole shard would leave the
      // user no screen from which to reach any of it.
      expect(loaded.cases[0]?.id).toBe(CASE_ID);
    });

    it('reports the skip by collection and count, naming no record and no owner', async () => {
      const good = claim('Still readable', { id: 'clm_good' });
      const repo = new LocalRepository(
        storeHolding({
          claims: [good, { ...good, id: 'clm_stale', state: 'PROBABLY_TRUE' }],
        }),
      );

      await repo.loadWorkspace(OWNER, CASE_ID);
      expect(warnings.some((line) => line.includes('claims'))).toBe(true);
      // The tally is the part worth acting on: one stale row and a shard full of them read
      // the same in a log otherwise.
      expect(warnings.some((line) => line.includes('1 unreadable record'))).toBe(true);
      // `Skipped` is shared with the two remote adapters, and the prefix is the one thing that
      // must not be shared with them: a row this phone lost and a row a server returned
      // unreadable send a developer to different files. Pinned because a shared class is
      // exactly where that gets flattened into one voice.
      expect(warnings.every((line) => line.startsWith('[local]'))).toBe(true);
      const logged = warnings.join('\n');
      expect(logged).not.toContain('clm_stale');
      expect(logged).not.toContain(OWNER);
    });

    it('returns a shard whose every row is valid exactly as it was stored', async () => {
      const note = evidence('Invoice No: INV-2024-018', { id: 'evd_note' });
      const target = claim('The balance is outstanding', { id: 'clm_target' });
      const edge = link(ref.evidence('evd_note'), ref.claim('clm_target'), 'SUPPORTS', { id: 'rel_edge' });
      const repo = new LocalRepository(
        storeHolding({ evidence: [note], claims: [target], relationships: [edge] }),
      );

      const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
      // Compared against the JSON round trip, which is what "unchanged" means for a store
      // that holds text: the parse must not be quietly rewriting anything on the way back.
      expect(loaded.evidence).toEqual(JSON.parse(JSON.stringify([note])));
      expect(loaded.claims).toEqual(JSON.parse(JSON.stringify([target])));
      expect(loaded.relationships).toEqual(JSON.parse(JSON.stringify([edge])));
      expect(warnings).toEqual([]);
    });

    it('skips a collection that is not a list instead of throwing while reading it', async () => {
      // Drift is not only per row: a slot that was once keyed by id would make the parse
      // loop itself the thing that makes the case unopenable.
      const repo = new LocalRepository(storeHolding({ claims: { clm_a: claim('Keyed by id') } }));
      const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
      expect(loaded.claims).toEqual([]);
      expect(loaded.cases[0]?.id).toBe(CASE_ID);
    });

    it('says nothing about a collection an older build had not invented yet', async () => {
      // An absent slot is not a skipped record. Warning on one would put a line in the log
      // for every case written before `seals` existed.
      const repo = new LocalRepository(storeHolding({ claims: [claim('Fine', { id: 'clm_ok' })] }));
      const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
      expect(loaded.seals).toEqual([]);
      expect(loaded.claims).toHaveLength(1);
      expect(warnings).toEqual([]);
    });
  });

  /**
   * The other half of the same boundary: the case index.
   *
   * The index has always dropped a row that will not parse, so the drift itself was handled —
   * but on terms the shard above no longer shares. Two gaps, and neither is cosmetic.
   *
   * It dropped the row in silence. A case disappearing from the list is the most alarming thing
   * this app can do to a user, and there was no line anywhere saying it had happened, let alone
   * how many times. The tally is the number worth acting on for exactly the reason it is on the
   * shard: one stale case and an index full of them read identically otherwise.
   *
   * And it trusted the slot to be a list. `parseJson` types the index as `unknown[]` without
   * checking, so an index a build wrote as an object keyed by id reached `.flatMap` and threw a
   * `TypeError` out of `listCases` — which is worse than the shard equivalent, not better: a
   * shard that will not read costs one case, while the index backs the screen the app opens on,
   * so the whole account reads as empty and every case in it is unreachable.
   */
  describe('a case index holding rows an older build wrote', () => {
    const INDEX_KEY = `detact:v1:${OWNER}:cases`;

    /** The index is written as a bare array of cases, so a raw value stands in for any build. */
    const repoHolding = (index: unknown) =>
      new LocalRepository(createMemoryStore({ [INDEX_KEY]: JSON.stringify(index) }));

    /** `IN_PROGRESS` is not a member of `CaseStatusEnum`; `IN_REVIEW` is what it was renamed to. */
    const staleCase = () => ({
      ...testCase(),
      id: 'case_stale',
      title: 'Deposit withheld after the tenancy ended',
      status: 'IN_PROGRESS',
    });

    let warnings: string[] = [];

    beforeEach(() => {
      warnings = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports the dropped case by collection and count, naming no record and no owner', async () => {
      const stale = staleCase();
      const repo = repoHolding([testCase(), stale]);

      expect((await repo.listCases(OWNER)).map((item) => item.id)).toEqual([CASE_ID]);
      expect(warnings.some((line) => line.includes('cases'))).toBe(true);
      expect(warnings.some((line) => line.includes('1 unreadable record'))).toBe(true);
      // Named apart from the shard's tally, which says "a case". `loadWorkspace` reads the
      // index and a shard in one call, so a log that gave both the same scope could not say
      // which of the two is losing rows — and they fail for different reasons.
      expect(warnings.some((line) => line.includes('read the case list with'))).toBe(true);
      // The same rule the shard and both other adapters hold to. This is an evidence app: a
      // log line that carried the row would carry the title of a case a user is in a dispute
      // over, and the storage key it came from already carries the owner id.
      const logged = warnings.join('\n');
      expect(logged).not.toContain('case_stale');
      expect(logged).not.toContain(stale.title);
      expect(logged).not.toContain(OWNER);
    });

    it('still lists the readable cases of an index a build wrote as an object', async () => {
      const repo = repoHolding({ [CASE_ID]: testCase() });

      // Nothing is recoverable from a slot that is not a list, but the read has to answer
      // rather than reject: `listCases` rejecting is a case list that shows an error where
      // the user's cases were, and no screen from which to reach any of them.
      expect(await repo.listCases(OWNER)).toEqual([]);
      expect(warnings.some((line) => line.includes('cases'))).toBe(true);
    });

    it('opens a case whose shard is intact even when the index around it drifted', async () => {
      // The two reads are independent and `loadWorkspace` awaits both. A drifted index row
      // must not cost the case whose row still parses, and must not cost the shard either.
      const repo = new LocalRepository(
        createMemoryStore({
          [INDEX_KEY]: JSON.stringify([testCase(), staleCase()]),
          [`detact:v1:${OWNER}:case:${CASE_ID}`]: JSON.stringify({
            claims: [claim('Still readable', { id: 'clm_good' })],
          }),
        }),
      );

      const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
      expect(loaded.cases.map((item) => item.id)).toEqual([CASE_ID]);
      expect(loaded.claims.map((item) => item.id)).toEqual(['clm_good']);
    });

    it('says nothing about an index whose every row still parses', async () => {
      const repo = repoHolding([testCase()]);

      expect((await repo.listCases(OWNER)).map((item) => item.id)).toEqual([CASE_ID]);
      expect(warnings).toEqual([]);
    });

    it('says nothing about a user who has no index yet', async () => {
      // An absent key is a new account, not a skipped record — the same distinction the shard
      // draws for a collection an older build had not invented.
      const repo = new LocalRepository(createMemoryStore());

      expect(await repo.listCases(OWNER)).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  it('clears everything belonging to one user and nobody else', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, createCase(workspace({ cases: [] }), context(), { title: 'Mine' }).changes);
    await repo.commit(
      'user_other',
      createCase(workspace({ cases: [] }), { ...context(), ownerId: 'user_other' }, { title: 'Theirs' })
        .changes,
    );

    await repo.clear(OWNER);
    expect(await repo.listCases(OWNER)).toEqual([]);
    expect(await repo.listCases('user_other')).toHaveLength(1);
  });
});

describe('seedSampleWorkspace', () => {
  it('commits the whole corpus into an empty repository', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    const seeded = await seedSampleWorkspace(repo, OWNER);
    expect(seeded).not.toBeNull();
    expect(seeded?.id).toBe(SAMPLE_CASE_ID);
    const cases = await repo.listCases(OWNER);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe(SAMPLE_CASE_ID);
  });

  it('skips seeding when cases already exist and force is not set', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await seedSampleWorkspace(repo, OWNER);
    const second = await seedSampleWorkspace(repo, OWNER);
    expect(second).toBeNull();
  });

  it('overwrites and re-seeds when force is true even if cases exist', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await seedSampleWorkspace(repo, OWNER);
    const forced = await seedSampleWorkspace(repo, OWNER, { force: true });
    expect(forced).not.toBeNull();
    expect(forced?.id).toBe(SAMPLE_CASE_ID);
    const cases = await repo.listCases(OWNER);
    expect(cases).toHaveLength(1);
  });
});
