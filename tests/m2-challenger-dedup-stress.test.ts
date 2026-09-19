import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils.js';
import type { Evidence } from '../src/domain/models';
import type { PickedFile } from '../src/services/ingestion/types';
import {
  computeFileSha256,
  checkDuplicateBeforeUpload,
  checkBatchDuplicatesBeforeUpload,
} from '../src/services/ingestion/dedup';

const CANONICAL_EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function createMockPickedFile(overrides: Partial<PickedFile> & { uri: string }): PickedFile {
  return {
    name: 'test_file.bin',
    mimeType: 'application/octet-stream',
    size: null,
    ...overrides,
  };
}

function createMockEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const now = Date.now();
  return {
    id: `evd_${Math.random().toString(36).slice(2, 9)}`,
    ownerId: 'user_stress_test',
    caseId: 'case_stress_1',
    createdAt: now,
    updatedAt: now,
    title: 'Baseline Evidence',
    kind: 'PDF',
    state: 'EXTRACTED',
    note: '',
    fileName: 'sample.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    storagePath: 'evidence/sample.pdf',
    sha256: '0'.repeat(64),
    cloudStatus: 'LOCAL_ONLY',
    extraction: null,
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('M2 Challenger 1: Empirical Deduplication Stress Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detact-challenger-dedup-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error on windows file locks
    }
  });

  // =========================================================================
  // 1. Oracle Verification & Cryptographic Equivalence Against Noble & Crypto
  // =========================================================================
  describe('Oracle Verification: Exact SHA-256 Equivalence', () => {
    it('matches Noble sha256 and node:crypto for empty zero-byte input', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const nobleDigest = nobleBytesToHex(nobleSha256(new Uint8Array(0)));
      const cryptoDigest = crypto.createHash('sha256').update(emptyBuffer).digest('hex');

      expect(nobleDigest).toBe(CANONICAL_EMPTY_SHA256);
      expect(cryptoDigest).toBe(CANONICAL_EMPTY_SHA256);

      // Verify data URI
      const dataUriFile = createMockPickedFile({
        uri: 'data:text/plain;base64,',
        name: 'empty.txt',
        mimeType: 'text/plain',
        size: 0,
      });
      const dataUriHash = await computeFileSha256(dataUriFile);
      expect(dataUriHash).toBe(CANONICAL_EMPTY_SHA256);

      // Verify file path
      const diskEmptyPath = path.join(tempDir, 'empty.dat');
      fs.writeFileSync(diskEmptyPath, emptyBuffer);
      const diskFile = createMockPickedFile({
        uri: `file://${diskEmptyPath}`,
        name: 'empty.dat',
        size: 0,
      });
      const diskHash = await computeFileSha256(diskFile);
      expect(diskHash).toBe(CANONICAL_EMPTY_SHA256);
    });

    it('matches Noble and node:crypto across variable buffer sizes (1B, 1KB, 64KB, 2MB)', async () => {
      const testSizes = [1, 1024, 65536, 2 * 1024 * 1024];

      for (const size of testSizes) {
        const payload = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
          payload[i] = (i * 13 + 7) & 0xff;
        }

        const nobleDigest = nobleBytesToHex(nobleSha256(new Uint8Array(payload)));
        const cryptoDigest = crypto.createHash('sha256').update(payload).digest('hex');
        expect(nobleDigest).toBe(cryptoDigest);

        const filePath = path.join(tempDir, `oracle_test_${size}.bin`);
        fs.writeFileSync(filePath, payload);

        const picked = createMockPickedFile({
          uri: `file://${filePath}`,
          name: `oracle_${size}.bin`,
          size,
        });

        const computed = await computeFileSha256(picked);
        expect(computed).toBe(nobleDigest);
        expect(computed).toBe(cryptoDigest);
      }
    });

    it('demonstrates bit-flip avalanche effect and zero collision', async () => {
      const baseSize = 512 * 1024; // 512 KB
      const basePayload = Buffer.alloc(baseSize);
      for (let i = 0; i < baseSize; i++) {
        basePayload[i] = (i * 37) & 0xff;
      }

      const baseHash = nobleBytesToHex(nobleSha256(new Uint8Array(basePayload)));
      const baseEvidence = createMockEvidence({
        id: 'evd_base',
        title: 'Base Payload File',
        sha256: baseHash,
      });

      // Generate 20 bit-flipped variants at distinct offsets
      const bitFlipOffsets = [
        0, 1, 10, 100, 1024, 4096, 65535, 65536, 100000, 200000,
        300000, 400000, 500000, 524287,
      ];

      const seenHashes = new Set<string>();
      seenHashes.add(baseHash);

      for (const offset of bitFlipOffsets) {
        const flipped = Buffer.from(basePayload);
        flipped[offset] = (flipped[offset] ?? 0) ^ 0x01; // flip 1 bit

        const flippedNoble = nobleBytesToHex(nobleSha256(new Uint8Array(flipped)));
        expect(seenHashes.has(flippedNoble)).toBe(false);
        seenHashes.add(flippedNoble);

        const filePath = path.join(tempDir, `flip_${offset}.bin`);
        fs.writeFileSync(filePath, flipped);

        const check = await checkDuplicateBeforeUpload(
          createMockPickedFile({ uri: `file://${filePath}`, name: `flip_${offset}.bin`, size: baseSize }),
          [baseEvidence],
        );

        expect(check.isDuplicate).toBe(false);
        expect(check.matchedEvidence).toBeUndefined();
        expect(check.sha256).toBe(flippedNoble);
      }
    });

    it('differentiates files with identical prefix but different suffix', async () => {
      const prefixSize = 1024 * 1024; // 1MB prefix
      const sharedPrefix = Buffer.alloc(prefixSize, 0xaa);

      const fileA = Buffer.concat([sharedPrefix, Buffer.from('TAIL_A')]);
      const fileB = Buffer.concat([sharedPrefix, Buffer.from('TAIL_B')]);

      const pathA = path.join(tempDir, 'prefix_a.bin');
      const pathB = path.join(tempDir, 'prefix_b.bin');
      fs.writeFileSync(pathA, fileA);
      fs.writeFileSync(pathB, fileB);

      const hashA = await computeFileSha256(
        createMockPickedFile({ uri: `file://${pathA}`, name: 'a.bin', size: fileA.length }),
      );
      const hashB = await computeFileSha256(
        createMockPickedFile({ uri: `file://${pathB}`, name: 'b.bin', size: fileB.length }),
      );

      expect(hashA).not.toBe(hashB);

      const evA = createMockEvidence({ sha256: hashA });
      const checkB = await checkDuplicateBeforeUpload(
        createMockPickedFile({ uri: `file://${pathB}`, name: 'b.bin' }),
        [evA],
      );
      expect(checkB.isDuplicate).toBe(false);
    });

    it('differentiates files with identical suffix but different prefix', async () => {
      const suffixSize = 1024 * 1024; // 1MB suffix
      const sharedSuffix = Buffer.alloc(suffixSize, 0xbb);

      const fileA = Buffer.concat([Buffer.from('HEAD_A'), sharedSuffix]);
      const fileB = Buffer.concat([Buffer.from('HEAD_B'), sharedSuffix]);

      const pathA = path.join(tempDir, 'suffix_a.bin');
      const pathB = path.join(tempDir, 'suffix_b.bin');
      fs.writeFileSync(pathA, fileA);
      fs.writeFileSync(pathB, fileB);

      const hashA = await computeFileSha256(
        createMockPickedFile({ uri: `file://${pathA}`, name: 'a.bin' }),
      );
      const hashB = await computeFileSha256(
        createMockPickedFile({ uri: `file://${pathB}`, name: 'b.bin' }),
      );

      expect(hashA).not.toBe(hashB);
    });
  });

  // =========================================================================
  // 2. High-Volume Batch Deduplication (100+ Files)
  // =========================================================================
  describe('High-Volume Batch Deduplication (100+ Files)', () => {
    it('accurately deduplicates a 150-file batch with mixed case and batch collisions', async () => {
      const totalFiles = 150;
      const batchFiles: PickedFile[] = [];

      // Create 5 existing case evidence files
      const caseEvidenceList: Evidence[] = [];
      const caseHashes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const payload = Buffer.from(`Case Evidence Master Document #${i}`);
        const hash = nobleBytesToHex(nobleSha256(new Uint8Array(payload)));
        caseHashes.push(hash);
        caseEvidenceList.push(
          createMockEvidence({
            id: `evd_case_${i}`,
            title: `Case Evidence Doc ${i}`,
            sha256: hash,
          }),
        );
      }

      // Generate distinct unique contents
      const uniqueContents: Buffer[] = [];
      for (let i = 0; i < 30; i++) {
        uniqueContents.push(Buffer.from(`Unique File Content #${i} - ${Math.random()}`));
      }

      // Generate 5 distinct cluster contents (each cluster will have 10 duplicate copies)
      const clusterContents: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        clusterContents.push(Buffer.from(`Cluster ${i} Shared Content Block - ${i * 999}`));
      }

      // Build 150 files:
      // 0..29: 30 unique files
      // 30..69: 40 case collisions (cycling case 0..4)
      // 70..119: 50 intra-batch duplicates (5 clusters x 10 files)
      // 120..149: 30 cyclic duplicates (cycling case 0..4 again and clusters)
      for (let i = 0; i < totalFiles; i++) {
        let content: Buffer;
        let name: string;

        if (i < 30) {
          // Unique
          content = uniqueContents[i]!;
          name = `unique_${i}.txt`;
        } else if (i < 70) {
          // Case collision
          const caseIdx = (i - 30) % 5;
          content = Buffer.from(`Case Evidence Master Document #${caseIdx}`);
          name = `case_match_${i}_target_${caseIdx}.txt`;
        } else if (i < 120) {
          // Intra-batch duplicate clusters (clusterIdx 0..4, repeat 0..9)
          const clusterIdx = Math.floor((i - 70) / 10);
          const copyIdx = (i - 70) % 10;
          content = clusterContents[clusterIdx]!;
          name = `cluster_${clusterIdx}_copy_${copyIdx}.txt`;
        } else {
          // Cyclic duplicates
          const cyclicCaseIdx = (i - 120) % 5;
          content = Buffer.from(`Case Evidence Master Document #${cyclicCaseIdx}`);
          name = `cyclic_${i}_target_${cyclicCaseIdx}.txt`;
        }

        const filePath = path.join(tempDir, `batch_${i}_${name}`);
        fs.writeFileSync(filePath, content);

        batchFiles.push(
          createMockPickedFile({
            uri: `file://${filePath}`,
            name,
            mimeType: 'text/plain',
            size: content.length,
          }),
        );
      }

      expect(batchFiles.length).toBe(150);

      const startTime = Date.now();
      const results = await checkBatchDuplicatesBeforeUpload(batchFiles, caseEvidenceList);
      const elapsedMs = Date.now() - startTime;

      expect(results).toHaveLength(150);
      expect(elapsedMs).toBeLessThan(10000); // Must be fast

      // Verify unique files (0..29)
      for (let i = 0; i < 30; i++) {
        expect(results[i]?.isDuplicate).toBe(false);
        expect(results[i]?.scope).toBeUndefined();
      }

      // Verify case matches (30..69)
      for (let i = 30; i < 70; i++) {
        const caseIdx = (i - 30) % 5;
        expect(results[i]?.isDuplicate).toBe(true);
        expect(results[i]?.scope).toBe('case');
        expect(results[i]?.matchedEvidence?.id).toBe(`evd_case_${caseIdx}`);
        expect(results[i]?.matchedTitle).toBe(`Case Evidence Doc ${caseIdx}`);
      }

      // Verify intra-batch clusters (70..119):
      // The first file of each cluster (copy 0) must be isDuplicate=false
      // Subsequent copies (1..9) must be isDuplicate=true, scope='batch', matchedTitle pointing to copy 0
      for (let clusterIdx = 0; clusterIdx < 5; clusterIdx++) {
        const rootIdx = 70 + clusterIdx * 10;
        expect(results[rootIdx]?.isDuplicate).toBe(false);

        for (let copyIdx = 1; copyIdx < 10; copyIdx++) {
          const idx = rootIdx + copyIdx;
          expect(results[idx]?.isDuplicate).toBe(true);
          expect(results[idx]?.scope).toBe('batch');
          expect(results[idx]?.matchedTitle).toBe(`cluster_${clusterIdx}_copy_0.txt`);
        }
      }

      // Verify cyclic case collisions (120..149)
      for (let i = 120; i < 150; i++) {
        const caseIdx = (i - 120) % 5;
        expect(results[i]?.isDuplicate).toBe(true);
        expect(results[i]?.scope).toBe('case');
        expect(results[i]?.matchedTitle).toBe(`Case Evidence Doc ${caseIdx}`);
      }
    });

    it('strictly prioritizes case collisions over intra-batch duplicates in any ordering', async () => {
      const sharedContent = Buffer.from('Shared Payload Between Case and Batch');
      const hash = nobleBytesToHex(nobleSha256(new Uint8Array(sharedContent)));

      const caseEvidence = createMockEvidence({
        id: 'evd_master_case',
        title: 'Master Case Doc',
        sha256: hash,
      });

      const filePath1 = path.join(tempDir, 'prio_1.txt');
      const filePath2 = path.join(tempDir, 'prio_2.txt');
      fs.writeFileSync(filePath1, sharedContent);
      fs.writeFileSync(filePath2, sharedContent);

      const files: PickedFile[] = [
        createMockPickedFile({ uri: `file://${filePath1}`, name: 'prio_1.txt' }),
        createMockPickedFile({ uri: `file://${filePath2}`, name: 'prio_2.txt' }),
      ];

      const results = await checkBatchDuplicatesBeforeUpload(files, [caseEvidence]);

      // Both must be identified as 'case' duplicates, NOT 'batch' duplicate for the second
      expect(results[0]?.isDuplicate).toBe(true);
      expect(results[0]?.scope).toBe('case');
      expect(results[0]?.matchedEvidence?.id).toBe('evd_master_case');

      expect(results[1]?.isDuplicate).toBe(true);
      expect(results[1]?.scope).toBe('case');
      expect(results[1]?.matchedEvidence?.id).toBe('evd_master_case');
    });
  });

  // =========================================================================
  // 3. Adversarial Inputs: Zero-Byte, Multi-GB, Cyclic, Corrupt, Unicode
  // =========================================================================
  describe('Adversarial Inputs & Stress Edge Cases', () => {
    describe('Zero-Byte Files', () => {
      it('handles multiple zero-byte files in batch and detects intra-batch duplicate', async () => {
        const file1 = createMockPickedFile({ uri: 'data:text/plain;base64,', name: 'zero1.txt', size: 0 });
        const file2 = createMockPickedFile({ uri: 'data:text/plain;base64,', name: 'zero2.txt', size: 0 });
        const file3 = createMockPickedFile({ uri: 'data:text/plain,', name: 'zero3.txt', size: 0 });

        const results = await checkBatchDuplicatesBeforeUpload([file1, file2, file3], []);

        expect(results[0]?.sha256).toBe(CANONICAL_EMPTY_SHA256);
        expect(results[0]?.isDuplicate).toBe(false);

        expect(results[1]?.sha256).toBe(CANONICAL_EMPTY_SHA256);
        expect(results[1]?.isDuplicate).toBe(true);
        expect(results[1]?.scope).toBe('batch');
        expect(results[1]?.matchedTitle).toBe('zero1.txt');

        expect(results[2]?.sha256).toBe(CANONICAL_EMPTY_SHA256);
        expect(results[2]?.isDuplicate).toBe(true);
        expect(results[2]?.scope).toBe('batch');
        expect(results[2]?.matchedTitle).toBe('zero1.txt');
      });

      it('detects case collision when existing evidence has zero-byte hash', async () => {
        const existingZero = createMockEvidence({
          id: 'evd_empty_case',
          title: 'Empty File in Case',
          sha256: CANONICAL_EMPTY_SHA256,
        });

        const picked = createMockPickedFile({
          uri: 'data:application/octet-stream;base64,',
          name: 'uploaded_empty.bin',
          size: 0,
        });

        const result = await checkDuplicateBeforeUpload(picked, [existingZero]);
        expect(result.isDuplicate).toBe(true);
        expect(result.matchedEvidence?.id).toBe('evd_empty_case');
        expect(result.sha256).toBe(CANONICAL_EMPTY_SHA256);
      });
    });

    describe('Multi-Gigabyte Simulation & Chunked Stream Processing', () => {
      it('streams a large 8 MB file through Node readStream without byte corruption', async () => {
        const largePath = path.join(tempDir, 'large_8mb.bin');
        const chunkSize = 128 * 1024; // 128 KB
        const totalChunks = 64; // 64 * 128 KB = 8 MB

        const writeStream = fs.createWriteStream(largePath);
        const nobleHasher = nobleSha256.create();

        for (let i = 0; i < totalChunks; i++) {
          const chunk = Buffer.alloc(chunkSize);
          for (let j = 0; j < chunkSize; j++) {
            chunk[j] = (i * 17 + j * 31) & 0xff;
          }
          writeStream.write(chunk);
          nobleHasher.update(new Uint8Array(chunk));
        }
        await new Promise<void>((resolve) => writeStream.end(resolve));

        const expectedHash = nobleBytesToHex(nobleHasher.digest());

        const picked = createMockPickedFile({
          uri: `file://${largePath}`,
          name: 'large_8mb.bin',
          size: totalChunks * chunkSize,
        });

        const computedHash = await computeFileSha256(picked);
        expect(computedHash).toBe(expectedHash);
      });
    });

    describe('Cyclic Duplicate Patterns', () => {
      it('handles alternating cyclic duplicate batches (A, B, A, B, A, B) deterministically', async () => {
        const dataA = Buffer.from('Pattern Alpha');
        const dataB = Buffer.from('Pattern Beta');

        const hashA = nobleBytesToHex(nobleSha256(new Uint8Array(dataA)));
        const hashB = nobleBytesToHex(nobleSha256(new Uint8Array(dataB)));

        const pathA = path.join(tempDir, 'cyclic_a.txt');
        const pathB = path.join(tempDir, 'cyclic_b.txt');
        fs.writeFileSync(pathA, dataA);
        fs.writeFileSync(pathB, dataB);

        const files: PickedFile[] = [
          createMockPickedFile({ uri: `file://${pathA}`, name: 'A1.txt' }),
          createMockPickedFile({ uri: `file://${pathB}`, name: 'B1.txt' }),
          createMockPickedFile({ uri: `file://${pathA}`, name: 'A2.txt' }),
          createMockPickedFile({ uri: `file://${pathB}`, name: 'B2.txt' }),
          createMockPickedFile({ uri: `file://${pathA}`, name: 'A3.txt' }),
          createMockPickedFile({ uri: `file://${pathB}`, name: 'B3.txt' }),
        ];

        const results = await checkBatchDuplicatesBeforeUpload(files, []);

        expect(results[0]).toMatchObject({ isDuplicate: false, sha256: hashA });
        expect(results[1]).toMatchObject({ isDuplicate: false, sha256: hashB });

        expect(results[2]).toMatchObject({ isDuplicate: true, scope: 'batch', matchedTitle: 'A1.txt', sha256: hashA });
        expect(results[3]).toMatchObject({ isDuplicate: true, scope: 'batch', matchedTitle: 'B1.txt', sha256: hashB });

        expect(results[4]).toMatchObject({ isDuplicate: true, scope: 'batch', matchedTitle: 'A1.txt', sha256: hashA });
        expect(results[5]).toMatchObject({ isDuplicate: true, scope: 'batch', matchedTitle: 'B1.txt', sha256: hashB });
      });
    });

    describe('Corrupt & Malformed URIs', () => {
      it('throws when file uri is missing or empty', async () => {
        await expect(computeFileSha256(createMockPickedFile({ uri: '', name: 'test.txt' }))).rejects.toThrow(
          'File URI is required for duplicate checking',
        );
      });

      it('throws when data URI is missing comma separator', async () => {
        await expect(
          computeFileSha256(createMockPickedFile({ uri: 'data:text/plain;base64SGVsbG8=', name: 'bad.txt' })),
        ).rejects.toThrow('Invalid data URI format');
      });

      it('throws when data URI has malformed percent-encoding in non-base64 mode', async () => {
        await expect(
          computeFileSha256(createMockPickedFile({ uri: 'data:text/plain,broken%ZZmalformed', name: 'broken.txt' })),
        ).rejects.toThrow();
      });

      it('throws when local file does not exist on disk', async () => {
        const nonExistentPath = path.join(tempDir, 'does_not_exist_at_all.bin');
        await expect(
          computeFileSha256(createMockPickedFile({ uri: `file://${nonExistentPath}`, name: 'missing.bin' })),
        ).rejects.toThrow('Unable to read file for duplicate check');
      });

      it('throws when unsupported protocol is supplied', async () => {
        await expect(
          computeFileSha256(createMockPickedFile({ uri: 'customproto://storage/my_file.pdf', name: 'custom.pdf' })),
        ).rejects.toThrow('Unable to read file for duplicate check');
      });
    });

    describe('Unicode, Non-ASCII & Special Character File Paths', () => {
      it('correctly hashes files with Hindi/Devanagari characters in path and name', async () => {
        const content = Buffer.from('महत्वपूर्ण कानूनी सबूत कागजात २०२६');
        const expectedHash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const subDir = path.join(tempDir, 'सबूत_फ़ोल्डर');
        fs.mkdirSync(subDir);
        const filePath = path.join(subDir, 'न्यायालय_दस्तावेज़.txt');
        fs.writeFileSync(filePath, content);

        const picked = createMockPickedFile({
          uri: `file://${filePath}`,
          name: 'न्यायालय_दस्तावेज़.txt',
          size: content.length,
        });

        const computed = await computeFileSha256(picked);
        expect(computed).toBe(expectedHash);
      });

      it('correctly hashes files with Japanese, Cyrillic, and Emoji characters in path', async () => {
        const content = Buffer.from('Japanese 日本語 + Cyrillic русский + Emoji ⚡📁🔥');
        const expectedHash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const subDir = path.join(tempDir, 'フォルダ_📁');
        fs.mkdirSync(subDir);
        const filePath = path.join(subDir, '証拠_файл_⚡.bin');
        fs.writeFileSync(filePath, content);

        const picked = createMockPickedFile({
          uri: `file://${filePath}`,
          name: '証拠_файл_⚡.bin',
          size: content.length,
        });

        const computed = await computeFileSha256(picked);
        expect(computed).toBe(expectedHash);
      });

      it('correctly hashes files with spaces in path (both unencoded and percent-encoded file://)', async () => {
        const content = Buffer.from('Evidence document stored inside a path containing spaces');
        const expectedHash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const subDir = path.join(tempDir, 'Folder With Spaces');
        fs.mkdirSync(subDir);
        const filePath = path.join(subDir, 'My Signed Affidavit 2026.txt');
        fs.writeFileSync(filePath, content);

        // Raw path without file://
        const pickedRaw = createMockPickedFile({
          uri: filePath,
          name: 'My Signed Affidavit 2026.txt',
        });
        expect(await computeFileSha256(pickedRaw)).toBe(expectedHash);

        // Percent-encoded file:// URI
        const encodedUri = `file://${filePath.replace(/ /g, '%20')}`;
        const pickedEncoded = createMockPickedFile({
          uri: encodedUri,
          name: 'My Signed Affidavit 2026.txt',
        });
        expect(await computeFileSha256(pickedEncoded)).toBe(expectedHash);
      });
    });

    describe('Database Tolerance & Normalization', () => {
      it('matches uppercase hashes and hashes with surrounding whitespace in existing evidence', async () => {
        const content = Buffer.from('Database Normalization Test Case');
        const hash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const existingUpper = createMockEvidence({
          id: 'evd_upper',
          title: 'Upper Hash Evidence',
          sha256: `  ${hash.toUpperCase()}  `,
        });

        const picked = createMockPickedFile({
          uri: `data:text/plain;base64,${content.toString('base64')}`,
          name: 'test.txt',
        });

        const result = await checkDuplicateBeforeUpload(picked, [existingUpper]);
        expect(result.isDuplicate).toBe(true);
        expect(result.matchedEvidence?.id).toBe('evd_upper');
        expect(result.sha256).toBe(hash);
      });

      it('safely ignores null, undefined, or empty sha256 in existing evidence records', async () => {
        const content = Buffer.from('Test Content');
        const hash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const existingNull = createMockEvidence({ id: 'evd_null', sha256: null as any });
        const existingEmpty = createMockEvidence({ id: 'evd_empty_str', sha256: '' });

        const picked = createMockPickedFile({
          uri: `data:text/plain;base64,${content.toString('base64')}`,
          name: 'test.txt',
        });

        const result = await checkDuplicateBeforeUpload(picked, [existingNull, existingEmpty]);
        expect(result.isDuplicate).toBe(false);
        expect(result.sha256).toBe(hash);
      });

      it('safely ignores soft-deleted existing evidence records', async () => {
        const content = Buffer.from('Soft Deleted Evidence Content');
        const hash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const softDeleted = createMockEvidence({
          id: 'evd_deleted',
          title: 'Deleted Contract',
          sha256: hash,
          deletedAt: Date.now() - 10000,
        });

        const picked = createMockPickedFile({
          uri: `data:text/plain;base64,${content.toString('base64')}`,
          name: 'reupload.txt',
        });

        const result = await checkDuplicateBeforeUpload(picked, [softDeleted]);
        expect(result.isDuplicate).toBe(false);
        expect(result.matchedEvidence).toBeUndefined();
      });
    });

    describe('Web Fetch / Blob Branch', () => {
      it('correctly hashes blob / http responses when fetch succeeds', async () => {
        const content = Buffer.from('Remote blob payload');
        const expectedHash = nobleBytesToHex(nobleSha256(new Uint8Array(content)));

        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            statusText: 'OK',
            arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
          });

          const picked = createMockPickedFile({
            uri: 'blob:http://localhost:8081/blob-uuid-1234',
            name: 'remote.pdf',
          });

          const hash = await computeFileSha256(picked);
          expect(hash).toBe(expectedHash);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      it('throws when web fetch returns non-ok response', async () => {
        const originalFetch = globalThis.fetch;
        try {
          globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            statusText: 'Not Found',
          });

          const picked = createMockPickedFile({
            uri: 'blob:http://localhost:8081/non-existent-blob',
            name: 'missing.pdf',
          });

          await expect(computeFileSha256(picked)).rejects.toThrow('Failed to read file from URI: Not Found');
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });
  });
});
