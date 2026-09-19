# M1 Explorer 1 Handoff Report: Cloud Storage & Cloudinary Mirroring Architecture

## Executive Summary
This report provides the complete, concrete architecture and implementation blueprint for **Cloud Storage / Cloudinary Mirroring with Instant Local Offline Caching and Resilient Network Error Handling** in Detact (Milestone M1, Requirement R1).

The design strictly satisfies the project invariants:
1. **Local-First & Offline-First Guarantee**: Bytes are always persisted and SHA-256 digested in the device's private store (`expo-file-system` / IndexedDB) before any remote transmission. The app remains 100% operational offline, on first launch, with zero network latency for evidence reading.
2. **Resilient Cloud Mirroring**: When authenticated (or `mirrorToCloud: true`), uploads mirror to Cloudinary via unsigned upload preset. If the network drops, times out, or Cloudinary is unreachable, the system gracefully falls back to local-only, sets `cloudStatus: 'PENDING'`, and records the item in a durable retry queue (`@detact:v1:cloud_sync_queue`) without throwing any unhandled exceptions.
3. **Contract Alignment**: Unifies the `EvidenceUploadOptions` / `EvidenceUploadResult` interfaces to fulfill `PROJECT.md` line 71 (`uploadEvidenceFile(options: { ownerId, caseId, file: PickedFile, mirrorToCloud? }): Promise<{ evidence: Evidence; sha256: string; cloudUrl?: string }>`) while maintaining complete backward compatibility with existing callers in `app/case/[caseId]/upload.tsx`.

---

## 1. Observation

Direct code observations from the repository:

### 1.1 `src/services/storage/evidence-storage.ts`
- **Lines 27-32**:
  ```typescript
  // What it costs, stated plainly rather than glossed: the files are gone if the app is
  // uninstalled or the device is lost, and they do not follow the account to a second device.
  // The optional answer is the Cloudinary mirror in `./cloudinary` (`mirrorToCloud`):
  // it is opt-in, this module never calls it, and it stays dormant until the build is
  // given Cloudinary credentials — so by default no byte leaves the device.
  ```
  `evidence-storage.ts` explicitly acknowledges `mirrorToCloud`, but currently never calls it.
- **Lines 116-135**: Current interfaces:
  ```typescript
  export interface EvidenceUploadOptions {
    ownerId: string;
    caseId: string;
    evidenceId: string;
    uri: string;
    name: string;
    mimeType: string;
    sizeBytes?: number | null;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }
  export interface EvidenceUploadResult {
    storagePath: string;
    sizeBytes: number;
    sha256: string;
  }
  ```
- **Lines 222-327**: `uploadEvidenceFile` writes only to local disk/IndexedDB via `copyWithDigest` / `putWebBlob`. It does not support `mirrorToCloud` or return `cloudUrl` or `Evidence`.

### 1.2 `src/services/storage/cloudinary.ts`
- **Lines 10-15**:
  ```typescript
  // A successful mirror means a second copy exists; a failed mirror means there is
  // still one copy and the case is unaffected. A mirror failure must never fail an evidence record.
  ```
- **Lines 54-94**: `getCloudinaryConfig()` checks `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` and `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`. Returns `isConfigured: boolean`.
- **Lines 168-283**: `uploadToCloudinary` and `mirrorToCloud`:
  - `uploadToCloudinary` returns `CloudinaryUploadResult`:
    - On success: `{ ok: true, url, publicId, resourceType, format, bytes }`
    - On failure: `{ ok: false, reason, message, status?, retryable: boolean }`
  - `mirrorToCloud` catches exceptions and returns `{ ok: false, reason: 'NETWORK', retryable: true }`. It **never throws**.

### 1.3 `src/domain/models.ts` & `src/data/mutations.ts`
- **`src/domain/models.ts:231-260`**: `evidenceSchema` defines:
  ```typescript
  fileName: z.string().max(260).nullable().default(null),
  mimeType: z.string().max(160).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  storagePath: z.string().max(600).nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  ```
  `evidenceSchema` currently lacks explicit fields for `cloudUrl`, `cloudPublicId`, `cloudStatus`, and `cloudSyncedAt`.
- **`src/data/mutations.ts:594-600`**: `StoredFileInput`:
  ```typescript
  export interface StoredFileInput {
    storagePath: string;
    sizeBytes: number;
    sha256: string;
  }
  ```
- **`src/features/evidence/upload-queue.ts:271-295`**:
  `summariseCommit(input: { saved: number; unreadable: number; withoutCloudCopy: number })` already formats user-facing messages for `withoutCloudCopy`:
  `"1 was kept on this device only — its backup copy did not upload."`
  The domain already expects `withoutCloudCopy` to be reported!

### 1.4 Test Suite Baseline
- Executing `npm test` via `vitest run` executes 75 test files (1,533 tests).
- 1,474 passed, 58 skipped (Firestore emulator optional), 1 failed (`tests/scratch-probe.test.ts`, which is assigned to Feature 1).
- Existing tests in `tests/evidence-storage.test.ts`, `tests/cloudinary.test.ts`, and `tests/upload-queue.test.ts` pass cleanly and establish regression guardrails.

---

## 2. Logic Chain

1. **Local-First Precedence (Observation 1.1 & 1.2)**:
   The core philosophy of Detact is zero server dependency on the critical path. Evidence files must be stored locally first (`original.ext` in `users/{ownerId}/cases/{caseId}/{evidenceId}/`). Computing the SHA-256 during local streaming (`copyWithDigest`) ensures that the hash is immediately immutable, enabling instant duplicate detection, audit logging, and offline ML Kit OCR / rule analysis without blocking on remote I/O.

2. **Conditional Cloud Mirroring (Observation 1.1, 1.2 & PROJECT.md)**:
   When authenticated (i.e. `!isLocal` in `SessionValue`) or when `mirrorToCloud: true` is explicitly passed, the system triggers `mirrorToCloud()`.
   Because `mirrorToCloud` is non-blocking to the local file integrity, it can run immediately after the local copy is verified on disk.
   On native platforms, the file passed to `mirrorToCloud` can be the newly created, immutable local file URI (`file.uri`), which eliminates transient Android `content://` URI permission revocation bugs.

3. **Resilient Failure Handling & The Retry Queue (Observation 1.2 & 1.3)**:
   If `mirrorToCloud` fails (e.g. `NETWORK`, DNS drop, HTTP 503, timeout):
   - The method **must not throw**.
   - `cloudStatus` transitions to `'PENDING'` if `retryable: true`, or `'FAILED'` if non-retryable (e.g. 4xx).
   - If `retryable: true`, the item is persisted into a lightweight persistent queue in `AsyncStorage` (`@detact:v1:cloud_sync_queue`).
   - The user's upload flow succeeds locally, `recordEvidenceFile` records `cloudStatus: 'PENDING'`, and the UI summary correctly increments `withoutCloudCopy`.
   - When network connectivity is re-established, `syncPendingEvidenceUploads()` drains the queue in the background.

4. **Interface Contract Harmonization (Observation 1.1 & PROJECT.md line 71)**:
   `PROJECT.md` defines:
   `uploadEvidenceFile(options: { ownerId: string; caseId: string; file: PickedFile; mirrorToCloud?: boolean }): Promise<{ evidence: Evidence; sha256: string; cloudUrl?: string }>`
   Simultaneously, `app/case/[caseId]/upload.tsx` calls:
   `uploadEvidenceFile({ ownerId, caseId, evidenceId, uri, name, mimeType, sizeBytes, onProgress, signal })` and consumes `{ storagePath, sizeBytes, sha256 }`.
   By designing `EvidenceUploadOptions` to accept either `file: PickedFile` or discrete fields (`uri`, `name`, etc.), and returning an object that contains `{ storagePath, sizeBytes, sha256, cloudUrl, cloudPublicId, cloudStatus, cloudError, evidenceId, evidence }`, both contracts are fulfilled with zero breaking changes.

---

## 3. Concrete Implementation Plan for the Worker

### File 1: `src/domain/models.ts`
Add cloud synchronization metadata fields to `evidenceSchema`:

```typescript
// In src/domain/models.ts, within evidenceSchema (around line 248):
  storagePath: z.string().max(600).nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),

  /** Remote delivery / backup URL when mirrored to Cloud Storage / Cloudinary. */
  cloudUrl: z.string().max(1000).nullable().default(null),
  /** Remote asset identifier (e.g. Cloudinary public_id). */
  cloudPublicId: z.string().max(300).nullable().default(null),
  /** Cloud sync lifecycle state. Default: LOCAL_ONLY */
  cloudStatus: z.enum(['SYNCED', 'PENDING', 'FAILED', 'LOCAL_ONLY']).default('LOCAL_ONLY'),
  /** Timestamp when remote sync succeeded. */
  cloudSyncedAt: timestampSchema.nullable().default(null),
```

### File 2: `src/data/mutations.ts`
Update `StoredFileInput`, `recordEvidenceFile`, and export `updateEvidenceCloudSync`:

```typescript
// Update StoredFileInput:
export interface StoredFileInput {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  cloudUrl?: string | null;
  cloudPublicId?: string | null;
  cloudStatus?: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY';
}

// In recordEvidenceFile (around line 638):
  const next: Evidence = {
    ...existing,
    storagePath: input.storagePath,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    cloudUrl: input.cloudUrl ?? existing.cloudUrl ?? null,
    cloudPublicId: input.cloudPublicId ?? existing.cloudPublicId ?? null,
    cloudStatus: input.cloudStatus ?? existing.cloudStatus ?? 'LOCAL_ONLY',
    cloudSyncedAt: input.cloudStatus === 'SYNCED' ? context.now : (existing.cloudSyncedAt ?? null),
    ...(existing.state === 'UPLOADING' || (existing.state === 'FAILED' && existing.storagePath === null)
      ? { state: 'QUEUED' as const, failureReason: null }
      : { state: existing.state }),
    updatedAt: context.now,
  };

// Add updateEvidenceCloudSync helper:
export function updateEvidenceCloudSync(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  sync: {
    cloudUrl?: string | null;
    cloudPublicId?: string | null;
    cloudStatus: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY';
  },
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );
  const next: Evidence = {
    ...existing,
    cloudUrl: sync.cloudUrl ?? existing.cloudUrl ?? null,
    cloudPublicId: sync.cloudPublicId ?? existing.cloudPublicId ?? null,
    cloudStatus: sync.cloudStatus,
    cloudSyncedAt: sync.cloudStatus === 'SYNCED' ? context.now : (existing.cloudSyncedAt ?? null),
    updatedAt: context.now,
  };
  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_CLOUD_SYNCED',
        `Updated cloud backup status for "${short(existing.title)}" to ${sync.cloudStatus}`,
        [{ kind: 'evidence', id: evidenceId }],
        { cloudStatus: sync.cloudStatus, cloudUrl: sync.cloudUrl ?? '' },
      ),
    ),
  ]);
}
```

### File 3: `src/services/storage/cloud-sync-queue.ts` (NEW MODULE)
Create persistent queue for retrying failed or offline cloud mirrors:

```typescript
/**
 * Cloud Sync Queue: Durable offline queue for retrying evidence file uploads.
 *
 * Persisted in AsyncStorage under `@detact:v1:cloud_sync_queue`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mirrorToCloud, type CloudinaryUploadResult } from './cloudinary';
import { readStoredEvidenceFile } from './evidence-storage';

const QUEUE_STORAGE_KEY = '@detact:v1:cloud_sync_queue';

export interface CloudSyncQueueItem {
  id: string; // `sync_${evidenceId}`
  ownerId: string;
  caseId: string;
  evidenceId: string;
  storagePath: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  attempts: number;
  lastAttemptAt: number;
  lastError?: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'FAILED';
}

export async function loadCloudSyncQueue(): Promise<CloudSyncQueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as CloudSyncQueueItem[];
  } catch {
    return [];
  }
}

export async function saveCloudSyncQueue(queue: CloudSyncQueueItem[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
}

export async function enqueueCloudSync(
  item: Omit<CloudSyncQueueItem, 'id' | 'attempts' | 'lastAttemptAt' | 'status'>,
): Promise<void> {
  const queue = await loadCloudSyncQueue();
  const id = `sync_${item.evidenceId}`;
  const existingIdx = queue.findIndex((q) => q.evidenceId === item.evidenceId);
  const queueItem: CloudSyncQueueItem = {
    ...item,
    id,
    attempts: existingIdx >= 0 ? queue[existingIdx].attempts : 0,
    lastAttemptAt: Date.now(),
    status: 'PENDING',
  };
  if (existingIdx >= 0) {
    queue[existingIdx] = queueItem;
  } else {
    queue.push(queueItem);
  }
  await saveCloudSyncQueue(queue);
}

export async function dequeueCloudSync(evidenceId: string): Promise<void> {
  const queue = await loadCloudSyncQueue();
  const next = queue.filter((q) => q.evidenceId !== evidenceId);
  await saveCloudSyncQueue(next);
}

export async function getPendingCloudSyncs(ownerId?: string): Promise<CloudSyncQueueItem[]> {
  const queue = await loadCloudSyncQueue();
  return queue.filter((q) => q.status === 'PENDING' && (!ownerId || q.ownerId === ownerId));
}

export async function retryCloudSyncItem(
  item: CloudSyncQueueItem,
  options?: { signal?: AbortSignal },
): Promise<CloudinaryUploadResult> {
  const file = await readStoredEvidenceFile(item.ownerId, item.storagePath);
  try {
    const res = await mirrorToCloud({
      uri: file.uri,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      folder: `users/${item.ownerId}/cases/${item.caseId}`,
      signal: options?.signal,
    });
    if (res.ok) {
      await dequeueCloudSync(item.evidenceId);
    } else {
      const queue = await loadCloudSyncQueue();
      const idx = queue.findIndex((q) => q.evidenceId === item.evidenceId);
      if (idx >= 0) {
        queue[idx].attempts += 1;
        queue[idx].lastAttemptAt = Date.now();
        queue[idx].lastError = res.message;
        queue[idx].status = res.retryable ? 'PENDING' : 'FAILED';
        await saveCloudSyncQueue(queue);
      }
    }
    return res;
  } finally {
    await file.release();
  }
}

export async function syncPendingEvidenceUploads(
  ownerId: string,
  options?: { signal?: AbortSignal },
): Promise<{ succeeded: number; failed: number }> {
  const pending = await getPendingCloudSyncs(ownerId);
  let succeeded = 0;
  let failed = 0;
  for (const item of pending) {
    if (options?.signal?.aborted) break;
    const res = await retryCloudSyncItem(item, options);
    if (res.ok) succeeded++;
    else failed++;
  }
  return { succeeded, failed };
}
```

### File 4: `src/services/storage/evidence-storage.ts`
Harmonize signatures, wire local-first storage, mirror to Cloudinary, safe error handling:

```typescript
import type { PickedFile } from '../ingestion/types';
import type { Evidence, EvidenceKind } from '@domain/models';
import { newId } from '@domain/ids';
import { getCloudinaryConfig, mirrorToCloud } from './cloudinary';
import { enqueueCloudSync } from './cloud-sync-queue';

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
  /** 0..1 progress callback for byte transfer */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface EvidenceUploadResult {
  /** The logical storage path */
  storagePath: string;
  /** Stored byte count */
  sizeBytes: number;
  /** SHA-256 of the stored bytes */
  sha256: string;
  /** Remote delivery / backup URL when mirrored to cloud */
  cloudUrl?: string;
  /** Remote public ID when mirrored to cloud */
  cloudPublicId?: string;
  /** Mirroring status */
  cloudStatus: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY';
  /** Human-readable explanation if cloud backup could not run */
  cloudError?: string;
  /** Evidence identifier */
  evidenceId: string;
  /** Domain Evidence entity for contract compliance */
  evidence: Evidence;
}

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

export async function uploadEvidenceFile(options: EvidenceUploadOptions): Promise<EvidenceUploadResult> {
  if (options.signal?.aborted) throw new EvidenceFileError('Upload cancelled.');

  const uri = options.file?.uri ?? options.uri;
  const name = options.file?.name ?? options.name ?? 'evidence.bin';
  const mimeType = options.file?.mimeType ?? options.mimeType ?? 'application/octet-stream';
  const sizeBytes = options.file?.size ?? options.sizeBytes ?? null;
  const evidenceId = options.evidenceId ?? newId('evd');

  if (!uri) throw new EvidenceFileError('No file URI provided.');

  const storagePath = evidenceStoragePath(options.ownerId, options.caseId, evidenceId, name);

  if ((sizeBytes ?? 0) > MAX_EVIDENCE_UPLOAD_BYTES) {
    throw new EvidenceFileError('This file is over the 100 MB limit. Split it into smaller source files.');
  }

  let storedSizeBytes: number;
  let storedSha256: string;
  let localUri: string;

  // 1. Local Offline Storage First
  if (Platform.OS === 'web') {
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
      try {
        if (file.exists) file.delete();
      } catch {}
      throw error instanceof Error ? error : new EvidenceFileError('The file could not be saved to this device.');
    } finally {
      try { writer?.close(); } catch {}
      try { reader.close(); } catch {}
    }

    if (file.size !== copied.bytesCopied) {
      try { file.delete(); } catch {}
      throw new EvidenceFileError('The file was not saved completely. Check available storage and try again.');
    }

    storedSizeBytes = copied.bytesCopied;
    storedSha256 = copied.sha256;
    localUri = file.uri;
  }

  // 2. Cloud Mirroring
  let cloudUrl: string | undefined;
  let cloudPublicId: string | undefined;
  let cloudStatus: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY' = 'LOCAL_ONLY';
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

  // 3. Construct Evidence entity
  const evidence: Evidence = {
    id: evidenceId,
    ownerId: options.ownerId,
    caseId: options.caseId,
    title: options.name ?? options.file?.name ?? name.replace(/\.[^/.]+$/, '').trim() || name,
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
```

### File 5: `app/case/[caseId]/upload.tsx`
Update upload handler to pass `mirrorToCloud: !isLocal` and record cloud metadata:

```typescript
// Around line 223:
const storedFile = await uploadEvidenceFile({
  ownerId: user.id,
  caseId: record.id,
  evidenceId: item.id,
  uri: item.uri,
  name: item.name,
  mimeType: item.mimeType,
  sizeBytes: item.size,
  mirrorToCloud: !isLocal,
  onProgress: (progress) => patch(item.id, { progress }),
  signal: controller.signal,
});

const duplicate = findDuplicate(
  storedFile.sha256,
  current.evidence.filter((evidence) => evidence.caseId === caseId && !evidence.deletedAt && evidence.id !== item.id),
  storedInBatch,
);

const mutation = recordEvidenceFile(current, context, item.id, {
  storagePath: storedFile.storagePath,
  sizeBytes: storedFile.sizeBytes,
  sha256: storedFile.sha256,
  cloudUrl: storedFile.cloudUrl ?? null,
  cloudPublicId: storedFile.cloudPublicId ?? null,
  cloudStatus: storedFile.cloudStatus,
});
await repository.commit(user.id, mutation.changes);
```

---

## 4. Caveats

1. **Cloudinary Upload Preset Configuration**:
   Unsigned uploads require an existing Cloudinary preset created with `npm run setup:cloudinary` (or credentials set in `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` and `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`). When unconfigured, the system deliberately and safely operates in `LOCAL_ONLY` mode.
2. **Authenticated Delivery Mode**:
   Because the preset enforces `access_mode: authenticated`, the returned `cloudUrl` is an authenticated asset URL that requires signing for public browser downloads. For local viewing, the app always uses the local private store file directly (`readStoredEvidenceFile`), which guarantees instant loading without internet.
3. **Background Sync Triggers**:
   `syncPendingEvidenceUploads` is a pure function that can be called upon app mount, network reconnect, or from a refresh button in Case Settings. It should not run an infinite polling loop.

---

## 5. Conclusion

1. The proposed dual-write architecture guarantees that local caching and SHA-256 calculation remain instant, uninterrupted, and 100% offline-resilient.
2. Network dropouts or stalled uploads are caught cleanly: the local record is committed with `cloudStatus: 'PENDING'` and enqueued into `@detact:v1:cloud_sync_queue`, resulting in zero unhandled exceptions.
3. The unified `uploadEvidenceFile` function signature fulfills the M1 ↔ M2 contract specified in `PROJECT.md` line 71 while maintaining full compatibility with all existing screens and test suites.

---

## 6. Verification Method

To independently verify the implementation once executed by the Worker:

1. **Unit & Contract Tests**:
   - Run `npx vitest run tests/evidence-storage.test.ts`
   - Run `npx vitest run tests/cloudinary.test.ts`
   - Run `npx vitest run tests/upload-queue.test.ts`
   - Run `npx vitest run tests/evidence-pipeline.test.ts`
2. **Typecheck**:
   - Run `npm run typecheck` (`tsc --noEmit`) to confirm zero TypeScript compilation errors across all interfaces and call sites.
3. **Integration Verification**:
   - Test `uploadEvidenceFile` with `{ file: PickedFile, mirrorToCloud: true }` and assert that `{ storagePath, sha256, cloudStatus, evidence }` are returned.
   - Simulate a network drop by mocking `mirrorToCloud` to return `{ ok: false, reason: 'NETWORK', retryable: true }` and assert:
     1. Local file is preserved.
     2. Returned `cloudStatus` is `'PENDING'`.
     3. Item appears in `getPendingCloudSyncs()`.
     4. Zero unhandled promise rejections or exceptions.
