import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The file pipeline, end to end, over a real repository.
 *
 * Unit files pin each stage; this one pins that the stages compose into what the user
 * actually experiences: a picked file becomes a record, the record gains its stored
 * original, the original is read on this device, the record carries the result — and a
 * case assessment built on top of that sees exactly what was read. The only mocked
 * layer is the one that cannot exist in Node: the filesystem the store reads from.
 */

const mocks = vi.hoisted(() => ({
  storedBytes: new Uint8Array(),
  readStored: vi.fn(),
}));

vi.mock('../src/services/storage/evidence-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/storage/evidence-storage')>()),
  readStoredEvidenceFile: mocks.readStored,
}));
vi.mock('../src/services/ingestion/read-file', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  return {
    readBytes: async () => mocks.storedBytes,
    sha256Hex: (bytes: Uint8Array) => bytesToHex(sha256(bytes)),
  };
});

import { createClaim, createCase, queueEvidence, recordEvidenceFile, type MutationContext } from '@data/mutations';
import { createMemoryStore } from '@/data/local/key-value-store';
import { LocalRepository } from '@/data/local/local-repository';
import { emptyWorkspace } from '@domain/models';
import { runAnalysis } from '@domain/rules/engine';
import { hashText } from '@domain/hashing';
import { requestCaseAnalysis, requestEvidenceProcessing } from '../src/services/ai/case-analysis';

const OWNER = 'user_pipeline';
const TEXT = 'PAYMENT CONFIRMATION\nTotal amount paid: INR 40,000.00 on 26/03/2024\nUTR: 40382881';

const NOW = 1_700_000_000_000;
const context = (): MutationContext => ({ ownerId: OWNER, now: NOW });

beforeEach(() => {
  mocks.readStored.mockReset();
  mocks.readStored.mockResolvedValue({ uri: 'file:///stored-original', release: () => {} });
  mocks.storedBytes = new TextEncoder().encode(TEXT);
});

/** A case in a real repository, with one file taken through store → record. */
async function caseWithStoredFile(evidenceId: string) {
  const repository = new LocalRepository(createMemoryStore());
  const created = createCase(emptyWorkspace(), context(), { title: 'Pipeline case' });
  await repository.commit(OWNER, created.changes);
  const caseId = created.workspace.cases[0]!.id;

  // Step 1: the intake record, claiming nothing it does not have yet.
  const queued = queueEvidence(created.workspace, context(), caseId, {
    id: evidenceId, title: 'Payment confirmation', kind: 'TEXT',
    fileName: 'confirmation.txt', mimeType: 'text/plain', sizeBytes: null,
  });
  await repository.commit(OWNER, queued.changes);

  // Step 2: the bytes land in the store (mocked here) and the record gains them.
  const storagePath = `users/${OWNER}/cases/${caseId}/${evidenceId}/original.txt`;
  const recorded = recordEvidenceFile(queued.workspace, context(), evidenceId,
    { storagePath, sizeBytes: TEXT.length, sha256: hashText(TEXT) });
  await repository.commit(OWNER, recorded.changes);

  return { repository, caseId };
}

describe('the file evidence pipeline', () => {
  it('lands a stored file as one honest, extracted record with a job behind it', async () => {
    const { repository, caseId } = await caseWithStoredFile('evd_file1');

    const receipt = await requestEvidenceProcessing(caseId, 'evd_file1', { repository, ownerId: OWNER });
    expect(receipt.state).toBe('EXTRACTED');

    const after = await repository.loadWorkspace(OWNER, caseId);
    const item = after.evidence.find((record) => record.id === 'evd_file1')!;
    expect(item.state).toBe('EXTRACTED');
    expect(item.storagePath).toBe(`users/${OWNER}/cases/${caseId}/evd_file1/original.txt`);
    expect(item.sha256).toBe(hashText(TEXT));
    expect(item.sizeBytes).toBe(TEXT.length);
    expect(item.extraction?.amounts[0]?.minorUnits).toBe(4_000_000);
    expect(item.extraction?.transactionIds[0]?.normalized).toBe('40382881');
    // The run left a job record that agrees with the evidence record.
    const job = after.processingJobs.find((record) => record.evidenceId === 'evd_file1');
    expect(job?.state).toBe('EXTRACTED');
    // And an audit entry, written beside the change that caused it.
    expect(after.auditLogs.some((entry) => entry.action === 'EVIDENCE_PROCESSED' && entry.entityRefs.some((ref) => ref.id === 'evd_file1'))).toBe(true);
  });

  it('reports the same file added twice as one source, by hash, once both are read', async () => {
    const { repository, caseId } = await caseWithStoredFile('evd_file1');

    // The identical bytes, picked again: a second record with the same digest.
    const first = await repository.loadWorkspace(OWNER, caseId);
    const secondQueued = queueEvidence(first, context(), caseId, {
      id: 'evd_file2', title: 'Same confirmation again', kind: 'TEXT',
      fileName: 'confirmation (1).txt', mimeType: 'text/plain', sizeBytes: null,
    });
    await repository.commit(OWNER, secondQueued.changes);
    const secondRecorded = recordEvidenceFile(secondQueued.workspace, context(), 'evd_file2',
      { storagePath: `users/${OWNER}/cases/${caseId}/evd_file2/original.txt`, sizeBytes: TEXT.length, sha256: hashText(TEXT) });
    await repository.commit(OWNER, secondRecorded.changes);

    await requestEvidenceProcessing(caseId, 'evd_file1', { repository, ownerId: OWNER });
    await requestEvidenceProcessing(caseId, 'evd_file2', { repository, ownerId: OWNER });

    const withClaim = await repository.loadWorkspace(OWNER, caseId);
    const claimMutation = createClaim(withClaim, context(), caseId, { statement: 'The payment was made' });
    await repository.commit(OWNER, claimMutation.changes);

    const run = runAnalysis(await repository.loadWorkspace(OWNER, caseId), caseId, NOW);
    const duplicate = run.results.find((result) => result.resultType === 'DUPLICATE_EVIDENCE');
    // The finding names both records and rests on the shared fingerprint — the thing
    // that could never happen while sha256 never reached the evidence record.
    expect(duplicate).toBeDefined();
    expect(duplicate?.supportingEvidenceIds).toEqual(expect.arrayContaining(['evd_file1', 'evd_file2']));
    expect(duplicate?.inputs['SHA-256']).toBe(hashText(TEXT));
  });

  it('flows an extracted file into a case assessment as a read source', async () => {
    const { repository, caseId } = await caseWithStoredFile('evd_file1');
    await requestEvidenceProcessing(caseId, 'evd_file1', { repository, ownerId: OWNER });

    const withClaim = await repository.loadWorkspace(OWNER, caseId);
    await repository.commit(OWNER, createClaim(withClaim, context(), caseId, { statement: 'The payment of INR 40,000.00 was made' }).changes);

    // The assessment entry point the case screen uses: runs the engine, writes the
    // report and the job record that names it.
    const receipt = await requestCaseAnalysis(caseId, { repository, ownerId: OWNER });
    expect(receipt.state).toBe('ANALYZED');
    const after0 = await repository.loadWorkspace(OWNER, caseId);
    const report = after0.caseAnalyses[0]!;

    // The file was read before the assessment ran, so the assessment counts it.
    expect(report.coverage.processedEvidence).toBe(1);
    expect(report.coverage.excludedEvidenceIds).toEqual([]);
    expect(report.model).toBe('deterministic-rule-engine');
    // A case analysis also writes the findings its rules produced.
    const after = await repository.loadWorkspace(OWNER, caseId);
    expect(after.caseAnalyses.some((saved) => saved.id === report.id)).toBe(true);
    expect(after.processingJobs.some((job) => job.caseId === caseId && job.type === 'CASE' && job.state === 'ANALYZED')).toBe(true);
  });
});