import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory backing store for AsyncStorage mock
const store = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(async () => {
      store.clear();
    }),
  },
}));

// Mock mirrorToCloud
vi.mock('../src/services/storage/cloudinary', () => ({
  getCloudinaryConfig: vi.fn(() => ({ isConfigured: true, cloudName: 'test', uploadPreset: 'test-preset' })),
  mirrorToCloud: vi.fn(async ({ uri }: { uri: string }) => {
    if (uri.includes('fail-network')) {
      return { ok: false, reason: 'NETWORK', message: 'Simulated network drop', retryable: true };
    }
    if (uri.includes('fail-fatal')) {
      return { ok: false, reason: 'REJECTED', message: 'Invalid asset format', retryable: false };
    }
    return {
      ok: true,
      url: 'https://res.cloudinary.com/test/image/upload/v1/users/user1/cases/case1/original.pdf',
      publicId: 'users/user1/cases/case1/original',
      resourceType: 'image',
      format: 'pdf',
      bytes: 1024,
    };
  }),
}));

// Mock readStoredEvidenceFile
vi.mock('../src/services/storage/evidence-storage', () => ({
  readStoredEvidenceFile: vi.fn(async (ownerId: string, path: string) => {
    if (path.includes('missing')) {
      throw new Error('File does not exist on disk');
    }
    return {
      uri: `file:///data/local/${path}`,
      release: vi.fn(async () => {}),
    };
  }),
}));

import {
  clearCloudSyncQueue,
  dequeueCloudSync,
  enqueueCloudSync,
  getPendingCloudSyncs,
  loadCloudSyncQueue,
  retryCloudSyncItem,
  syncPendingEvidenceUploads,
} from '../src/services/storage/cloud-sync-queue';

describe('CloudSyncQueue — Offline Resilience & Mirror Retries', () => {
  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
  });

  it('enqueues an evidence item and loads it from persistent storage', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
    });

    const queue = await loadCloudSyncQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.id).toBe('sync_evd_01');
    expect(queue[0]?.evidenceId).toBe('evd_01');
    expect(queue[0]?.status).toBe('PENDING');
    expect(queue[0]?.attempts).toBe(0);
  });

  it('updates an existing item without duplicating when re-enqueued', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
    });

    // Second enqueue for same evidenceId
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'Contract_Renamed.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
    });

    const queue = await loadCloudSyncQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.name).toBe('Contract_Renamed.pdf');
  });

  it('filters pending syncs by ownerId', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'File1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
    });
    await enqueueCloudSync({
      ownerId: 'usr_02',
      caseId: 'cse_02',
      evidenceId: 'evd_02',
      storagePath: 'users/usr_02/cases/cse_02/evd_02/original.pdf',
      name: 'File2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 200,
      sha256: 'b'.repeat(64),
    });

    const user1Pending = await getPendingCloudSyncs('usr_01');
    expect(user1Pending).toHaveLength(1);
    expect(user1Pending[0]?.evidenceId).toBe('evd_01');

    const allPending = await getPendingCloudSyncs();
    expect(allPending).toHaveLength(2);
  });

  it('dequeues an item successfully when mirror upload completes', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'File1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
    });

    await dequeueCloudSync('evd_01');
    const queue = await loadCloudSyncQueue();
    expect(queue).toHaveLength(0);
  });

  it('clears queue entries for a specific owner or entirely', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_01',
      storagePath: 'users/usr_01/cases/cse_01/evd_01/original.pdf',
      name: 'File1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
    });
    await enqueueCloudSync({
      ownerId: 'usr_02',
      caseId: 'cse_02',
      evidenceId: 'evd_02',
      storagePath: 'users/usr_02/cases/cse_02/evd_02/original.pdf',
      name: 'File2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 200,
      sha256: 'b'.repeat(64),
    });

    await clearCloudSyncQueue('usr_01');
    const remaining = await loadCloudSyncQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ownerId).toBe('usr_02');

    await clearCloudSyncQueue();
    expect(await loadCloudSyncQueue()).toHaveLength(0);
  });

  it('retries cloud sync successfully and removes item from queue', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_success',
      storagePath: 'users/usr_01/cases/cse_01/evd_success/original.pdf',
      name: 'File.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'c'.repeat(64),
    });

    const [item] = await getPendingCloudSyncs('usr_01');
    expect(item).toBeDefined();

    const res = await retryCloudSyncItem(item!);
    expect(res.ok).toBe(true);

    const pending = await getPendingCloudSyncs('usr_01');
    expect(pending).toHaveLength(0);
  });

  it('handles transient network error during retry cleanly without throwing', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_network_fail',
      storagePath: 'users/usr_01/cases/cse_01/fail-network/original.pdf',
      name: 'File.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'd'.repeat(64),
    });

    const [item] = await getPendingCloudSyncs('usr_01');
    expect(item).toBeDefined();

    const res = await retryCloudSyncItem(item!);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(true);
    }

    const queue = await loadCloudSyncQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.attempts).toBe(1);
    expect(queue[0]?.status).toBe('PENDING');
    expect(queue[0]?.lastError).toBe('Simulated network drop');
  });

  it('handles unreadable local file gracefully by marking item FAILED', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_missing_file',
      storagePath: 'users/usr_01/cases/cse_01/missing/original.pdf',
      name: 'File.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'e'.repeat(64),
    });

    const [item] = await getPendingCloudSyncs('usr_01');
    expect(item).toBeDefined();

    const res = await retryCloudSyncItem(item!);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(false);
    }

    const queue = await loadCloudSyncQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.status).toBe('FAILED');
    expect(queue[0]?.attempts).toBe(1);
  });

  it('syncPendingEvidenceUploads drains pending queue and reports counts', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_1',
      storagePath: 'users/usr_01/cases/cse_01/evd_1/original.pdf',
      name: 'File1.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 500,
      sha256: '1'.repeat(64),
    });
    await enqueueCloudSync({
      ownerId: 'usr_01',
      caseId: 'cse_01',
      evidenceId: 'evd_2',
      storagePath: 'users/usr_01/cases/cse_01/fail-network/original.pdf',
      name: 'File2.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 500,
      sha256: '2'.repeat(64),
    });

    const outcome = await syncPendingEvidenceUploads('usr_01');
    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toBe(1);

    const pending = await getPendingCloudSyncs('usr_01');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidenceId).toBe('evd_2');
  });
});
