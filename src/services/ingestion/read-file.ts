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

/** The leading bytes of a file, and how long the whole file is. */
export interface FilePrefix {
  /** The bytes read. Fewer than the limit asked for means the file ended first. */
  bytes: Uint8Array;
  /** The file's own length, whether or not that many bytes were read. */
  totalBytes: number;
}

/**
 * Reads at most `limit` bytes from the start of a file, and reports its real length.
 *
 * This exists for the text branches of `ingestFile`. A 100 MB `.csv` or `.log` is inside the
 * store's limit and reaches ingestion, where `readBytes` put all of it on the heap, `decodeUtf8`
 * made a string of it, and `parseCsv` made two more copies of that string — over 300 MB peak on
 * a handset whose per-process limit is often 192 MB. All of it to keep the 40,000 characters
 * `@domain/extraction/deterministic` clamps the text to. Reading a bounded prefix instead makes
 * the file's size stop mattering on those paths.
 *
 * `totalBytes` is returned alongside, not inferred by the caller from `bytes.length`, because
 * the caller needs three different things from it: the size it records on the evidence row, the
 * `totalBytes` that `sha256File` hashes over — the digest must still describe the whole file —
 * and the answer to "was this file actually longer than the prefix", which is what tells it
 * whether it read part of a file or all of a short one.
 */
export async function readPrefix(uri: string, limit: number): Promise<FilePrefix> {
  if (Platform.OS === 'web') {
    // A browser has no file handle to seek and the picker's blob is already resident, so the
    // fetch costs the whole file no matter what is done with it afterwards — there is nothing
    // here to stream and this does not pretend otherwise. `slice`, not `subarray`: a view keeps
    // the entire fetched buffer alive for as long as the prefix is held, which is precisely the
    // allocation being avoided. Copying a couple of megabytes lets the rest go immediately.
    const all = await readBytes(uri);
    if (all.length <= limit) return { bytes: all, totalBytes: all.length };
    return { bytes: all.slice(0, limit), totalBytes: all.length };
  }

  const file = new File(uri);
  // `size` is 0 for a missing file as well as an empty one, so `exists` has to be asked first —
  // the same disambiguation `fileSize` makes, and for a stronger reason here: reporting a
  // missing file as a 0-byte one would have ingestion tell the user their file was empty.
  if (!file.exists) throw new Error('the file is missing or unreadable');
  const totalBytes = file.size;
  if (!Number.isFinite(totalBytes)) throw new Error('the file is missing or unreadable');

  // Short enough that bounding it buys nothing: read it the way `readBytes` would, so a small
  // file goes through exactly the call it goes through today.
  if (totalBytes <= limit) return { bytes: await file.bytes(), totalBytes };

  const handle = file.open();
  try {
    return { bytes: handle.readBytes(limit), totalBytes };
  } finally {
    // Released on every path, for the reason `sha256File` gives below: a handle left open holds
    // a file descriptor for the life of the process, and a queue of large files would exhaust
    // the table.
    try {
      handle.close();
    } catch {
      // Closing a handle that never opened cleanly has nothing to release, and throwing here
      // would replace the real failure with a misleading one.
    }
  }
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
 *
 * The web branch is not symmetric with the others by accident. `readBytes`, `readPrefix`,
 * `readText` and `sha256File` each state the browser case and then fall through to `File`;
 * this one did not, so on the web build `new File('blob:…')` threw, the `catch` turned it
 * into `null`, and `ingest.ts` read that null as "the file is missing or unreadable". Every
 * audio and video recording was therefore rejected on web before it could be stored — the
 * one input the picker cannot supply as bytes, and so the one input that always took this
 * path. A browser has no handle and no `size`, so the length is asked of the blob itself.
 *
 * `blob()`, not `arrayBuffer()`: the response already points at resident bytes and `blob()`
 * returns a view of them, where `arrayBuffer()` would copy the whole file — up to the store's
 * limit — to read one number off it.
 */
export async function fileSize(uri: string): Promise<number | null> {
  if (Platform.OS === 'web') {
    try {
      if (!uri.startsWith('blob:') && !uri.startsWith('data:')) return null;
      const response = await fetch(uri);
      if (!response.ok) return null;
      return (await response.blob()).size;
    } catch {
      return null;
    }
  }
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
