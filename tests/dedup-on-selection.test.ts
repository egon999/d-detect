import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Evidence } from '../src/domain/models';
import type { PickedFile } from '../src/services/ingestion/types';
import {
  checkDuplicateBeforeUpload,
  checkBatchDuplicatesBeforeUpload,
  computeFileSha256,
} from '../src/services/ingestion/dedup';

function mockEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const now = Date.now();
  return {
    id: 'evd_test_1',
    ownerId: 'user_1',
    caseId: 'case_1',
    createdAt: now,
    updatedAt: now,
    title: 'Test Evidence',
    kind: 'PDF',
    state: 'EXTRACTED',
    note: '',
    fileName: 'document.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    storagePath: 'users/user_1/cases/case_1/evd_test_1/original.pdf',
    sha256: 'a'.repeat(64),
    cloudStatus: 'LOCAL_ONLY',
    extraction: null,
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('Immediate Pre-Upload Deduplication Pipeline (checkDuplicateBeforeUpload)', () => {
  describe('Instant duplicate detection for identical bytes', () => {
    it('detects a duplicate when a picked file has identical content to existing evidence', async () => {
      const content = new TextEncoder().encode('Confidential contract agreement between Party A and Party B');
      const expectedHash = bytesToHex(sha256(content));
      const base64Content = Buffer.from(content).toString('base64');

      const pickedFile: PickedFile = {
        uri: `data:application/pdf;base64,${base64Content}`,
        name: 'contract_signed.pdf',
        mimeType: 'application/pdf',
        size: content.length,
      };

      const existing = mockEvidence({
        id: 'evd_existing_contract',
        title: 'Original Signed Contract',
        sha256: expectedHash,
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [existing]);

      expect(result.isDuplicate).toBe(true);
      expect(result.matchedEvidence).toBeDefined();
      expect(result.matchedEvidence?.id).toBe('evd_existing_contract');
      expect(result.matchedEvidence?.title).toBe('Original Signed Contract');
      expect(result.sha256).toBe(expectedHash);
    });

    it('detects duplicates based on content hash regardless of filename or extension', async () => {
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
      const expectedHash = bytesToHex(sha256(imageBytes));
      const base64 = Buffer.from(imageBytes).toString('base64');

      const pickedFile: PickedFile = {
        uri: `data:image/jpeg;base64,${base64}`,
        name: 'renamed_receipt.jpeg', // Different name and extension
        mimeType: 'image/jpeg',
        size: imageBytes.length,
      };

      const existingEvidence = mockEvidence({
        id: 'evd_photo_png',
        title: 'Payment Receipt Photo',
        fileName: 'original_scan.png',
        mimeType: 'image/png',
        sha256: expectedHash,
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [existingEvidence]);

      expect(result.isDuplicate).toBe(true);
      expect(result.matchedEvidence?.id).toBe('evd_photo_png');
      expect(result.sha256).toBe(expectedHash);
    });

    it('matches case-insensitively on hex hash values', async () => {
      const content = new TextEncoder().encode('Invoice #INV-2024-009');
      const hash = bytesToHex(sha256(content));

      const pickedFile: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
        name: 'invoice.txt',
        mimeType: 'text/plain',
        size: content.length,
      };

      const existing = mockEvidence({
        id: 'evd_inv',
        title: 'Invoice 2024',
        sha256: hash.toUpperCase(), // Uppercase in stored database
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [existing]);

      expect(result.isDuplicate).toBe(true);
      expect(result.matchedEvidence?.id).toBe('evd_inv');
      expect(result.sha256).toBe(hash.toLowerCase());
    });
  });

  describe('Non-duplicate verification for distinct files', () => {
    it('returns isDuplicate=false when file content differs from all existing evidence', async () => {
      const fileBytes = new TextEncoder().encode('Brand new unique statement for case');
      const expectedHash = bytesToHex(sha256(fileBytes));

      const pickedFile: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(fileBytes).toString('base64')}`,
        name: 'new_statement.txt',
        mimeType: 'text/plain',
        size: fileBytes.length,
      };

      const existingEvidence = [
        mockEvidence({ id: 'evd_1', title: 'Doc 1', sha256: '1'.repeat(64) }),
        mockEvidence({ id: 'evd_2', title: 'Doc 2', sha256: '2'.repeat(64) }),
      ];

      const result = await checkDuplicateBeforeUpload(pickedFile, existingEvidence);

      expect(result.isDuplicate).toBe(false);
      expect(result.matchedEvidence).toBeUndefined();
      expect(result.sha256).toBe(expectedHash);
    });

    it('ignores deleted evidence records during duplicate matching', async () => {
      const content = new TextEncoder().encode('Deleted evidence bytes');
      const hash = bytesToHex(sha256(content));

      const pickedFile: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
        name: 'reuploaded.txt',
        mimeType: 'text/plain',
        size: content.length,
      };

      const softDeletedEvidence = mockEvidence({
        id: 'evd_deleted',
        title: 'Old Deleted File',
        sha256: hash,
        deletedAt: Date.now(),
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [softDeletedEvidence]);

      expect(result.isDuplicate).toBe(false);
      expect(result.matchedEvidence).toBeUndefined();
      expect(result.sha256).toBe(hash);
    });

    it('ignores existing evidence records that have no hash (null sha256)', async () => {
      const content = new TextEncoder().encode('Some new file bytes');
      const hash = bytesToHex(sha256(content));

      const pickedFile: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
        name: 'file.txt',
        mimeType: 'text/plain',
        size: content.length,
      };

      const hashlessEvidence = mockEvidence({
        id: 'evd_null_hash',
        title: 'Legacy Untracked File',
        sha256: null,
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [hashlessEvidence]);

      expect(result.isDuplicate).toBe(false);
      expect(result.sha256).toBe(hash);
    });
  });

  describe('Handling of empty files', () => {
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    it('correctly hashes an empty 0-byte file to standard empty SHA-256', async () => {
      const pickedFile: PickedFile = {
        uri: 'data:application/octet-stream;base64,',
        name: 'empty.dat',
        mimeType: 'application/octet-stream',
        size: 0,
      };

      const result = await checkDuplicateBeforeUpload(pickedFile, []);

      expect(result.isDuplicate).toBe(false);
      expect(result.sha256).toBe(EMPTY_SHA256);
    });

    it('identifies duplicate empty files when an empty evidence item already exists', async () => {
      const pickedFile: PickedFile = {
        uri: 'data:text/plain;base64,',
        name: 'another_empty.txt',
        mimeType: 'text/plain',
        size: 0,
      };

      const existingEmpty = mockEvidence({
        id: 'evd_empty',
        title: 'Existing Blank File',
        sha256: EMPTY_SHA256,
      });

      const result = await checkDuplicateBeforeUpload(pickedFile, [existingEmpty]);

      expect(result.isDuplicate).toBe(true);
      expect(result.matchedEvidence?.id).toBe('evd_empty');
      expect(result.sha256).toBe(EMPTY_SHA256);
    });

    it('handles empty files on disk via filesystem path', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detact-test-'));
      const emptyFilePath = path.join(tempDir, 'disk_empty.txt');
      fs.writeFileSync(emptyFilePath, Buffer.alloc(0));

      try {
        const pickedFile: PickedFile = {
          uri: `file://${emptyFilePath}`,
          name: 'disk_empty.txt',
          mimeType: 'text/plain',
          size: 0,
        };

        const result = await checkDuplicateBeforeUpload(pickedFile, []);
        expect(result.isDuplicate).toBe(false);
        expect(result.sha256).toBe(EMPTY_SHA256);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Handling of large files and disk streaming', () => {
    it('accurately streams and hashes large files on disk exceeding chunk boundaries', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detact-large-test-'));
      const largeFilePath = path.join(tempDir, 'large_sample.bin');

      // Create a 3 MB file filled with patterned data
      const chunkSize = 64 * 1024;
      const totalChunks = 48; // 48 * 64KB = 3 MB
      const stream = fs.createWriteStream(largeFilePath);

      const chunk = Buffer.alloc(chunkSize);
      for (let i = 0; i < chunkSize; i++) chunk[i] = (i * 31) % 256;

      for (let i = 0; i < totalChunks; i++) {
        stream.write(chunk);
      }
      await new Promise<void>((resolve) => stream.end(resolve));

      // Calculate expected hash directly from noble sha256
      const expectedHasher = sha256.create();
      for (let i = 0; i < totalChunks; i++) {
        expectedHasher.update(new Uint8Array(chunk));
      }
      const expectedHash = bytesToHex(expectedHasher.digest());

      try {
        const pickedFile: PickedFile = {
          uri: `file://${largeFilePath}`,
          name: 'large_sample.bin',
          mimeType: 'application/octet-stream',
          size: totalChunks * chunkSize,
        };

        const hash = await computeFileSha256(pickedFile);
        expect(hash).toBe(expectedHash);

        const existingMatch = mockEvidence({
          id: 'evd_large',
          title: 'Existing Large Video/Binary',
          sha256: expectedHash,
        });

        const check = await checkDuplicateBeforeUpload(pickedFile, [existingMatch]);
        expect(check.isDuplicate).toBe(true);
        expect(check.matchedEvidence?.id).toBe('evd_large');
        expect(check.sha256).toBe(expectedHash);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Batch duplicate checking (checkBatchDuplicatesBeforeUpload)', () => {
    it('detects multiple duplicates within the same selection batch', async () => {
      const bytesA = new TextEncoder().encode('File A content');
      const hashA = bytesToHex(sha256(bytesA));

      const bytesB = new TextEncoder().encode('File B distinct content');
      const hashB = bytesToHex(sha256(bytesB));

      const file1: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(bytesA).toString('base64')}`,
        name: 'report_first.txt',
        mimeType: 'text/plain',
        size: bytesA.length,
      };

      const file2: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(bytesB).toString('base64')}`,
        name: 'invoice_distinct.txt',
        mimeType: 'text/plain',
        size: bytesB.length,
      };

      const file3: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(bytesA).toString('base64')}`,
        name: 'report_copy.txt',
        mimeType: 'text/plain',
        size: bytesA.length,
      };

      const batch = [file1, file2, file3];
      const results = await checkBatchDuplicatesBeforeUpload(batch, []);

      expect(results).toHaveLength(3);

      const r0 = results[0];
      const r1 = results[1];
      const r2 = results[2];
      expect(r0).toBeDefined();
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();

      // file1 is the first occurrence in the batch
      expect(r0?.isDuplicate).toBe(false);
      expect(r0?.sha256).toBe(hashA);

      // file2 is unique
      expect(r1?.isDuplicate).toBe(false);
      expect(r1?.sha256).toBe(hashB);

      // file3 is an exact duplicate of file1 in this batch
      expect(r2?.isDuplicate).toBe(true);
      expect(r2?.scope).toBe('batch');
      expect(r2?.matchedTitle).toBe('report_first.txt');
      expect(r2?.sha256).toBe(hashA);
    });

    it('prioritizes case duplicates over batch duplicates', async () => {
      const content = new TextEncoder().encode('Shared document between case and batch');
      const hash = bytesToHex(sha256(content));

      const existingInCase = mockEvidence({
        id: 'evd_case_original',
        title: 'Case Master Document',
        sha256: hash,
      });

      const file1: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
        name: 'batch_item_1.txt',
        mimeType: 'text/plain',
        size: content.length,
      };

      const file2: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
        name: 'batch_item_2.txt',
        mimeType: 'text/plain',
        size: content.length,
      };

      const results = await checkBatchDuplicatesBeforeUpload([file1, file2], [existingInCase]);

      expect(results).toHaveLength(2);
      const r0 = results[0];
      const r1 = results[1];
      expect(r0).toBeDefined();
      expect(r1).toBeDefined();

      expect(r0?.isDuplicate).toBe(true);
      expect(r0?.scope).toBe('case');
      expect(r0?.matchedTitle).toBe('Case Master Document');

      expect(r1?.isDuplicate).toBe(true);
      expect(r1?.scope).toBe('case');
      expect(r1?.matchedTitle).toBe('Case Master Document');
    });

    it('correctly tracks multiple distinct duplicate pairs in one batch', async () => {
      const pair1Bytes = new TextEncoder().encode('Pair 1 data');
      const pair2Bytes = new TextEncoder().encode('Pair 2 data');

      const f1: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(pair1Bytes).toString('base64')}`,
        name: 'f1.txt',
        mimeType: 'text/plain',
        size: pair1Bytes.length,
      };
      const f2: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(pair2Bytes).toString('base64')}`,
        name: 'f2.txt',
        mimeType: 'text/plain',
        size: pair2Bytes.length,
      };
      const f3: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(pair1Bytes).toString('base64')}`,
        name: 'f1_dup.txt',
        mimeType: 'text/plain',
        size: pair1Bytes.length,
      };
      const f4: PickedFile = {
        uri: `data:text/plain;base64,${Buffer.from(pair2Bytes).toString('base64')}`,
        name: 'f2_dup.txt',
        mimeType: 'text/plain',
        size: pair2Bytes.length,
      };

      const results = await checkBatchDuplicatesBeforeUpload([f1, f2, f3, f4], []);

      expect(results).toHaveLength(4);
      const r0 = results[0];
      const r1 = results[1];
      const r2 = results[2];
      const r3 = results[3];
      expect(r0).toBeDefined();
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r3).toBeDefined();

      expect(r0?.isDuplicate).toBe(false);
      expect(r1?.isDuplicate).toBe(false);

      expect(r2?.isDuplicate).toBe(true);
      expect(r2?.scope).toBe('batch');
      expect(r2?.matchedTitle).toBe('f1.txt');

      expect(r3?.isDuplicate).toBe(true);
      expect(r3?.scope).toBe('batch');
      expect(r3?.matchedTitle).toBe('f2.txt');
    });
  });
});
