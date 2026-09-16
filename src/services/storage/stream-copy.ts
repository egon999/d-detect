/**
 * Copying a file's bytes in bounded chunks, hashing them on the way past.
 *
 * ## The failure this exists to prevent
 *
 * The evidence store used to read an original with `File.bytes()` — the whole file, into one
 * `Uint8Array` — and then hash that buffer in a single synchronous call before writing it out
 * in chunks. For the 100 MB ceiling this app accepts (see `MAX_EVIDENCE_UPLOAD_BYTES`), that
 * is 100 MB resident in the JS heap, plus whatever the copy in the native bridge costs, on a
 * mid-range Android handset whose per-process limit is frequently 192 MB or 256 MB. A user
 * adding a 200 MB screen recording is refused by the size check, which is fine; a user adding
 * an 80 MB one was inside the limit and got an out-of-memory kill, which is not.
 *
 * The synchronous hash is the second half of the same problem. `sha256` over 80 MB is on the
 * order of a second of uninterrupted work on that class of device, and it runs on the only
 * thread React Native has to draw with, so the progress bar the user is watching freezes at
 * whatever fraction it had reached — the exact moment they conclude the app has hung and kill
 * it themselves.
 *
 * So the bytes move a megabyte at a time: read a chunk, fold it into a streaming digest,
 * write it out, report progress, and hand the thread back before the next one. Peak memory
 * becomes the chunk size rather than the file size, and the digest costs the same total work
 * spread across intervals short enough to stay invisible.
 *
 * ## Why the handles are interfaces rather than `FileHandle`
 *
 * `ByteReader` and `ByteWriter` are the two methods this module actually calls, declared
 * structurally. Expo's `FileHandle` satisfies both without being named here, which keeps this
 * file free of `expo-file-system` — a native module that cannot load in a plain Node process.
 * That is not a testing convenience but the only way the loop below can be tested at all: the
 * properties that matter (that the digest equals a whole-buffer hash of the same bytes, that
 * cancellation stops mid-file, that a truncated source is refused rather than stored) are
 * properties of this control flow, and they are unreachable behind a native filesystem.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * A source that hands over up to `length` bytes from its own cursor and advances it.
 *
 * Returning fewer bytes than asked for is normal and means end of file — that is what both
 * platform implementations behind Expo's `FileHandle` do (Android clamps the read to the
 * bytes remaining; iOS's `read(upToCount:)` is explicit about it), so the loop treats an
 * empty result as the end rather than as an error.
 */
export interface ByteReader {
  readBytes(length: number): Uint8Array;
}

/** A destination that appends bytes at its own cursor and advances it. */
export interface ByteWriter {
  writeBytes(bytes: Uint8Array): void;
}

/**
 * One megabyte.
 *
 * Chosen against two opposing costs. Smaller chunks mean more round trips across the native
 * bridge and more yields, which makes a large copy measurably slower for no benefit the user
 * can see; larger ones mean each synchronous read, hash and write occupies the JS thread for
 * longer, which is the freeze this module exists to avoid. At 1 MB a copy step is a few
 * milliseconds of work — comfortably inside one frame — and an 80 MB file yields eighty
 * times, giving the progress bar eighty honest updates.
 */
export const COPY_CHUNK_BYTES = 1024 * 1024;

export interface StreamCopyOptions {
  source: ByteReader;
  destination: ByteWriter;
  /**
   * Bytes expected, from the source file's own size.
   *
   * Required rather than inferred by reading to exhaustion, because it is what makes a
   * partial copy detectable. Without it, a source that stops early — a picker cache file
   * evicted mid-copy, a document provider that dies partway — is indistinguishable from a
   * file that was simply that long, and the store would end up holding a truncated original
   * under a digest that describes it perfectly.
   */
  totalBytes: number;
  chunkBytes?: number;
  /** Cancellation, checked before every chunk. See the note in `copyWithDigest`. */
  signal?: AbortSignal;
  /** 0..1 on real bytes moved, called once per chunk. */
  onProgress?: (fraction: number) => void;
  /**
   * Hands the thread back between chunks. Defaults to a macrotask yield.
   *
   * A seam for tests, which would otherwise pay a real timer per chunk. It is deliberately
   * not a way to switch yielding off in production: the yield is the reason the UI keeps
   * drawing during a large copy.
   */
  yieldToHost?: () => Promise<void>;
}

export interface StreamCopyResult {
  bytesCopied: number;
  /** Lowercase hex SHA-256 of exactly the bytes that were read and written. */
  sha256: string;
}

/** A macrotask boundary, which is what actually lets React Native draw a frame. */
const macrotask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/**
 * Streams `totalBytes` from `source` into `destination`, returning their SHA-256.
 *
 * The digest is folded from the same buffers that are written, in the same pass, so it
 * describes precisely what was read out of the source and put into the destination. Hashing
 * separately — before the write, as the previous revision did, or by re-reading the
 * destination afterwards — would be two passes over the file and would leave a window in
 * which the two could disagree.
 *
 * Cancellation is checked before each chunk rather than only at the start, because the whole
 * point of stopping a 100 MB copy is to stop it while it is running. The partial destination
 * is *not* cleaned up here: this module does not own the file it was handed, and only the
 * caller knows whether the destination is a real stored original that must be removed or a
 * temporary it is about to discard anyway. `uploadEvidenceFile` does that cleanup.
 *
 * @throws If the signal is already aborted, if the source ends before `totalBytes`, or if
 * either handle throws. The message on a short read is written for the person holding the
 * phone, because this is a real and reachable condition — a cache file the OS reclaimed
 * under memory pressure while the copy was in flight.
 */
export async function copyWithDigest(options: StreamCopyOptions): Promise<StreamCopyResult> {
  const chunkBytes = options.chunkBytes ?? COPY_CHUNK_BYTES;
  const yieldToHost = options.yieldToHost ?? macrotask;
  const total = options.totalBytes;

  if (options.signal?.aborted) throw new Error('Upload cancelled.');
  if (total <= 0) throw new Error('This file is empty, so there is nothing to store or read.');

  const digest = sha256.create();
  let copied = 0;

  while (copied < total) {
    if (options.signal?.aborted) throw new Error('Upload cancelled.');

    // Never asks for more than is left, so the final chunk does not depend on the source
    // clamping the request for us. Both platform handles do clamp, but relying on that would
    // make the short-read check below unable to tell "the file ended early" from "we asked
    // past the end", which are the two cases it has to separate.
    const want = Math.min(chunkBytes, total - copied);
    const chunk = options.source.readBytes(want);

    if (chunk.length === 0) break;

    digest.update(chunk);
    options.destination.writeBytes(chunk);
    copied += chunk.length;

    options.onProgress?.(copied / total);

    // After the write, not before, so a copy that is about to finish does not pay for a
    // yield it has no use for.
    if (copied < total) await yieldToHost();
  }

  if (copied !== total) {
    throw new Error('The file could not be read completely — it may have been moved or deleted. Select it again.');
  }

  return { bytesCopied: copied, sha256: bytesToHex(digest.digest()) };
}

/**
 * Hashes a source without writing it anywhere, in the same bounded chunks.
 *
 * Needed because two source kinds are never copied into the JS heap at all. An audio or
 * video original is handed to `./transcribe` and `../ingestion/video-frames` as a *URI* —
 * the runtime streams it off disk into a multipart body, and the frame sampler goes through
 * the platform decoder — so ingestion needs the file's digest and length and has no use for
 * its bytes. Reading a 90 MB recording into memory to hash it and then discarding it was
 * pure cost, and on the devices this app targets it was the most likely single cause of an
 * out-of-memory kill in the whole pipeline.
 *
 * Takes `totalBytes` and applies the same short-read rule as `copyWithDigest`, for the same
 * reason: a digest over a truncated read is a correct hash of the wrong file, and it would be
 * written onto the evidence record as the original's fingerprint.
 */
export async function digestStream(options: {
  source: ByteReader;
  totalBytes: number;
  chunkBytes?: number;
  signal?: AbortSignal;
  yieldToHost?: () => Promise<void>;
}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? COPY_CHUNK_BYTES;
  const yieldToHost = options.yieldToHost ?? macrotask;
  const total = options.totalBytes;

  if (options.signal?.aborted) throw new Error('Reading cancelled.');

  const digest = sha256.create();
  let read = 0;

  while (read < total) {
    if (options.signal?.aborted) throw new Error('Reading cancelled.');
    const chunk = options.source.readBytes(Math.min(chunkBytes, total - read));
    if (chunk.length === 0) break;
    digest.update(chunk);
    read += chunk.length;
    if (read < total) await yieldToHost();
  }

  if (read !== total) {
    throw new Error('The file could not be read completely — it may have been moved or deleted. Select it again.');
  }

  return bytesToHex(digest.digest());
}
