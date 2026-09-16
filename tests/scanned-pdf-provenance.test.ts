import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A scanned PDF, read end to end, and the provenance its values carry afterwards.
 *
 * ## Why this file exists
 *
 * `src/services/ingestion/pdf-images.ts` made a whole class of document readable that used
 * to end at "someone needs to type this in": the scan with no text layer, which is what a
 * bank grievance cell emails back and what every phone's "scan to PDF" button produces.
 * The text it yields is a machine's reading of pixels, exactly like a photograph's.
 *
 * The danger is entirely in the label. `requestEvidenceProcessing` maps the ingestion
 * `method` onto an `ExtractedTextMethod`, and an earlier shape of that function ended in
 * `return 'DETERMINISTIC'` for anything it did not recognise. A new ingestion method
 * therefore defaulted to *the document's own characters* — the highest trust the product
 * has. Under that label the quarantine in `@domain/rules/provenance` never fires, and a
 * `₹1,500` misread as `₹7,500` becomes a confident, fabricated accusation of overcharging.
 * That is the single worst failure this product can have, it requires no bug anywhere else,
 * and nothing in the type system or the other suites would have caught it: the union member
 * was added in one file and silently changed meaning in another.
 *
 * So these tests assert the label, not the reading. `tests/pdf-images.test.ts` already pins
 * what comes out of the container and `tests/provenance.test.ts` pins what the quarantine
 * does with an unconfirmed value; this is the joint between them.
 */

const mocks = vi.hoisted(() => ({
  storedBytes: new Uint8Array(),
  /** Text ML Kit "reads" off each page image, in the order the pages are handed to it. */
  pageReadings: [] as string[][],
  /** Every page image actually written to the cache, so the test can inspect what was read. */
  written: [] as { name: string; bytes: Uint8Array }[],
  /** Names deleted afterwards. A page image left in the cache is a leak of document content. */
  deleted: [] as string[],
}));

vi.mock('../src/services/storage/evidence-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/storage/evidence-storage')>()),
  readStoredEvidenceFile: async () => ({ uri: 'file:///stored-original', release: () => {} }),
}));

vi.mock('../src/services/ingestion/read-file', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  return {
    readBytes: async () => mocks.storedBytes,
    sha256Hex: (bytes: Uint8Array) => bytesToHex(sha256(bytes)),
    fileSize: async () => mocks.storedBytes.length,
  };
});

/**
 * Stands in for `expo-file-system`, which cannot load in Node.
 *
 * Deliberately a real class with real state rather than a bag of `vi.fn()`s: the code under
 * test constructs it, writes to it and reads `.uri` back off it, and a stub that accepted
 * the write without keeping the bytes would let a regression that hands ML Kit the wrong
 * buffer pass this file.
 */
vi.mock('expo-file-system', () => {
  class File {
    readonly uri: string;
    private readonly name: string;
    constructor(directory: { uri: string }, name: string) {
      this.name = name;
      this.uri = `${directory.uri}${name}`;
    }
    write(bytes: Uint8Array): void {
      mocks.written.push({ name: this.name, bytes });
    }
    delete(): void {
      mocks.deleted.push(this.name);
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache/' } } };
});

vi.mock('../src/services/ingestion/ocr', () => ({
  recogniseText: async (uri: string) => {
    // Keyed on call order, matching the order pages are lifted out of the container. The
    // uri is asserted on rather than parsed, so the mock cannot quietly diverge from it.
    const index = mocks.written.findIndex((file) => uri.endsWith(file.name));
    const lines = mocks.pageReadings[index];
    if (!lines) return { ok: false, reason: 'NO_TEXT', message: 'nothing on this page' };
    return {
      ok: true,
      result: {
        text: lines.join('\n'),
        // `top` ascending: `orderRecognisedLines` sorts on geometry, so flat nulls would
        // exercise a different path from the one a real page takes.
        lines: lines.map((text, at) => ({ text, top: at * 40, left: 0, languages: ['en'] })),
        script: 'Latin' as const,
        otherScriptFoundMore: false,
      },
    };
  },
}));

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { createCase, queueEvidence, recordEvidenceFile, type MutationContext } from '@data/mutations';
import { createMemoryStore } from '@/data/local/key-value-store';
import { LocalRepository } from '@/data/local/local-repository';
import { emptyWorkspace, TEXT_FIELD_KEYS, type Extraction } from '@domain/models';
import { unconfirmedReadsOf } from '@domain/rules/provenance';
import { requestEvidenceProcessing } from '../src/services/ai/case-analysis';

const OWNER = 'user_scan';
const NOW = 1_700_000_000_000;
const context = (): MutationContext => ({ ownerId: OWNER, now: NOW });
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

const encoder = new TextEncoder();

// `Uint8Array<ArrayBuffer>`, not bare `Uint8Array`: the latter means `ArrayBufferLike`, which
// includes `SharedArrayBuffer` and so will not assign to the hoisted buffer above. Both of
// these allocate a plain `ArrayBuffer`, so the narrower type is simply the accurate one.
function concat(...parts: (string | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Opens `FF D8 FF` and closes `FF D9`, as `pdf-images` requires of anything it lifts. */
function fakeJpeg(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(size, 16));
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  for (let at = 3; at < out.length - 2; at += 1) out[at] = (at * 31) % 251;
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

/**
 * A PDF whose pages are JPEGs and which contains no text operators anywhere — the shape a
 * flatbed scanner and a phone camera app both emit.
 */
function scannedPdf(pageCount: number): Uint8Array<ArrayBuffer> {
  const parts: (string | Uint8Array)[] = ['%PDF-1.4\n'];
  for (let page = 0; page < pageCount; page += 1) {
    const data = fakeJpeg(30_000 + page * 1000);
    parts.push(
      `${page + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 ` +
        `/Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
      data,
      '\nendstream\nendobj\n',
    );
  }
  parts.push('trailer\n<< /Size 1 >>\n%%EOF\n');
  return concat(...parts);
}

/** Every `method` recorded on every field of an extraction, across all field families. */
function methodsIn(extraction: Extraction): string[] {
  const methods = [
    ...extraction.dates.map((field) => field.method),
    ...extraction.amounts.map((field) => field.method),
  ];
  for (const key of TEXT_FIELD_KEYS) methods.push(...extraction[key].map((field) => field.method));
  return methods;
}

/** A case with one stored file, taken through intake → stored-original, ready to process. */
async function caseWithStoredFile(fileName: string, mimeType: string) {
  const repository = new LocalRepository(createMemoryStore());
  const created = createCase(emptyWorkspace(), context(), { title: 'Scanned statement' });
  await repository.commit(OWNER, created.changes);
  const caseId = created.workspace.cases[0]!.id;

  const queued = queueEvidence(created.workspace, context(), caseId, {
    id: 'evd_scan', title: 'Bank reply', kind: 'PDF', fileName, mimeType, sizeBytes: null,
  });
  await repository.commit(OWNER, queued.changes);

  const recorded = recordEvidenceFile(queued.workspace, context(), 'evd_scan', {
    storagePath: `users/${OWNER}/cases/${caseId}/evd_scan/original${fileName.slice(fileName.lastIndexOf('.'))}`,
    sizeBytes: mocks.storedBytes.length,
    sha256: digest(mocks.storedBytes),
  });
  await repository.commit(OWNER, recorded.changes);

  return { repository, caseId };
}

async function processed(fileName: string, mimeType: string) {
  const { repository, caseId } = await caseWithStoredFile(fileName, mimeType);
  const receipt = await requestEvidenceProcessing(caseId, 'evd_scan', { repository, ownerId: OWNER });
  const after = await repository.loadWorkspace(OWNER, caseId);
  return { receipt, item: after.evidence.find((record) => record.id === 'evd_scan')! };
}

beforeEach(() => {
  mocks.written = [];
  mocks.deleted = [];
  mocks.pageReadings = [
    [
      'STATE BANK GRIEVANCE CELL',
      'Complaint reference: SBI/GRV/88421',
      'Amount debited: INR 12,450.00 on 04/02/2024',
    ],
    ['UTR: 553320119087', 'Status: closed'],
  ];
  mocks.storedBytes = scannedPdf(2);
});

describe('a scanned PDF taken through the real processing path', () => {
  it('reads its pages and records what was read', async () => {
    const { receipt, item } = await processed('grievance-reply.pdf', 'application/pdf');

    expect(receipt.state).toBe('EXTRACTED');
    expect(item.state).toBe('EXTRACTED');
    // The reading reached the extractor as text, not as a note about being unreadable.
    expect(item.extraction?.amounts[0]?.minorUnits).toBe(1_245_000);
    expect(item.extraction?.transactionIds.map((field) => field.normalized)).toContain('553320119087');
    // Both pages, so the second page's values are not lost behind the first.
    expect(mocks.written).toHaveLength(2);
  });

  it('hands the recogniser decodable JPEGs, then leaves nothing in the cache', async () => {
    await processed('grievance-reply.pdf', 'application/pdf');

    for (const file of mocks.written) {
      expect(file.name.endsWith('.jpg')).toBe(true);
      expect([...file.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect([...file.bytes.slice(-2)]).toEqual([0xff, 0xd9]);
    }
    // A page image is a picture of someone's bank statement. Every one written must go.
    expect(mocks.deleted).toEqual(mocks.written.map((file) => file.name));
  });

  it('files every value it read as OCR, never as the document’s own characters', async () => {
    const { item } = await processed('grievance-reply.pdf', 'application/pdf');
    const extraction = item.extraction!;

    // The assertion this file exists for. Not "the amount is OCR" but "nothing here is
    // anything else": a future field family added to the extractor inherits the guarantee.
    const methods = methodsIn(extraction);
    expect(methods.length).toBeGreaterThan(0);
    expect([...new Set(methods)]).toEqual(['OCR']);
  });

  it('leaves those values quarantine-eligible, so no scan can raise a confident conflict', async () => {
    const { item } = await processed('grievance-reply.pdf', 'application/pdf');

    // What `@domain/rules/provenance` consumes. Non-empty here is precisely the difference
    // between a contradiction being posed as a question and being asserted as a fact.
    const reads = unconfirmedReadsOf('evd_scan', item.extraction);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((read) => read.label)).toContain('Amount');
    expect(reads.find((read) => read.label === 'Amount')?.reading).toContain('12,450');
  });

  it('carries the reading’s own caveat into the record it writes', async () => {
    const { item } = await processed('grievance-reply.pdf', 'application/pdf');

    const limitations = item.extraction!.limitations.join(' ');
    expect(limitations).toContain('read as pictures on this device');
    // The product's language rule: a reading of a scan is never described as the document.
    expect(limitations).not.toMatch(/\b(proves|verified|confirmed|authentic)\b/i);
  });
});

describe('the same path for text that was never a picture', () => {
  it('files a plain text file as DETERMINISTIC and quarantines nothing', async () => {
    mocks.storedBytes = concat(
      'PAYMENT CONFIRMATION\nAmount debited: INR 12,450.00 on 04/02/2024\nUTR: 553320119087',
    );

    const { item } = await processed('confirmation.txt', 'text/plain');
    const extraction = item.extraction!;

    expect(extraction.amounts[0]?.minorUnits).toBe(1_245_000);
    // Identical values to the scanned case above, and the opposite provenance — which is
    // the whole point: the label tracks how the text was obtained, not what it says.
    expect([...new Set(methodsIn(extraction))]).toEqual(['DETERMINISTIC']);
    expect(unconfirmedReadsOf('evd_scan', extraction)).toEqual([]);
    expect(mocks.written).toEqual([]);
  });
});

describe('a scanned PDF this build cannot read', () => {
  it('stops at review-required rather than recording an empty reading', async () => {
    // ML Kit not linked: every page would answer the same, so the path gives up and the
    // record says a person needs to look — it does not invent an extraction from nothing.
    mocks.pageReadings = [];

    const { receipt, item } = await processed('grievance-reply.pdf', 'application/pdf');

    expect(receipt.state).toBe('REVIEW_REQUIRED');
    expect(item.extraction).toBeNull();
    expect(item.failureReason).toBeTruthy();
    // Still cleaned up after itself on the way out.
    expect(mocks.deleted).toEqual(mocks.written.map((file) => file.name));
  });
});
