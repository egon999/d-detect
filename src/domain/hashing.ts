import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Content fingerprinting.
 *
 * SHA-256 is the *only* basis on which Detact will call two evidence items exact
 * duplicates. A pure-JS implementation is used rather than `expo-crypto` so the same
 * function runs unchanged in React Native, in Node tests and in Cloud Functions — a
 * hash that differed between environments would break duplicate detection silently.
 */

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function hashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text));
}

/**
 * Fingerprint of a processing job's inputs.
 *
 * A retried job whose fingerprint matches the last completed run has nothing new to
 * do, which is what makes the pipeline safe to invoke repeatedly. Any change to the
 * file, the extractor version or the enabled rule set produces a different value and
 * so forces genuine reprocessing.
 */
export function processingFingerprint(parts: {
  evidenceId: string;
  sha256: string | null;
  extractorVersion: string;
  ruleVersions: readonly string[];
}): string {
  return hashText(
    [parts.evidenceId, parts.sha256 ?? 'no-file', parts.extractorVersion, [...parts.ruleVersions].sort().join(',')].join(
      '|',
    ),
  );
}

/** Base64 helper used when hashing a file the platform hands back as base64. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
