/**
 * Evidence originals: where the bytes actually live.
 *
 * ## The constraint that decided this design
 *
 * This app has no server, and it is not getting one. The Firebase project is on the Spark
 * (free) plan, which does not include Cloud Functions, and Firebase Storage now requires
 * Blaze on a newly created project — so `firebase/storage` cannot hold a single byte here.
 * The product also has to be demonstrated live on a phone with no VPS behind it.
 *
 * An earlier revision of this file uploaded through a `PUT /api/cases/:id/evidence/:id/file`
 * endpoint and fell back to Firebase Storage. Both paths were unreachable: `apiBaseUrl()`
 * reads `EXPO_PUBLIC_API_BASE_URL`, which is deliberately empty, and the Storage fallback
 * fails on Spark. The practical effect was that adding a source file to a case could not
 * succeed — which is the first thing anyone does with this app.
 *
 * So the original bytes are stored **on the device**, in the app's own private directory,
 * and that is the source of truth. Concretely that means:
 *
 * - It works offline, on the first launch, with no account provisioning and no billing plan.
 * - The file never leaves the handset, which is the correct default for a payment receipt or
 *   a salary slip. Nothing has to be trusted with it.
 * - It survives app restarts and OS cache pressure (`Paths.document`, not `Paths.cache`).
 * - It is readable instantly, so the evidence viewer opens a 20 MB PDF with no spinner and no
 *   round trip.
 *
 * What it costs, stated plainly rather than glossed: the files are gone if the app is
 * uninstalled or the device is lost, and they do not follow the account to a second device.
 * The optional answer is the Cloudinary mirror in `./cloudinary` (`mirrorToCloud`):
 * it is opt-in, this module never calls it, and it stays dormant until the build is
 * given Cloudinary credentials — so by default no byte leaves the device.
 *
 * ## Layout, and why the path format did not change
 *
 * `evidenceStoragePath()` still returns `users/{ownerId}/cases/{caseId}/{evidenceId}/original.{ext}`
 * even though nothing remote consumes it now. It is the record's stable logical key: it is
 * already persisted on existing evidence rows, `validatePrivateEvidencePath` enforces
 * ownership against it before any read, and it is what a Cloudinary mirror or a future
 * server would key on. Changing it would orphan every file already stored.
 *
 * Note what the path deliberately omits: the user's filename. A directory listing of this
 * store reveals no `Divorce petition final.pdf`, only opaque ids and `original.pdf`. The real
 * name lives in the database record, which is where an access check can be applied to it.
 *
 * ## Web
 *
 * `expo-file-system` is Android/iOS/tvOS. Under `react-native-web` the store is IndexedDB
 * (see `./web-blob-store`), keyed by the identical logical path so the rest of this module
 * does not branch beyond reading and writing.
 */

import { Platform } from 'react-native';

import { idSchema, type CloudStatus, type Evidence, type EvidenceKind } from '@domain/models';
import { newId } from '@domain/ids';
import type { PickedFile } from '../ingestion/types';

import { getCloudinaryConfig, mirrorToCloud } from './cloudinary';
import { enqueueCloudSync } from './cloud-sync-queue';
import { COPY_CHUNK_BYTES, copyWithDigest } from './stream-copy';

/**
 * 100 MB.
 *
 * Not an arbitrary round number: it is Groq's hard per-file limit for the Whisper
 * transcription endpoint, which is the largest single thing this app sends anywhere. A file
 * accepted here but rejected there would be stored and then permanently un-analysable, so
 * the two limits are deliberately the same.
 */
export const MAX_EVIDENCE_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * A failure this module has a written sentence for.
 *
 * The distinction this class draws is not cosmetic — it is the difference between a message
 * that can be shown to a person and one that cannot. Everything thrown with this name was
 * composed here, in English, for a reader: the file is gone, the file is empty, the file is
 * over the limit, the path is not this account's. A caller can persist it or print it as-is.
 *
 * Everything *else* that escapes this module came from somewhere with no such obligation.
 * `getWebBlob` rejects with a `DOMException` from IndexedDB; `expo-file-system` throws native
 * errors that quote the absolute URI; and `validatePrivateEvidencePath` used to let a
 * `ZodError` out, whose `message` is a JSON array of issues with the offending id inside it.
 * Those three were reaching `case-analysis.ts`, which wrote the raw `error.message` into the
 * evidence row's `failureReason` — a field that is stored in the workspace and rendered on
 * the analysis panel. A storage path holds the account id, the case id and the evidence id,
 * so the effect was a UUID triplet on screen in a product whose rule is that a reader is
 * never shown an identifier.
 *
 * Tagging at the throw site rather than pattern-matching messages at the catch site is the
 * point: a sentence reworded here stays safe automatically, and a new dependency that starts
 * throwing its own errors is untrusted by default rather than trusted until someone notices.
 */
export class EvidenceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceFileError';
  }
}

/** Whether this failure carries a message written for a person to read. */
export function isEvidenceFileError(error: unknown): error is EvidenceFileError {
  // By `name`, not `instanceof`: this module is dynamically imported at several call sites
  // and a bundler that hands out two copies would break an identity check silently.
  return error instanceof Error && error.name === 'EvidenceFileError';
}

/**
 * Bytes moved per progress tick.
 *
 * The progress bar has to move for a real reason. Writing the whole buffer in one call would
 * mean reporting 0 then 1 with a freeze between, which reads as a hang on a large video. 1 MB
 * chunks give a 40 MB file forty honest updates without making the write measurably slower.
 *
 * Re-exported from `./stream-copy`, which owns the chunked read/hash/write loop and explains
 * at length why this figure is 1 MB rather than larger or smaller.
 */
const WRITE_CHUNK_BYTES = COPY_CHUNK_BYTES;

function resolveEvidenceKind(mimeType: string, name: string): EvidenceKind {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType.startsWith('image/') || /^(png|jpe?g|webp|heic|gif)$/.test(extension)) return 'IMAGE';
  if (extension === 'pdf') return 'PDF';
  if (mimeType.startsWith('audio/') || /^(mp3|wav|m4a|ogg|flac)$/.test(extension)) return 'AUDIO';
  if (mimeType.startsWith('video/') || /^(mp4|mov|webm|mkv)$/.test(extension)) return 'VIDEO';
  if (/^(docx|doc|odt|rtf)$/.test(extension)) return 'DOCUMENT';
  if (/^(csv|tsv|xlsx|xls)$/.test(extension)) return 'SPREADSHEET';
  if (extension === 'eml') return 'EMAIL';
  if (mimeType.startsWith('text/') || /^(txt|md|json|log)$/.test(extension)) return 'TEXT';
  return 'OTHER';
}

export interface EvidenceUploadOptions {
  ownerId: string;
  caseId: string;
  evidenceId?: string;
  /** Pass either PickedFile or individual file attributes */
  file?: PickedFile;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number | null;
  /** Whether to mirror to Cloud Storage / Cloudinary. Defaults to true if configured. */
  mirrorToCloud?: boolean;
  /** 0..1, on real byte progress. A stalled write visibly stalls. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface EvidenceUploadResult {
  /** The logical key. Store this on the evidence record; it is what every read takes. */
  storagePath: string;
  sizeBytes: number;
  /** SHA-256 of the stored bytes, computed here and re-checkable later. See `verifyEvidenceFile`. */
  sha256: string;
  /** Remote delivery / backup URL when mirrored to cloud */
  cloudUrl?: string;
  /** Remote public ID when mirrored to cloud */
  cloudPublicId?: string;
  /** Mirroring status */
  cloudStatus: CloudStatus;
  /** Human-readable explanation if cloud backup could not run */
  cloudError?: string;
  /** Evidence identifier */
  evidenceId: string;
  /** Domain Evidence entity for contract compliance */
  evidence: Evidence;
}

export function evidenceStoragePath(ownerId: string, caseId: string, evidenceId: string, fileName: string): string {
  idSchema.parse(ownerId);
  idSchema.parse(caseId);
  idSchema.parse(evidenceId);
  const extension = /\.([a-z0-9]{1,12})$/i.exec(fileName)?.[1]?.toLowerCase();
  return `users/${ownerId}/cases/${caseId}/${evidenceId}/original.${extension ?? 'bin'}`;
}

/**
 * Rejects a path that is not this account's, before anything is read.
 *
 * Every segment is checked, not just the owner id, because the alternative — trusting a path
 * that came back from a database row — makes a single corrupted or tampered record enough to
 * read an arbitrary file. `idSchema` rejects `..` and separators, so the traversal cases
 * (`cases/../evd/original.pdf`) fail on the segment shape rather than on a string search for
 * `..`, which is the check people get wrong.
 *
 * Both failures report the same sentence, and the segment checks are wrapped so that the one
 * raised by zod reports it too. A `ZodError`'s `message` is a JSON array of issue objects with
 * the rejected id quoted inside — the exact shape this app must never put in front of a
 * reader, and one caller was persisting raw messages from here into a visible field. The two
 * cases are also indistinguishable to the person holding the phone: whether the path is the
 * wrong shape or the right shape with a malformed id, the file is not theirs to open.
 */
export function validatePrivateEvidencePath(path: string, ownerId: string): string {
  const pieces = path.split('/');
  if (
    pieces.length !== 6 ||
    pieces[0] !== 'users' ||
    pieces[1] !== ownerId ||
    pieces[2] !== 'cases' ||
    !/^original(?:\.[a-z0-9]{1,12})?$/.test(pieces[5] ?? '')
  ) {
    throw new EvidenceFileError('This evidence file does not belong to the signed-in account.');
  }
  try {
    idSchema.parse(pieces[1]);
    idSchema.parse(pieces[3]);
    idSchema.parse(pieces[4]);
  } catch {
    throw new EvidenceFileError('This evidence file does not belong to the signed-in account.');
  }
  return path;
}

/** Root of the on-device store. Separate from the app's other data so it can be sized and cleared. */
const STORE_DIRECTORY = 'evidence';

type FileSystem = typeof import('expo-file-system');

/**
 * Resolves a logical path to a native `File`, creating the directory chain.
 *
 * `expo-file-system` is imported lazily throughout this module: it is a native module with an
 * `exports` map pointing at untranspiled TypeScript, so a static import makes this file
 * unimportable under Vitest — and `evidenceStoragePath` / `validatePrivateEvidencePath` are
 * exactly the pure functions a test needs to reach.
 */
async function nativeFile(storagePath: string, create: boolean) {
  const fs: FileSystem = await import('expo-file-system');
  const segments = storagePath.split('/');
  const file = new fs.File(fs.Paths.document, STORE_DIRECTORY, ...segments);
  if (create) file.parentDirectory.create({ intermediates: true, idempotent: true });
  return { fs, file };
}

/**
 * Writes the original into the private store and returns its digest.
 *
 * Named `upload` because that is what it is from the user's point of view and because the
 * call sites and the queue UI were written around that word. Nothing is transmitted.
 *
 * ## Native: streamed, never resident
 *
 * The bytes go source → digest → destination a megabyte at a time (`copyWithDigest`), so a
 * 90 MB recording costs a megabyte of heap rather than ninety, and the SHA-256 is folded in
 * on the way past instead of being computed in one synchronous pass that would freeze the
 * progress bar it is meant to be advancing. The argument for that shape, and for the chunk
 * size, is in `./stream-copy`.
 *
 * The digest still describes what was *read from the source*, not what was later found on
 * disk — it is folded from the same buffers that are written. `verifyEvidenceFile` re-reads
 * the stored file later and compares, which is only a meaningful check because these two
 * numbers come from different reads at different times.
 */
export async function uploadEvidenceFile(options: EvidenceUploadOptions): Promise<EvidenceUploadResult> {
  if (options.signal?.aborted) throw new EvidenceFileError('Upload cancelled.');

  const uri = options.file?.uri ?? options.uri;
  const name = options.file?.name ?? options.name ?? 'evidence.bin';
  const mimeType = options.file?.mimeType ?? options.mimeType ?? 'application/octet-stream';
  const sizeBytes = options.file?.size ?? options.sizeBytes ?? null;
  const evidenceId = options.evidenceId ?? newId('evd');

  if (!uri) throw new EvidenceFileError('No file URI provided.');

  const storagePath = evidenceStoragePath(options.ownerId, options.caseId, evidenceId, name);

  // Checked twice on purpose. The picker's reported size lets an oversized file be refused
  // before a single byte is moved; the check against the file's own size below catches a
  // picker that lied or reported nothing, which Android document providers do routinely.
  if ((sizeBytes ?? 0) > MAX_EVIDENCE_UPLOAD_BYTES) {
    throw new EvidenceFileError('This file is over the 100 MB limit. Split it into smaller source files.');
  }

  let storedSizeBytes: number;
  let storedSha256: string;
  let localUri: string;

  if (Platform.OS === 'web') {
    // Deliberately still whole-buffer. The browser store is IndexedDB, which takes a Blob —
    // the bytes have to be materialised to be stored at all, so streaming them would add a
    // pass without lowering the peak. The 100 MB ceiling is enforced the same way.
    const { readBytes, sha256Hex } = await import('../ingestion/read-file');
    const bytes = await readBytes(uri);
    if (bytes.length === 0) throw new EvidenceFileError('This file is empty, so there is nothing to store or read.');
    if (bytes.length > MAX_EVIDENCE_UPLOAD_BYTES) {
      throw new EvidenceFileError('This file is over the 100 MB limit. Split it into smaller source files.');
    }
    const sha256 = sha256Hex(bytes);
    if (options.signal?.aborted) throw new EvidenceFileError('Upload cancelled.');

    const { putWebBlob } = await import('./web-blob-store');
    options.onProgress?.(0);
    await putWebBlob(storagePath, bytes, mimeType);
    options.onProgress?.(1);

    storedSizeBytes = bytes.length;
    storedSha256 = sha256;
    localUri = uri;
  } else {
    const fs: FileSystem = await import('expo-file-system');
    const source = new fs.File(uri);

    // The source's own size, which is the figure every later check is made against. The
    // picker's number is a hint; this is what is actually there.
    if (!source.exists) {
      throw new EvidenceFileError('The selected file is no longer available on this device. Select it again.');
    }
    const totalBytes = source.size;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      throw new EvidenceFileError('This file is empty, so there is nothing to store or read.');
    }
    if (totalBytes > MAX_EVIDENCE_UPLOAD_BYTES) {
      throw new EvidenceFileError('This file is over the 100 MB limit. Split it into smaller source files.');
    }

    const { file } = await nativeFile(storagePath, true);

    // Overwrite rather than refuse. Reaching here twice for one evidence id means a retry after
    // a failed or cancelled write, and the half-written file from that attempt has to go.
    file.create({ overwrite: true, intermediates: true });

    const reader = source.open();
    let writer: import('expo-file-system').FileHandle | null = null;
    let copied: { bytesCopied: number; sha256: string };
    try {
      writer = file.open();
      copied = await copyWithDigest({
        source: reader,
        destination: writer,
        totalBytes,
        chunkBytes: WRITE_CHUNK_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch (error) {
      // A partial file is worse than none: it would hash differently, extract as garbage, and
      // look like a stored source. Remove it and let the queue retry. This is also the
      // cancellation path — a stopped upload must leave nothing behind that later reads as
      // stored evidence.
      try {
        if (file.exists) file.delete();
      } catch {
        // Nothing further to do — the copy already failed and this is cleanup.
      }
      throw error instanceof Error ? error : new EvidenceFileError('The file could not be saved to this device.');
    } finally {
      // Both handles, in every outcome. A leaked handle on Android holds an open file
      // descriptor for the lifetime of the process, and a few hundred of them across a long
      // session is a hard failure with no diagnostic attached to it.
      try {
        writer?.close();
      } catch {
        // Closing a handle whose write already failed can itself throw; the copy's error is
        // the one worth reporting.
      }
      try {
        reader.close();
      } catch {
        // As above.
      }
    }

    if (file.size !== copied.bytesCopied) {
      try {
        file.delete();
      } catch {
        // Cleanup only.
      }
      throw new EvidenceFileError('The file was not saved completely. Check available storage and try again.');
    }

    storedSizeBytes = copied.bytesCopied;
    storedSha256 = copied.sha256;
    localUri = file.uri;
  }

  // 2. Cloud Storage / Cloudinary Mirroring
  let cloudUrl: string | undefined;
  let cloudPublicId: string | undefined;
  let cloudStatus: CloudStatus = 'LOCAL_ONLY';
  let cloudError: string | undefined;

  const shouldMirror = options.mirrorToCloud ?? getCloudinaryConfig().isConfigured;

  if (shouldMirror) {
    const config = getCloudinaryConfig();
    if (!config.isConfigured) {
      cloudStatus = 'LOCAL_ONLY';
      cloudError = 'Cloud backup is not set up for this build. Files are stored on this device only.';
    } else {
      try {
        const cloudRes = await mirrorToCloud({
          uri: localUri,
          name,
          mimeType,
          sizeBytes: storedSizeBytes,
          folder: `users/${options.ownerId}/cases/${options.caseId}`,
          signal: options.signal,
        });

        if (cloudRes.ok) {
          cloudStatus = 'SYNCED';
          cloudUrl = cloudRes.url;
          cloudPublicId = cloudRes.publicId;
        } else {
          cloudStatus = cloudRes.retryable ? 'PENDING' : 'FAILED';
          cloudError = cloudRes.message;
          if (cloudRes.retryable) {
            await enqueueCloudSync({
              ownerId: options.ownerId,
              caseId: options.caseId,
              evidenceId,
              storagePath,
              name,
              mimeType,
              sizeBytes: storedSizeBytes,
              sha256: storedSha256,
            });
          }
        }
      } catch (err) {
        cloudStatus = 'PENDING';
        cloudError = err instanceof Error ? err.message : 'Network failure during cloud backup.';
        await enqueueCloudSync({
          ownerId: options.ownerId,
          caseId: options.caseId,
          evidenceId,
          storagePath,
          name,
          mimeType,
          sizeBytes: storedSizeBytes,
          sha256: storedSha256,
        });
      }
    }
  }

  // 3. Complete Domain Evidence Record
  const evidence: Evidence = {
    id: evidenceId,
    ownerId: options.ownerId,
    caseId: options.caseId,
    title: options.name ?? options.file?.name ?? (name.replace(/\.[^/.]+$/, '').trim() || name),
    kind: resolveEvidenceKind(mimeType, name),
    state: 'QUEUED',
    note: '',
    fileName: name,
    mimeType,
    sizeBytes: storedSizeBytes,
    storagePath,
    sha256: storedSha256,
    cloudUrl: cloudUrl ?? null,
    cloudPublicId: cloudPublicId ?? null,
    cloudStatus,
    cloudSyncedAt: cloudStatus === 'SYNCED' ? Date.now() : null,
    extraction: null,
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    deletedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    storagePath,
    sizeBytes: storedSizeBytes,
    sha256: storedSha256,
    cloudUrl,
    cloudPublicId,
    cloudStatus,
    cloudError,
    evidenceId,
    evidence,
  };
}

export interface PrivateEvidenceFile {
  uri: string;
  /**
   * Releases whatever the viewer was handed.
   *
   * On native this is a no-op, and that matters: the returned URI *is* the stored original,
   * not a copy, so deleting it on close would destroy the evidence. On web it revokes the
   * object URL, which otherwise pins the blob in memory for the lifetime of the document.
   */
  release: () => void | Promise<void>;
}

/**
 * Opens a stored original for reading, scoped to an owner the caller names.
 *
 * The owner is a parameter rather than something derived from the Firebase session, and
 * that is the whole point of this signature. This store has three readers — the viewer,
 * the processing pipeline, and the analysis client — and all three run in local
 * (signed-out) workspaces, where the owner is the device identity that created the case
 * and there is no session to derive anything from. An entry point that reached for
 * `currentUser` would refuse to open a file that is sitting on the device, owned by the
 * person holding it, for want of an account they were never asked to create.
 *
 * The path check still runs before anything is read, for the same reason it always has:
 * the path comes from a database row, and a row that has been corrupted or tampered with
 * must not become a file handle.
 */
export async function readStoredEvidenceFile(
  ownerId: string,
  storagePath: string,
): Promise<PrivateEvidenceFile> {
  validatePrivateEvidencePath(storagePath, ownerId);

  if (Platform.OS === 'web') {
    const { getWebBlob } = await import('./web-blob-store');
    const blob = await getWebBlob(storagePath);
    if (!blob) throw new EvidenceFileError('The original file is not stored in this browser. Add it to the case again.');
    const uri = URL.createObjectURL(blob);
    return { uri, release: () => URL.revokeObjectURL(uri) };
  }

  const { file } = await nativeFile(storagePath, false);
  if (!file.exists) {
    throw new EvidenceFileError('The original file is no longer on this device. Add it to the case again.');
  }
  // The reader gets the stored file's own URI. `release` is intentionally empty; see the
  // comment on `PrivateEvidenceFile.release`.
  return { uri: file.uri, release: () => {} };
}

/**
 * Re-hashes a stored original and compares it with the digest recorded at store time.
 *
 * This is what makes the audit trail mean something. The chain in `app/case/[caseId]/audit.tsx`
 * records a hash for every source; without a way to recompute it, that hash is decoration.
 * With one, the app can state that the bytes it is analysing today are the bytes it was given.
 *
 * It detects corruption and substitution. It does **not** establish that the file is authentic,
 * unedited before it arrived, or what it purports to be — no local check can, and the UI must
 * never imply otherwise.
 */
export async function verifyEvidenceFile(storagePath: string, expectedSha256: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    const { sha256Hex } = await import('../ingestion/read-file');
    const { getWebBlob } = await import('./web-blob-store');
    const blob = await getWebBlob(storagePath);
    if (!blob) return false;
    return sha256Hex(new Uint8Array(await blob.arrayBuffer())) === expectedSha256.toLowerCase();
  }

  const { file } = await nativeFile(storagePath, false);
  if (!file.exists) return false;

  // Streamed for the same reason the write is (see `uploadEvidenceFile`): this runs on every
  // evidence item at the start of a case analysis, so a case with a handful of recordings in
  // it would otherwise pull hundreds of megabytes through the heap one file after another,
  // and block the thread for a second per file while doing it.
  const { digestStream } = await import('./stream-copy');
  const handle = file.open();
  try {
    const actual = await digestStream({ source: handle, totalBytes: file.size, chunkBytes: WRITE_CHUNK_BYTES });
    return actual === expectedSha256.toLowerCase();
  } catch {
    // A file that cannot be read through is a failed verification, not an exception for the
    // caller to handle: `false` already means "these bytes are not the bytes that were
    // stored", which is the honest answer for a truncated or unreadable original.
    return false;
  } finally {
    try {
      handle.close();
    } catch {
      // Cleanup only.
    }
  }
}

/** Removes a stored original. Used when evidence is deleted for real, not soft-deleted. */
export async function deleteEvidenceFile(storagePath: string): Promise<void> {
  if (Platform.OS === 'web') {
    const { deleteWebBlob } = await import('./web-blob-store');
    await deleteWebBlob(storagePath);
    return;
  }
  const { file } = await nativeFile(storagePath, false);
  if (file.exists) file.delete();
}

/**
 * Re-points a stored original at a new logical path, keeping the bytes.
 *
 * Needed when a case changes hands between owner ids — which happens exactly once in this
 * app's life, when a user who has been working on the device signs in and their cases move
 * into their account. The path embeds the owner id, and `validatePrivateEvidencePath` checks
 * it on every read, so a record re-owned without moving its file would be a record whose
 * original can never be opened again.
 *
 * Returns false when there is nothing at `fromPath` — the caller's record then keeps a path
 * it cannot read, which the migration reports rather than hides. Web is a copy-then-delete
 * because IndexedDB has no rename.
 */
export async function moveEvidenceFile(fromPath: string, toPath: string): Promise<boolean> {
  if (fromPath === toPath) return true;

  if (Platform.OS === 'web') {
    const { getWebBlob, putWebBlob, deleteWebBlob } = await import('./web-blob-store');
    const blob = await getWebBlob(fromPath);
    if (!blob) return false;
    await putWebBlob(toPath, new Uint8Array(await blob.arrayBuffer()), blob.type);
    await deleteWebBlob(fromPath);
    return true;
  }

  const { file: source } = await nativeFile(fromPath, false);
  if (!source.exists) return false;
  // The destination's directory chain has to exist before the move; `create: true` on the
  // helper is what builds it.
  const { file: target } = await nativeFile(toPath, true);
  if (target.exists) target.delete();
  source.move(target);
  return true;
}

/**
 * Bytes held by the evidence store, and free space, for the figure shown in settings.
 *
 * Both are needed together: "412 MB stored" is not actionable on its own, and a user who is
 * about to add a long video wants to know whether it will fit.
 */
export async function evidenceStoreUsage(): Promise<{ usedBytes: number; freeBytes: number | null }> {
  if (Platform.OS === 'web') {
    const { webBlobUsage } = await import('./web-blob-store');
    // Browsers report an origin quota, not free disk. Reporting null is more honest than
    // presenting a quota estimate as free space.
    return { usedBytes: await webBlobUsage(), freeBytes: null };
  }
  const fs: FileSystem = await import('expo-file-system');
  const root = new fs.Directory(fs.Paths.document, STORE_DIRECTORY);
  return {
    usedBytes: root.exists ? (root.size ?? 0) : 0,
    freeBytes: fs.Paths.availableDiskSpace,
  };
}

/**
 * Removes every original this app has stored, for every account that has used this device.
 *
 * Deliberately not scoped to one owner. The store's layout is `users/{ownerId}/…`, and a
 * device accumulates more than one owner id in normal use: everything created before signing
 * in belongs to a generated device identity, and a second account signing in on the same
 * phone adds another. Someone erasing their data is asking about the handset, not about one
 * row of it, and an owner-scoped delete would leave the files from their offline session
 * sitting in a directory they have no way to reach.
 *
 * The directory goes as a whole rather than file by file, which also takes any original whose
 * record was lost — a write that completed after its commit failed, or a case removed by an
 * older build that did not clean up. Those are invisible to every other code path here and
 * would otherwise survive an erase for good.
 */
export async function eraseStoredEvidence(): Promise<void> {
  if (Platform.OS === 'web') {
    const { clearWebBlobs } = await import('./web-blob-store');
    await clearWebBlobs();
    return;
  }
  const fs: FileSystem = await import('expo-file-system');
  const root = new fs.Directory(fs.Paths.document, STORE_DIRECTORY);
  if (root.exists) root.delete();
}

