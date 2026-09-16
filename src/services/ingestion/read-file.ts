import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { digestStream } from '../storage/stream-copy';

/**
 * Thin wrappers over the Expo SDK 55 filesystem API.
 *
 * SDK 55 replaced the old function API (`readAsStringAsync`, `getInfoAsync`,
 * `documentDirectory`, …) with the `File` / `Directory` / `Paths` classes. The old
 * functions are deprecated and throw at runtime unless imported from
 * `expo-file-system/legacy`, so everything here goes through `File`.
 *
 * Verified against node_modules/expo-file-system/build/ExpoFileSystem.types.d.ts
 * (v55.0.26): `bytes(): Promise<Uint8Array<ArrayBuffer>>`, `text(): Promise<string>`,
 * and the synchronous properties `size: number` and `exists: boolean`.
 *
 * NOTE: this module imports `expo-file-system`, which cannot be loaded in a plain
 * Node/vitest process (its package `exports` map points at untranspiled TypeScript).
 * That is why `ingest.ts` reaches it through a lazy dynamic import, and why the pure
 * parsers are importable without dragging this file in.
 */

/** Reads the whole file as bytes. */
export async function readBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === 'web') {
    if (!uri.startsWith('blob:') && !uri.startsWith('data:')) throw new Error('Choose a local file to upload.');
    const response = await fetch(uri);
    if (!response.ok) throw new Error('The selected file could not be read. Select it again.');
    return new Uint8Array(await response.arrayBuffer());
  }
  const file = new File(uri);
  return await file.bytes();
}

/** Reads the whole file as a UTF-8 string. */
export async function readText(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const bytes = await readBytes(uri);
    return new TextDecoder().decode(bytes);
  }
  const file = new File(uri);
  return await file.text();
}

/**
 * File size in bytes, or null when the file is missing or unreadable.
 *
 * `File.size` is `0` both for a genuinely empty file and for one that cannot be
 * read, so `exists` disambiguates: a real empty file reports 0, a missing one null.
 */
export async function fileSize(uri: string): Promise<number | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    const size = file.size;
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * Lowercase hex SHA-256 of a file on disk, read a megabyte at a time.
 *
 * This exists for the recordings. Audio and video are handed to the transcriber and the frame
 * sampler as a *URI* — their bytes are never decoded in JavaScript — so reading a 200 MB video
 * into a `Uint8Array` purely to hash it and drop the buffer put the entire file on the heap of a
 * handset whose per-process limit is often 192 MB, and froze the UI thread for the length of the
 * hash. Streaming keeps the peak at one chunk and yields between chunks, so the file size stops
 * being a memory bound at all.
 *
 * `totalBytes` comes from `fileSize` rather than being discovered by reading to EOF, because
 * `digestStream` refuses a short read: a digest taken over a partial read is a perfectly valid
 * hash of the wrong bytes, and it would be stored as the original's fingerprint and verify as
 * correct forever after.
 */
export async function sha256File(uri: string, totalBytes: number): Promise<string> {
  if (Platform.OS === 'web') {
    // A browser has no file handles, and the blob the picker handed us is already resident, so
    // a chunked pass would add a second traversal without lowering the peak.
    return sha256Hex(await readBytes(uri));
  }
  const file = new File(uri);
  const handle = file.open();
  try {
    return await digestStream({ source: handle, totalBytes });
  } finally {
    // Released on every path: a handle left open holds a file descriptor for the life of the
    // process, and a long queue of recordings would exhaust the table.
    try {
      handle.close();
    } catch {
      // Closing a handle that never opened cleanly has nothing to release, and throwing here
      // would replace the real failure with a misleading one.
    }
  }
}
