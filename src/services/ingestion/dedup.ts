/**
 * Immediate pre-upload deduplication pipeline.
 *
 * Checks picked files for duplicate content by computing their SHA-256 hash
 * via `@noble/hashes` before uploading/storing, comparing against existing case evidence.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Evidence } from '@domain/models';
import type { PickedFile } from './types';

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchedEvidence?: Evidence;
  sha256: string;
}

/**
 * Computes the lowercase hex SHA-256 fingerprint of a picked file across platforms:
 * - Data URIs (base64 or percent-encoded)
 * - React Native / Expo filesystem (via dynamic read-file)
 * - Node.js filesystem (streams/readFile for Vitest tests)
 * - Web fetch (blob: or object URLs)
 */
export async function computeFileSha256(file: PickedFile): Promise<string> {
  const uri = file.uri;
  if (!uri) {
    throw new Error('File URI is required for duplicate checking');
  }

  // 1. Data URIs
  if (uri.startsWith('data:')) {
    const commaIndex = uri.indexOf(',');
    if (commaIndex === -1) {
      throw new Error('Invalid data URI format');
    }
    const meta = uri.slice(0, commaIndex);
    const data = uri.slice(commaIndex + 1);
    let bytes: Uint8Array;
    if (meta.includes(';base64')) {
      if (typeof Buffer !== 'undefined') {
        bytes = new Uint8Array(Buffer.from(data, 'base64'));
      } else if (typeof atob === 'function') {
        const binaryString = atob(data);
        bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i += 1) {
          bytes[i] = binaryString.charCodeAt(i);
        }
      } else {
        throw new Error('Base64 decoding not supported in this runtime');
      }
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(data));
    }
    return bytesToHex(sha256(bytes));
  }

  // 2. React Native / Expo FileSystem via read-file
  try {
    const readFile = await import('./read-file');
    if (readFile && typeof readFile.readBytes === 'function') {
      const size = file.size ?? (readFile.fileSize ? await readFile.fileSize(uri) : null);
      if (size === 0) {
        return bytesToHex(sha256(new Uint8Array(0)));
      }
      if (size !== null && size > 2 * 1024 * 1024 && typeof readFile.sha256File === 'function') {
        return await readFile.sha256File(uri, size);
      }
      const bytes = await readFile.readBytes(uri);
      return readFile.sha256Hex ? readFile.sha256Hex(bytes) : bytesToHex(sha256(bytes));
    }
  } catch {
    // Dynamic import of read-file fails in plain Node/Vitest without mocks; fall through.
  }

  // 3. Node.js filesystem (used in Vitest test runs and Node scripts)
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const fs = await import('node:fs');
      let localPath = uri;
      if (localPath.startsWith('file://')) {
        try {
          const { fileURLToPath } = await import('node:url');
          localPath = fileURLToPath(localPath);
        } catch {
          localPath = localPath.replace(/^file:\/\//, '');
        }
      }
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        if (stat.size === 0) {
          return bytesToHex(sha256(new Uint8Array(0)));
        }
        return await new Promise<string>((resolve, reject) => {
          const hasher = sha256.create();
          const stream = fs.createReadStream(localPath);
          stream.on('data', (chunk: string | Buffer) => {
            const bytes = typeof chunk === 'string'
              ? new TextEncoder().encode(chunk)
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            hasher.update(bytes);
          });
          stream.on('end', () => resolve(bytesToHex(hasher.digest())));
          stream.on('error', reject);
        });
      }
    } catch {
      // Fall through if file doesn't exist on local disk
    }
  }

  // 4. Web fetch for blob: or remote URLs
  if (typeof fetch === 'function' && (uri.startsWith('blob:') || uri.startsWith('http://') || uri.startsWith('https://'))) {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Failed to read file from URI: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return bytesToHex(sha256(new Uint8Array(arrayBuffer)));
  }

  throw new Error(`Unable to read file for duplicate check: ${uri}`);
}

/**
 * Checks whether a picked file is a duplicate of any existing evidence in the case.
 *
 * Computes the SHA-256 digest of the picked file and compares against active (non-deleted)
 * evidence records in the case.
 *
 * @param file The picked file to check
 * @param existingEvidence Evidence records in the current case
 * @returns DuplicateCheckResult containing whether it's duplicate, matched evidence if any, and sha256
 */
export async function checkDuplicateBeforeUpload(
  file: PickedFile,
  existingEvidence: Evidence[],
): Promise<DuplicateCheckResult> {
  const fileHash = await computeFileSha256(file);
  const normalizedHash = fileHash.toLowerCase().trim();

  const matched = existingEvidence.find((item) => {
    if (item.deletedAt) return false;
    if (!item.sha256) return false;
    return item.sha256.toLowerCase().trim() === normalizedHash;
  });

  return {
    isDuplicate: Boolean(matched),
    matchedEvidence: matched,
    sha256: normalizedHash,
  };
}

export interface BatchDuplicateResult {
  file: PickedFile;
  sha256: string;
  isDuplicate: boolean;
  scope?: 'case' | 'batch';
  matchedTitle?: string;
  matchedEvidence?: Evidence;
}

/**
 * Checks an array of picked files for duplicates against existing case evidence
 * AND against other files within the current batch.
 */
export async function checkBatchDuplicatesBeforeUpload(
  files: PickedFile[],
  existingEvidence: Evidence[],
): Promise<BatchDuplicateResult[]> {
  const results: BatchDuplicateResult[] = [];
  const seenBatchHashes = new Map<string, PickedFile>();

  for (const file of files) {
    const hash = await computeFileSha256(file);
    const normalizedHash = hash.toLowerCase().trim();

    const caseMatch = existingEvidence.find((item) => {
      if (item.deletedAt) return false;
      if (!item.sha256) return false;
      return item.sha256.toLowerCase().trim() === normalizedHash;
    });

    if (caseMatch) {
      results.push({
        file,
        sha256: normalizedHash,
        isDuplicate: true,
        scope: 'case',
        matchedTitle: caseMatch.title,
        matchedEvidence: caseMatch,
      });
    } else if (seenBatchHashes.has(normalizedHash)) {
      const earlierFile = seenBatchHashes.get(normalizedHash)!;
      results.push({
        file,
        sha256: normalizedHash,
        isDuplicate: true,
        scope: 'batch',
        matchedTitle: earlierFile.name,
      });
    } else {
      results.push({
        file,
        sha256: normalizedHash,
        isDuplicate: false,
      });
      seenBatchHashes.set(normalizedHash, file);
    }
  }

  return results;
}
