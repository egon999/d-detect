import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * The processing client's contract, tested against the pipeline that now exists: no
 * network, no callables, real ingestion over a mocked file store. What these tests pin
 * is honesty — every terminal state a processing attempt can produce is backed by a
 * job record and an evidence record that say the same thing, and no unread file ever
 * produces an extraction.
 */

const mocks = vi.hoisted(() => ({
  user: { currentUser: { uid: 'user_test' } as { uid: string } | null },
  storedBytes: new Uint8Array(),
  readStored: vi.fn(),
  // Spied rather than plain, so a test can assert that a recording never pulls its bytes
  // into memory. Without this the streaming path could be reverted to a whole-file read and
  // every assertion in this file would still pass.
  readBytes: vi.fn(),
  sha256File: vi.fn(),
}));

vi.mock('../src/data/firebase/auth', () => ({ firebaseAuth: async () => mocks.user }));
// Spread from the original rather than listing exports by hand. `processEvidenceItem` pulls
// `isEvidenceFileError` out of this module alongside the reader, and a hand-written factory
// that named only the reader made every test in this file fail on an undefined export the
// moment that import was added — with the real cause hidden behind the client's bounded
// error sentence. Only the filesystem-touching read is replaced.
vi.mock('../src/services/storage/evidence-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/storage/evidence-storage')>()),
  readStoredEvidenceFile: mocks.readStored,
}));
// The byte layer under `ingestFile`: expo-file-system cannot load in Node, so the read
// is pointed at a per-test buffer. The hash is the real one, so a record's digest and
// the bytes it came from still have to agree.
vi.mock('../src/services/ingestion/read-file', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  mocks.readBytes.mockImplementation(async () => mocks.storedBytes);
  // A recording is never read into memory by `ingestFile` — it takes the size and the
  // streamed digest instead — so these two stand in for that path. Both are derived from
  // the same per-test buffer as the pair above, which keeps a recording's stored digest
  // agreeing with its bytes exactly as a document's does.
  mocks.sha256File.mockImplementation(async () => bytesToHex(sha256(mocks.storedBytes)));
  return {
    readBytes: mocks.readBytes,
    sha256Hex: (bytes: Uint8Array) => bytesToHex(sha256(bytes)),
    fileSize: async () => mocks.storedBytes.length,
    sha256File: mocks.sha256File,
  };
});

import { processingError, requestCaseAnalysis, requestEvidenceProcessing, runDirectCaseAnalysis } from '../src/services/ai/case-analysis';
// Resolves through the mock above, which spreads the original — so this is the real class
// the store throws, not a stand-in.
import { EvidenceFileError } from '../src/services/storage/evidence-storage';
import { extractFromText } from '@domain/extraction/deterministic';
import { hashText } from '@domain/hashing';
import type { Repository } from '../src/data/repository';
import type { Evidence, ProcessingJob, Workspace } from '../src/domain/models';
import { claim, testCase, workspace } from './helpers';

const FILE_TEXT = 'Payment confirmed\nPaid INR 40,000.00 on 26/03/2024\nUTR: 40382881';
const encoder = new TextEncoder();

beforeEach(() => {
  mocks.user.currentUser = { uid: 'user_test' };
  mocks.readStored.mockReset();
  mocks.readStored.mockResolvedValue({ uri: 'file:///stored-original', release: () => {} });
  // Cleared, not reset: these two keep the implementations the mock factory installed, and
  // only their call counts start each test at zero.
  mocks.readBytes.mockClear();
  mocks.sha256File.mockClear();
  mocks.storedBytes = encoder.encode(FILE_TEXT);
});

/** A repository that serves one workspace in memory and records every commit. */
function fakeRepository(load: () => Workspace) {
  const commit = vi.fn(async () => {}) as unknown as Mock;
  const repository = {
    kind: 'local' as const,
    loadWorkspace: vi.fn(async () => load()),
    listCases: vi.fn(async () => []),
    loadAllWorkspace: vi.fn(async () => load()),
    commit,
  } as unknown as Repository;
  return { repository, commit };
}

/** The records a run committed into one collection. */
function committed<T>(commit: Mock, collection: string): T[] {
  return commit.mock.calls.flatMap(
    (call) =>
      (call[1] as readonly { op: string; collection: string; record: unknown }[])
        .filter((change) => change.op === 'put' && change.collection === collection)
        .map((change) => change.record as T),
  );
}

/** A file record as the upload flow leaves it: stored, hashed, not yet read. */
function fileEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'evd_file',
    caseId: 'case_test',
    ownerId: 'user_test',
    title: 'Payment note file',
    kind: 'TEXT',
    state: 'QUEUED',
    note: '',
    fileName: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: FILE_TEXT.length,
    storagePath: 'users/user_test/cases/case_test/evd_file/original.txt',
    sha256: hashText(FILE_TEXT),
    extraction: null,
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    deletedAt: null,
    ...overrides,
  };
}

describe('requestEvidenceProcessing — files are read on this device', () => {
  it('reads a stored original, extracts it, and records an honest job', async () => {
    const base = workspace({ evidence: [fileEvidence()] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('EXTRACTED');
    expect(receipt.failureReason).toBeNull();
    expect(receipt.jobId).toMatch(/^job_/);

    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.state).toBe('EXTRACTED');
    expect(record?.failureReason).toBeNull();
    // The stored-file fields are exactly what the storage layer recorded.
    expect(record?.sha256).toBe(hashText(FILE_TEXT));
    expect(record?.sizeBytes).toBe(FILE_TEXT.length);
    expect(record?.storagePath).toBe('users/user_test/cases/case_test/evd_file/original.txt');
    // Real text was extracted, with the values the extractor finds in it.
    expect(record?.extraction?.segments.length).toBeGreaterThan(0);
    expect(record?.extraction?.amounts[0]?.minorUnits).toBe(4_000_000);
    expect(record?.extraction?.dates[0]?.method).toBe('DETERMINISTIC');
    expect(record?.extraction?.transactionIds[0]?.normalized).toBe('40382881');
    // The ingestion note travels with the extraction, as the account of how the text
    // was obtained.
    expect(record?.extraction?.limitations).toContain('Read this file as plain text.');

    const [job] = committed<ProcessingJob>(commit, 'processingJobs');
    expect(job?.state).toBe('EXTRACTED');
    expect(job?.evidenceId).toBe('evd_file');
    expect(job?.lastError).toBeNull();
    expect(job?.completedSteps).toEqual(['read', 'extract']);
  });

  it('refuses to analyse bytes that no longer match the recorded digest', async () => {
    const base = workspace({ evidence: [fileEvidence({ sha256: 'a'.repeat(64) })] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('FAILED');
    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.state).toBe('FAILED');
    expect(record?.failureReason).toMatch(/fingerprint/);
    expect(record?.extraction).toBeNull();
    const [job] = committed<ProcessingJob>(commit, 'processingJobs');
    expect(job?.state).toBe('FAILED');
  });

  it('fails honestly when the original was never stored', async () => {
    const base = workspace({ evidence: [fileEvidence({ kind: 'IMAGE', storagePath: null, sha256: null, fileName: 'photo.jpg' })] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('FAILED');
    expect(receipt.failureReason).toMatch(/never stored/);
    const [job] = committed<ProcessingJob>(commit, 'processingJobs');
    expect(job?.state).toBe('FAILED');
  });

  it("fails with the store's own sentence when the original is missing from this device", async () => {
    // Tagged, because that is what the store actually throws and what the processing path
    // requires before it will repeat a message to the user. An untagged `Error` here would
    // pass the assertion only if the client trusted arbitrary messages — which is exactly
    // the behaviour that was removed, so a plain `Error` must take the generic sentence.
    mocks.readStored.mockRejectedValueOnce(
      new EvidenceFileError('The original file is no longer on this device. Add it to the case again.'),
    );
    const base = workspace({ evidence: [fileEvidence()] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('FAILED');
    expect(receipt.failureReason).toBe('The original file is no longer on this device. Add it to the case again.');
    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.failureReason).toBe('The original file is no longer on this device. Add it to the case again.');
  });

  it('flags an unreadable file for review with the ingestion note, never inventing text', async () => {
    const docxBytes = encoder.encode('PK\u0003\u0004 not really a zip, but the branch does not parse it');
    mocks.storedBytes = docxBytes;
    const base = workspace({ evidence: [fileEvidence({
      kind: 'DOCUMENT', fileName: 'contract.docx', sha256: hashText('PK\u0003\u0004 not really a zip, but the branch does not parse it'),
    })] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('REVIEW_REQUIRED');
    const [record] = committed<Evidence>(commit, 'evidence');
    // The bytes are kept, hashed and stored — what is missing is a reading, and the
    // reason says so rather than blaming the user.
    expect(record?.state).toBe('REVIEW_REQUIRED');
    expect(record?.storagePath).toBeTruthy();
    expect(record?.extraction).toBeNull();
    // The reason names what happened and what is still true of the file. It must not
    // expose how the format works — a reader has no reason to know a DOCX is an archive.
    expect(record?.failureReason).toMatch(/could not be opened/);
    expect(record?.failureReason).toMatch(/stored unchanged/);
    expect(record?.failureReason).not.toMatch(/archive|zip|parse/i);
    const [job] = committed<ProcessingJob>(commit, 'processingJobs');
    expect(job?.state).toBe('REVIEW_REQUIRED');
    expect(job?.lastError).toMatch(/could not be opened/);
  });

  it('degrades a recording without a Groq key to review, and says why', async () => {
    // No key exists in the Node test environment (there is no secure store), which is
    // exactly the fresh-install state the message is written for.
    const audioBytes = encoder.encode('fake mp3 frame data');
    mocks.storedBytes = audioBytes;
    const base = workspace({ evidence: [fileEvidence({
      kind: 'AUDIO', fileName: 'call.mp3', mimeType: 'audio/mpeg', sha256: hashText('fake mp3 frame data'),
    })] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('REVIEW_REQUIRED');
    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.extraction).toBeNull();
    expect(record?.failureReason).toMatch(/No Groq key is set up yet/);
  });

  it('hashes a recording without ever reading it into memory', async () => {
    // The memory bound this app ships or dies on. Audio and video go to the transcriber and
    // the frame sampler as a URI — their bytes are never decoded in JavaScript — so reading
    // one here served no purpose beyond the size and the digest. A 200 MB video put the whole
    // file on the heap of a handset whose per-process limit is often 192 MB and hashed it in
    // one synchronous call, which is an out-of-memory kill on the large files this product
    // exists to accept.
    mocks.storedBytes = encoder.encode('fake mp3 frame data');
    const base = workspace({ evidence: [fileEvidence({
      kind: 'AUDIO', fileName: 'call.mp3', mimeType: 'audio/mpeg', sha256: hashText('fake mp3 frame data'),
    })] });
    const { repository } = fakeRepository(() => base);

    await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    // The whole assertion: the recording was measured and streamed, never buffered.
    expect(mocks.readBytes).not.toHaveBeenCalled();
    expect(mocks.sha256File).toHaveBeenCalled();
  });

  it('still reads a document into memory, because its bytes have to be decoded', async () => {
    // The other half of the branch, so the fix above cannot be "never read anything". A text
    // file has no meaning until its bytes are decoded, so this path must still buffer.
    const base = workspace({ evidence: [fileEvidence()] });
    const { repository } = fakeRepository(() => base);

    await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(mocks.readBytes).toHaveBeenCalled();
    expect(mocks.sha256File).not.toHaveBeenCalled();
  });

  it('keeps human corrections and the confirmed state through a reprocess', async () => {
    const item = fileEvidence({
      state: 'CONFIRMED',
      confirmedFields: { documentType: 'Receipt' },
      confirmedAt: 900,
      extraction: extractFromText({ evidenceId: 'evd_file', title: 'Payment note file', text: 'older contents', method: 'DETERMINISTIC' }),
    });
    const base = workspace({ evidence: [item] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('CONFIRMED');
    const [record] = committed<Evidence>(commit, 'evidence');
    // The machine extraction was genuinely refreshed…
    expect(record?.extraction?.sourceText).toContain('40,000.00');
    // …while the person's corrections survived over the top of it.
    expect(record?.confirmedFields).toEqual({ documentType: 'Receipt' });
    expect(record?.confirmedAt).toBe(900);
  });

  it('replaces a stale extraction on reprocess rather than leaving it alone', async () => {
    const item = fileEvidence({
      extraction: extractFromText({ evidenceId: 'evd_file', title: 'Payment note file', text: 'old text with nothing in it', method: 'DETERMINISTIC' }),
    });
    const base = workspace({ evidence: [item] });
    const { repository, commit } = fakeRepository(() => base);

    await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.extraction?.sourceText).toContain('40,000.00');
  });
});

describe('requestEvidenceProcessing — statements', () => {
  it('extracts a typed note from its own text', async () => {
    const note = fileEvidence({
      kind: 'NOTE', note: 'Paid INR 40,000.00 on 26/03/2024', fileName: null, mimeType: null,
      storagePath: null, sha256: null, sizeBytes: null,
    });
    const base = workspace({ evidence: [note] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('EXTRACTED');
    const [record] = committed<Evidence>(commit, 'evidence');
    expect(record?.extraction?.amounts[0]?.minorUnits).toBe(4_000_000);
  });

  it('reports an empty statement for review rather than failing', async () => {
    const note = fileEvidence({ kind: 'NOTE', note: '', fileName: null, mimeType: null, storagePath: null, sha256: null, sizeBytes: null });
    const base = workspace({ evidence: [note] });
    const { repository, commit } = fakeRepository(() => base);

    const receipt = await requestEvidenceProcessing('case_test', 'evd_file', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('REVIEW_REQUIRED');
    expect(receipt.failureReason).toMatch(/no text to read/);
  });

  it('rejects an evidence id that is not in the case', async () => {
    const { repository } = fakeRepository(() => workspace());
    await expect(
      requestEvidenceProcessing('case_test', 'evd_missing', { repository, ownerId: 'user_test' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('requestCaseAnalysis — direct, on the device', () => {
  function caseWithClaim() {
    return workspace({
      claims: [claim('Defendant threatened me after receiving payment', { id: 'clm_1' })],
      evidence: [fileEvidence({ kind: 'NOTE', note: 'Sender: I will destroy your reputation if you do not comply.\nRecipient: I already sent ₹50,000 via IMPS on 2026-05-10.', fileName: null, mimeType: null, storagePath: null, sha256: null, sizeBytes: null, title: 'Chat export note' })],
    });
  }

  it('writes the report and a terminal job record, and returns their receipt', async () => {
    const { repository, commit } = fakeRepository(() => caseWithClaim());

    const receipt = await requestCaseAnalysis('case_test', { repository, ownerId: 'user_test' });

    expect(receipt.state).toBe('ANALYZED');
    expect(receipt.jobId).toMatch(/^job_/);
    expect(receipt.failureReason).toBeNull();

    const jobs = committed<ProcessingJob>(commit, 'processingJobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('ANALYZED');
    expect(jobs[0]?.resultPath).toMatch(/^caseAnalyses\//);
    // The report itself was committed by the run.
    expect(committed(commit, 'caseAnalyses')).toHaveLength(1);
  });

  it('persists a FAILED job when the analysis itself cannot run', async () => {
    // A case with neither a claim nor a source has no input at all; the failure is
    // recorded, not just thrown.
    const { repository, commit } = fakeRepository(() => workspace());

    await expect(requestCaseAnalysis('case_test', { repository, ownerId: 'user_test' }))
      .rejects.toMatchObject({ code: 'failed-precondition' });

    const jobs = committed<ProcessingJob>(commit, 'processingJobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('FAILED');
    expect(jobs[0]?.lastError).toBeTruthy();
  });

  it('rejects an unsigned caller who provided no context to resolve', async () => {
    mocks.user.currentUser = null;
    await expect(requestCaseAnalysis('case_test')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(requestEvidenceProcessing('case_test', 'evd_file')).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects path injection before anything runs', async () => {
    await expect(requestCaseAnalysis('../case_test')).rejects.toBeDefined();
    await expect(requestEvidenceProcessing('../case_test', 'evd_file')).rejects.toBeDefined();
    await expect(requestEvidenceProcessing('case_test', '../evd_file')).rejects.toBeDefined();
  });
});

describe('processingError', () => {
  it('does not echo provider body or secrets from errors', () => {
    const error = processingError({ code: 'functions/internal', message: 'gsk_SECRET_evidence_text' });
    expect(error.message).not.toContain('gsk_');
    expect(error.message).not.toContain('evidence_text');
  });
});

describe('runDirectCaseAnalysis — what the assessment can see', () => {
  it('counts an extracted file as a read source, and names an unread one as excluded', async () => {
    const base = workspace({
      claims: [claim('The balance was paid', { id: 'clm_1' })],
      evidence: [
        // A file the pipeline finished with: stored, hashed, extracted.
        fileEvidence({
          id: 'evd_done',
          extraction: extractFromText({ evidenceId: 'evd_done', title: 'Payment note file', text: FILE_TEXT, method: 'OCR' }),
        }),
        // A file whose processing never produced text: stored, but nothing to compare.
        fileEvidence({ id: 'evd_pending', title: 'Pending scan', fileName: 'scan.pdf', kind: 'PDF', extraction: null }),
      ],
    });
    const { repository } = fakeRepository(() => base);

    const report = await runDirectCaseAnalysis(repository, 'user_test', 'case_test');

    expect(report.coverage.totalEvidence).toBe(2);
    expect(report.coverage.processedEvidence).toBe(1);
    expect(report.coverage.excludedEvidenceIds).toEqual(['evd_pending']);
    // The exclusion is stated in the report, in the terms of what is missing.
    expect(report.limitations.join('\n')).toMatch(/left out of this analysis/);
    expect(report.limitations.join('\n')).toMatch(/no readable text/);
    // The extracted file's values reached the assessment: the claim asserts nothing the
    // document contradicts, but the document is what "1 of 2" is counting.
    expect(report.summary).toContain('1 of 2');
  });

  it('extracts unanalyzed notes, evaluates deterministic dispute rules and persists report', async () => {
    const caseId = 'case_test';
    const ownerId = 'user_test';
    const caseRecord = testCase({
      id: caseId,
      ownerId,
      title: 'Harassment & Contract Breach',
      description: 'Threatening messages and contradictory payment claims.',
      incidentDate: '2026-05-10',
      participants: [{ id: 'p1', name: 'Counterparty', role: 'Defendant' }],
      category: 'Harassment & Defamation',
    });
    const testClaim = claim('Defendant threatened me after receiving payment', {
      id: 'clm_1',
      caseId,
      ownerId,
      detail: 'Messages corroborate aggressive confrontation',
    });
    const evidence1 = fileEvidence({
      id: 'evd_1',
      kind: 'NOTE',
      title: 'Chat export note',
      note: 'Sender: I will destroy your reputation if you do not comply.\nRecipient: I already sent ₹50,000 via IMPS on 2026-05-10.',
      fileName: null,
      mimeType: null,
      storagePath: null,
      sha256: null,
      sizeBytes: null,
    });

    const currentWorkspace: Workspace = workspace({
      cases: [caseRecord],
      claims: [testClaim],
      evidence: [evidence1],
    });

    const { repository, commit } = fakeRepository(() => currentWorkspace);

    const report = await runDirectCaseAnalysis(repository, ownerId, caseId);
    expect(report).toBeDefined();
    expect(report.caseId).toBe(caseId);
    expect(report.claims.length).toBe(1);
    expect(report.coverage.totalEvidence).toBe(1);
    expect(commit).toHaveBeenCalled();
  });

  it('analyses a case that has sources but no claim yet', async () => {
    // The ordinary path through the app: make a case, add documents, never write a claim.
    // This threw `failed-precondition` until the claim requirement was removed, which
    // meant uploading evidence produced nothing at all — the rules below are properties
    // of the documents themselves and never needed a claim to run.
    const base = workspace({
      claims: [],
      evidence: [
        fileEvidence({
          id: 'evd_receipt',
          title: 'Payment receipt',
          extraction: extractFromText({ evidenceId: 'evd_receipt', title: 'Payment receipt', text: FILE_TEXT, method: 'OCR' }),
        }),
      ],
    });
    const { repository, commit } = fakeRepository(() => base);

    const report = await runDirectCaseAnalysis(repository, 'user_test', 'case_test');

    expect(report.claims).toEqual([]);
    expect(report.coverage.totalEvidence).toBe(1);
    expect(report.coverage.processedEvidence).toBe(1);
    // The summary has to read as a sentence when the case holds no claims, not as
    // "Checked 0 claims … 0 claims have nothing that speaks to them".
    expect(report.summary).not.toContain('0 claim');
    expect(report.summary).toContain('1 of 1 source');
    // And it was persisted, which is what the upload screen now depends on.
    expect(committed(commit, 'caseAnalyses')).toHaveLength(1);
  });

  it('refuses only when there is neither a claim nor a source to read', async () => {
    const { repository } = fakeRepository(() => workspace({ claims: [], evidence: [] }));
    await expect(runDirectCaseAnalysis(repository, 'user_test', 'case_test'))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });
});