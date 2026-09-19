/**
 * Cloud Sync Queue: Durable offline queue for retrying evidence file uploads.
 *
 * Persisted in AsyncStorage under `@detact:v1:cloud_sync_queue`.
 * Ensures evidence files captured or queued while offline or during transient network
 * drops are retried deterministically with exponential backoff awareness and zero
 * unhandled exceptions.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { mirrorToCloud, type CloudinaryUploadResult } from './cloudinary';
import { readStoredEvidenceFile } from './evidence-storage';

export const QUEUE_STORAGE_KEY = '@detact:v1:cloud_sync_queue';

export interface CloudSyncQueueItem {
  /** Unique queue identifier, e.g. `sync_${evidenceId}` */
  id: string;
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
  try {
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Non-throwing: storage pressure or transient failure must not crash callers
  }
}

export async function enqueueCloudSync(
  item: Omit<CloudSyncQueueItem, 'id' | 'attempts' | 'lastAttemptAt' | 'status'>,
): Promise<void> {
  const queue = await loadCloudSyncQueue();
  const id = `sync_${item.evidenceId}`;
  const existingIdx = queue.findIndex((q) => q.evidenceId === item.evidenceId);
  const existing = existingIdx >= 0 ? queue[existingIdx] : undefined;
  const queueItem: CloudSyncQueueItem = {
    ...item,
    id,
    attempts: existing ? existing.attempts : 0,
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

export async function clearCloudSyncQueue(ownerId?: string): Promise<void> {
  if (!ownerId) {
    await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
    return;
  }
  const queue = await loadCloudSyncQueue();
  const next = queue.filter((q) => q.ownerId !== ownerId);
  await saveCloudSyncQueue(next);
}

export async function retryCloudSyncItem(
  item: CloudSyncQueueItem,
  options?: { signal?: AbortSignal },
): Promise<CloudinaryUploadResult> {
  let file;
  try {
    file = await readStoredEvidenceFile(item.ownerId, item.storagePath);
  } catch (error) {
    // If local file no longer exists or cannot be read, mark FAILED
    const queue = await loadCloudSyncQueue();
    const idx = queue.findIndex((q) => q.evidenceId === item.evidenceId);
    const entry = idx >= 0 ? queue[idx] : undefined;
    if (entry) {
      entry.attempts += 1;
      entry.lastAttemptAt = Date.now();
      entry.lastError = error instanceof Error ? error.message : 'Stored file unreadable';
      entry.status = 'FAILED';
      await saveCloudSyncQueue(queue);
    }
    return {
      ok: false,
      reason: 'REJECTED',
      message: error instanceof Error ? error.message : 'Stored file unreadable',
      retryable: false,
    };
  }

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
      const entry = idx >= 0 ? queue[idx] : undefined;
      if (entry) {
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
        entry.lastError = res.message;
        entry.status = res.retryable ? 'PENDING' : 'FAILED';
        await saveCloudSyncQueue(queue);
      }
    }
    return res;
  } catch (err) {
    const queue = await loadCloudSyncQueue();
    const idx = queue.findIndex((q) => q.evidenceId === item.evidenceId);
    const message = err instanceof Error ? err.message : 'Network error during cloud backup retry';
    const entry = idx >= 0 ? queue[idx] : undefined;
    if (entry) {
      entry.attempts += 1;
      entry.lastAttemptAt = Date.now();
      entry.lastError = message;
      entry.status = 'PENDING';
      await saveCloudSyncQueue(queue);
    }
    return {
      ok: false,
      reason: 'NETWORK',
      message,
      retryable: true,
    };
  } finally {
    try {
      await file?.release();
    } catch {
      // Ignore release errors
    }
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
    if (res.ok) {
      succeeded++;
    } else {
      failed++;
    }
  }
  return { succeeded, failed };
}
