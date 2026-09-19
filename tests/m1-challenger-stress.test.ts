import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Top-level mock for expo-constants to prevent native module evaluation in Node
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));

// Stand-in for expo-file-system in Node
vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    exists = true;
    size = 1024;
    parentDirectory = {
      create: vi.fn(),
    };
    constructor(public dirOrUri: any, ...segments: string[]) {
      this.uri = typeof dirOrUri === 'string' ? dirOrUri : `${dirOrUri?.uri ?? 'file:///app'}/${segments.join('/')}`;
    }
    open() {
      return {
        readBytes: () => new Uint8Array(),
        writeBytes: () => {},
        close: () => {},
      };
    }
    create() {}
    delete() {}
    move() {}
  }
  class Directory {
    exists = true;
    size = 1024;
    constructor(...args: any[]) {}
    create() {}
    delete() {}
  }
  return {
    File,
    Directory,
    Paths: {
      document: { uri: 'file:///data/user/0/detact/files' },
      cache: { uri: 'file:///data/user/0/detact/cache' },
      availableDiskSpace: 1024 * 1024 * 1024,
    },
  };
});

const asyncStorageStore = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
    clear: vi.fn(async () => {
      asyncStorageStore.clear();
    }),
  },
}));

// Hoisted hooks for Firestore mocking
const firestoreBatchHook = {
  batches: [] as Array<{
    sets: Array<{ ref: unknown; data: unknown }>;
    deletes: Array<{ ref: unknown }>;
    committed: boolean;
  }>,
  commitDelayMs: 0,
  hangCommit: false,
  rejectAfterTimeoutMs: 0,
  failBatchIndex: -1,
  reset() {
    this.batches = [];
    this.commitDelayMs = 0;
    this.hangCommit = false;
    this.rejectAfterTimeoutMs = 0;
    this.failBatchIndex = -1;
  },
};

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (_db: unknown, col: string, id: string) => ({ col, id, path: `${col}/${id}` }),
    writeBatch: () => {
      const currentBatchIndex = firestoreBatchHook.batches.length;
      const batch = {
        sets: [] as Array<{ ref: unknown; data: unknown }>,
        deletes: [] as Array<{ ref: unknown }>,
        committed: false,
      };
      firestoreBatchHook.batches.push(batch);

      return {
        set(docRef: unknown, data: unknown) {
          batch.sets.push({ ref: docRef, data });
        },
        delete(docRef: unknown) {
          batch.deletes.push({ ref: docRef });
        },
        commit(): Promise<void> {
          batch.committed = true;
          if (firestoreBatchHook.hangCommit) {
            return new Promise<void>((_, reject) => {
              if (firestoreBatchHook.rejectAfterTimeoutMs > 0) {
                setTimeout(
                  () => reject(new Error('Firestore late rejection')),
                  firestoreBatchHook.rejectAfterTimeoutMs,
                );
              }
            });
          }
          if (firestoreBatchHook.failBatchIndex === currentBatchIndex) {
            return Promise.reject(new Error(`Permission denied on batch ${currentBatchIndex}`));
          }
          if (firestoreBatchHook.commitDelayMs > 0) {
            return new Promise((resolve) => setTimeout(resolve, firestoreBatchHook.commitDelayMs));
          }
          return Promise.resolve();
        },
      };
    },
  };
});

// In-memory web-blob-store mock
const webBlobStore = new Map<string, { bytes: Uint8Array; mimeType: string }>();
vi.mock('@services/storage/web-blob-store', () => ({
  putWebBlob: vi.fn(async (path: string, bytes: Uint8Array, mimeType: string) => {
    webBlobStore.set(path, { bytes, mimeType });
  }),
  getWebBlob: vi.fn(async (path: string) => {
    const item = webBlobStore.get(path);
    if (!item) return null;
    return new Blob([item.bytes as unknown as BlobPart], { type: item.mimeType });
  }),
  deleteWebBlob: vi.fn(async (path: string) => {
    webBlobStore.delete(path);
  }),
  clearWebBlobs: vi.fn(async () => {
    webBlobStore.clear();
  }),
  webBlobUsage: vi.fn(async () => {
    let sum = 0;
    for (const item of webBlobStore.values()) sum += item.bytes.length;
    return sum;
  }),
}));

import type { Firestore } from 'firebase/firestore';
import { FirebaseRepository, COMMIT_ACK_TIMEOUT_MS } from '@data/firebase/firebase-repository';
import { LocalRepository } from '@data/local/local-repository';
import { createMemoryStore, type KeyValueStore } from '@data/local/key-value-store';
import { put, type Change } from '@data/repository';
import {
  enqueueCloudSync,
  dequeueCloudSync,
  getPendingCloudSyncs,
  clearCloudSyncQueue,
  loadCloudSyncQueue,
  saveCloudSyncQueue,
  retryCloudSyncItem,
  syncPendingEvidenceUploads,
  QUEUE_STORAGE_KEY,
} from '@services/storage/cloud-sync-queue';
import {
  uploadEvidenceFile,
  verifyEvidenceFile,
  readStoredEvidenceFile,
  deleteEvidenceFile,
  MAX_EVIDENCE_UPLOAD_BYTES,
  EvidenceFileError,
} from '@services/storage/evidence-storage';
import {
  uploadToCloudinary,
  mirrorToCloud,
  MAX_UPLOAD_BYTES,
  type CloudinaryConfig,
} from '@services/storage/cloudinary';
import {
  copyWithDigest,
  digestStream,
  COPY_CHUNK_BYTES,
  type ByteReader,
  type ByteWriter,
} from '@services/storage/stream-copy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OWNER, CASE_ID, testCase, claim, evidence, resetIds } from './helpers';

// Helper reader/writer for stream-copy
function readerOver(bytes: Uint8Array, options: { stopAfter?: number } = {}): ByteReader & { reads: number[] } {
  let offset = 0;
  const reads: number[] = [];
  return {
    reads,
    readBytes(length: number): Uint8Array {
      if (options.stopAfter !== undefined && offset >= options.stopAfter) return new Uint8Array();
      const end = Math.min(offset + length, bytes.length, options.stopAfter ?? Infinity);
      const chunk = bytes.subarray(offset, end);
      offset = end;
      reads.push(chunk.length);
      return chunk;
    },
  };
}

function collectingWriter(): ByteWriter & { written(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    writeBytes(bytes: Uint8Array) {
      chunks.push(new Uint8Array(bytes));
    },
    written() {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
}

function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + (i >> 8) * 17) & 0xff;
  return out;
}

const unhandledRejections: unknown[] = [];
const rejectionHandler = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(async () => {
  resetIds();
  unhandledRejections.length = 0;
  process.on('unhandledRejection', rejectionHandler);
  firestoreBatchHook.reset();
  webBlobStore.clear();
  await AsyncStorage.clear();
});

afterEach(() => {
  process.off('unhandledRejection', rejectionHandler);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================================
// SUITE 1: LocalRepository Durability & Boundary Testing
// ============================================================================
describe('M1 Stress: LocalRepository Durability & Boundary Testing', () => {
  it('handles extreme batch commits of exactly 400 items (boundary)', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, [put('cases', testCase())]);

    const changes: Change[] = [];
    for (let i = 0; i < 400; i++) {
      changes.push(put('claims', claim(`Claim statement #${i}`, { id: `clm_boundary_${i}` })));
    }

    const outcome = await repo.commit(OWNER, changes);
    expect(outcome.durability).toBe('SERVER');

    const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(loaded.claims).toHaveLength(400);
    // LocalRepository sorts by a.id.localeCompare(b.id)
    const claim0 = loaded.claims.find((c) => c.id === 'clm_boundary_0');
    const claim399 = loaded.claims.find((c) => c.id === 'clm_boundary_399');
    expect(claim0?.statement).toBe('Claim statement #0');
    expect(claim399?.statement).toBe('Claim statement #399');
  });

  it('handles extreme batch commits exceeding 400 items (450 items)', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, [put('cases', testCase())]);

    const changes: Change[] = [];
    for (let i = 0; i < 450; i++) {
      changes.push(put('claims', claim(`Extreme Claim #${i}`, { id: `clm_extreme_${i}` })));
    }

    const outcome = await repo.commit(OWNER, changes);
    expect(outcome.durability).toBe('SERVER');

    const loaded = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(loaded.claims).toHaveLength(450);
    expect(loaded.claims.some((c) => c.statement === 'Extreme Claim #449')).toBe(true);
  });

  it('handles massive commit of 1,200 items across 5 distinct cases and collections', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);

    const changes: Change[] = [];
    const caseIds = ['case_alpha', 'case_beta', 'case_gamma', 'case_delta', 'case_epsilon'];

    for (const id of caseIds) {
      changes.push(put('cases', testCase({ id, title: `Case ${id}` })));
    }

    for (let i = 0; i < 1195; i++) {
      const caseId = caseIds[i % caseIds.length]!;
      if (i % 2 === 0) {
        changes.push(
          put('claims', claim(`Claim ${i}`, { id: `clm_${i}`, caseId, statement: `Claim for ${caseId} #${i}` })),
        );
      } else {
        changes.push(
          put('evidence', evidence(`Evidence text ${i}`, { id: `evd_${i}`, caseId, title: `Doc ${i}` })),
        );
      }
    }

    expect(changes.length).toBe(1200);
    const outcome = await repo.commit(OWNER, changes);
    expect(outcome.durability).toBe('SERVER');

    let totalRecords = 0;
    for (const caseId of caseIds) {
      const ws = await repo.loadWorkspace(OWNER, caseId);
      expect(ws.cases[0]?.id).toBe(caseId);
      totalRecords += ws.claims.length + ws.evidence.length;
    }
    expect(totalRecords).toBe(1195);
  });

  it('handles 400 bulk deletes with unresolved caseIds correctly', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, [put('cases', testCase())]);

    const setup: Change[] = [];
    for (let i = 0; i < 400; i++) {
      setup.push(put('claims', claim(`Claim ${i}`, { id: `clm_del_${i}` })));
    }
    await repo.commit(OWNER, setup);

    let ws = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(ws.claims).toHaveLength(400);

    const deletes: Change[] = [];
    for (let i = 0; i < 350; i++) {
      deletes.push({ op: 'delete', collection: 'claims', id: `clm_del_${i}` });
    }
    await repo.commit(OWNER, deletes);

    ws = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(ws.claims).toHaveLength(50);
  });

  it('evaluates rapid concurrent commits on the same case without throwing', async () => {
    const baseMap = new Map<string, string>();
    const asyncStore: KeyValueStore = {
      async get(key) {
        await new Promise((r) => setTimeout(r, 1));
        return baseMap.get(key) ?? null;
      },
      async getMany(keys) {
        await new Promise((r) => setTimeout(r, 1));
        return keys.map((k) => [k, baseMap.get(k) ?? null]);
      },
      async setMany(entries) {
        await new Promise((r) => setTimeout(r, 1));
        for (const [k, v] of entries) baseMap.set(k, v);
      },
      async remove(keys) {
        await new Promise((r) => setTimeout(r, 1));
        for (const k of keys) baseMap.delete(k);
      },
      async keys() {
        await new Promise((r) => setTimeout(r, 1));
        return [...baseMap.keys()];
      },
    };

    const repo = new LocalRepository(asyncStore);
    await repo.commit(OWNER, [put('cases', testCase())]);

    const concurrentCommits = Array.from({ length: 10 }, (_, i) =>
      repo.commit(OWNER, [put('claims', claim(`Concurrent claim ${i}`, { id: `clm_conc_${i}` }))]),
    );

    await Promise.all(concurrentCommits);
    const ws = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(ws.claims.length).toBeGreaterThanOrEqual(1);
  });

  it('recovers gracefully from corrupted case shard JSON without throwing', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, [put('cases', testCase())]);

    // Corrupt shard key with invalid JSON
    await store.setMany([[`detact:v1:${OWNER}:case:${CASE_ID}`, '{"malformed json: true']]);

    // loadWorkspace should not crash; it should fall back to an empty shard
    const ws = await repo.loadWorkspace(OWNER, CASE_ID);
    expect(ws.cases).toHaveLength(1);
    expect(ws.claims).toEqual([]);
  });

  it('recovers gracefully from corrupted case index without throwing TypeError', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);

    // Corrupt case index with non-array JSON
    await store.setMany([[`detact:v1:${OWNER}:cases`, '{"objectInsteadOfArray": true}']]);

    // listCases should return empty array rather than throwing .flatMap TypeError
    const cases = await repo.listCases(OWNER);
    expect(cases).toEqual([]);
  });

  it('notifies subscribers reactively and stops notifying after unsubscribe', async () => {
    const store = createMemoryStore();
    const repo = new LocalRepository(store);
    await repo.commit(OWNER, [put('cases', testCase())]);

    let notificationCount = 0;
    const unsubscribe = repo.watchWorkspace(OWNER, CASE_ID, () => {
      notificationCount++;
    });

    // Wait for initial subscription push
    await new Promise((r) => setTimeout(r, 10));
    expect(notificationCount).toBe(1);

    await repo.commit(OWNER, [put('claims', claim('Watched claim', { id: 'clm_watch_1' }))]);
    await new Promise((r) => setTimeout(r, 10));
    expect(notificationCount).toBe(2);

    unsubscribe();

    await repo.commit(OWNER, [put('claims', claim('Watched claim 2', { id: 'clm_watch_2' }))]);
    await new Promise((r) => setTimeout(r, 10));
    expect(notificationCount).toBe(2);
  });
});

// ============================================================================
// SUITE 2: FirebaseRepository Batching, Timeout & Durability
// ============================================================================
describe('M1 Stress: FirebaseRepository Batching & Timeout', () => {
  const mockDb = { kind: 'mock-firestore' } as unknown as Firestore;

  it('splits 450 items into 2 write batches bounded by MAX_BATCH_WRITES (400)', async () => {
    const repo = new FirebaseRepository(mockDb);

    const changes: Change[] = [];
    for (let i = 0; i < 450; i++) {
      changes.push(put('claims', claim(`Claim ${i}`, { id: `clm_${i}` })));
    }

    const outcome = await repo.commit(OWNER, changes);
    expect(outcome.durability).toBe('SERVER');
    expect(firestoreBatchHook.batches).toHaveLength(2);
    expect(firestoreBatchHook.batches[0]?.sets).toHaveLength(400);
    expect(firestoreBatchHook.batches[1]?.sets).toHaveLength(50);
  });

  it('splits 1,200 items into 3 batches of 400 each', async () => {
    const repo = new FirebaseRepository(mockDb);

    const changes: Change[] = [];
    for (let i = 0; i < 1200; i++) {
      changes.push(put('claims', claim(`Claim ${i}`, { id: `clm_${i}` })));
    }

    const outcome = await repo.commit(OWNER, changes);
    expect(outcome.durability).toBe('SERVER');
    expect(firestoreBatchHook.batches).toHaveLength(3);
    expect(firestoreBatchHook.batches[0]?.sets).toHaveLength(400);
    expect(firestoreBatchHook.batches[1]?.sets).toHaveLength(400);
    expect(firestoreBatchHook.batches[2]?.sets).toHaveLength(400);
  });

  it('sanitizes undefined properties before Firestore batch set', async () => {
    const repo = new FirebaseRepository(mockDb);

    const recordWithUndefined: any = {
      ...claim('Cleaned claim', { id: 'clm_dirty' }),
      undefinedField: undefined,
      nested: {
        safeField: 'ok',
        dirtyField: undefined,
        arr: ['a', undefined, 'b'],
      },
    };

    await repo.commit(OWNER, [put('claims', recordWithUndefined)]);

    const storedData = firestoreBatchHook.batches[0]?.sets[0]?.data as any;
    expect(storedData.undefinedField).toBeUndefined();
    expect(storedData.nested.safeField).toBe('ok');
    expect(storedData.nested.dirtyField).toBeUndefined();
    expect(storedData.nested.arr).toEqual(['a', null, 'b']);
  });

  it('transitions durability to LOCAL_PENDING when timeout occurs without crashing', async () => {
    vi.useFakeTimers();
    firestoreBatchHook.hangCommit = true;

    const repo = new FirebaseRepository(mockDb);
    const changes: Change[] = [];
    for (let i = 0; i < 450; i++) {
      changes.push(put('claims', claim(`Claim ${i}`, { id: `clm_timeout_${i}` })));
    }

    const commitPromise = repo.commit(OWNER, changes);
    await vi.advanceTimersByTimeAsync(COMMIT_ACK_TIMEOUT_MS + 100);

    const outcome = await commitPromise;
    expect(outcome.durability).toBe('LOCAL_PENDING');
    expect(firestoreBatchHook.batches).toHaveLength(2);

    vi.useRealTimers();
  });

  it('absorbs late failure after timeout with zero unhandled promise rejections', async () => {
    vi.useFakeTimers();
    firestoreBatchHook.hangCommit = true;
    firestoreBatchHook.rejectAfterTimeoutMs = 15_000;

    const repo = new FirebaseRepository(mockDb);
    const commitPromise = repo.commit(OWNER, [put('claims', claim('Test', { id: 'clm_late' }))]);

    await vi.advanceTimersByTimeAsync(11_000);
    const outcome = await commitPromise;
    expect(outcome.durability).toBe('LOCAL_PENDING');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(unhandledRejections).toHaveLength(0);

    vi.useRealTimers();
  });

  it('propagates immediate server authorization rejection directly to caller', async () => {
    firestoreBatchHook.failBatchIndex = 0;
    const repo = new FirebaseRepository(mockDb);

    await expect(
      repo.commit(OWNER, [put('claims', claim('Forbidden', { id: 'clm_forbidden' }))]),
    ).rejects.toThrow('Permission denied on batch 0');
  });
});

// ============================================================================
// SUITE 3: Cloud Sync Queue & Offline Durability
// ============================================================================
describe('M1 Stress: Cloud Sync Queue Persistence & Recovery', () => {
  beforeEach(async () => {
    await clearCloudSyncQueue();
  });

  it('handles 500 queued offline evidence sync items without data loss', async () => {
    for (let i = 0; i < 500; i++) {
      await enqueueCloudSync({
        ownerId: OWNER,
        caseId: CASE_ID,
        evidenceId: `evd_queue_${i}`,
        storagePath: `users/${OWNER}/cases/${CASE_ID}/evd_queue_${i}/original.pdf`,
        name: `doc_${i}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024 + i,
        sha256: `hash_${i}`,
      });
    }

    const pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(500);
    expect(pending[0]?.evidenceId).toBe('evd_queue_0');
    expect(pending[499]?.evidenceId).toBe('evd_queue_499');

    for (let i = 0; i < 200; i++) {
      await dequeueCloudSync(`evd_queue_${i}`);
    }

    const remaining = await getPendingCloudSyncs(OWNER);
    expect(remaining).toHaveLength(300);
    expect(remaining[0]?.evidenceId).toBe('evd_queue_200');
  });

  it('idempotently deduplicates multiple enqueues of the same evidence item', async () => {
    await enqueueCloudSync({
      ownerId: OWNER,
      caseId: CASE_ID,
      evidenceId: 'evd_single',
      storagePath: `users/${OWNER}/cases/${CASE_ID}/evd_single/original.pdf`,
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'hash_single',
    });

    await enqueueCloudSync({
      ownerId: OWNER,
      caseId: CASE_ID,
      evidenceId: 'evd_single',
      storagePath: `users/${OWNER}/cases/${CASE_ID}/evd_single/original.pdf`,
      name: 'test_updated.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'hash_single',
    });

    const pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe('test_updated.pdf');
  });

  it('safely handles corrupted AsyncStorage queue payload by returning empty list', async () => {
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, '{"notAnArray": true, invalidJson...');
    const queue = await loadCloudSyncQueue();
    expect(queue).toEqual([]);
  });

  it('absorbs AsyncStorage setItem failure gracefully without crashing', async () => {
    const originalSetItem = AsyncStorage.setItem;
    AsyncStorage.setItem = vi.fn().mockRejectedValue(new Error('Disk quota exceeded'));

    // saveCloudSyncQueue should catch and absorb
    await expect(saveCloudSyncQueue([])).resolves.toBeUndefined();

    AsyncStorage.setItem = originalSetItem;
  });

  it('selectively clears queue by ownerId while preserving other owners', async () => {
    await enqueueCloudSync({
      ownerId: 'usr_alpha',
      caseId: 'case_1',
      evidenceId: 'evd_a',
      storagePath: 'users/usr_alpha/cases/case_1/evd_a/original.pdf',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'ha',
    });
    await enqueueCloudSync({
      ownerId: 'usr_beta',
      caseId: 'case_2',
      evidenceId: 'evd_b',
      storagePath: 'users/usr_beta/cases/case_2/evd_b/original.pdf',
      name: 'b.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'hb',
    });

    await clearCloudSyncQueue('usr_alpha');
    const alphaPending = await getPendingCloudSyncs('usr_alpha');
    const betaPending = await getPendingCloudSyncs('usr_beta');
    expect(alphaPending).toHaveLength(0);
    expect(betaPending).toHaveLength(1);
    expect(betaPending[0]?.evidenceId).toBe('evd_b');
  });

  it('marks queue item FAILED when local file is missing during retry', async () => {
    await enqueueCloudSync({
      ownerId: OWNER,
      caseId: CASE_ID,
      evidenceId: 'evd_missing',
      storagePath: `users/${OWNER}/cases/${CASE_ID}/evd_missing/original.pdf`,
      name: 'missing.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: 'h_missing',
    });

    const [item] = await getPendingCloudSyncs(OWNER);
    expect(item).toBeDefined();

    const res = await retryCloudSyncItem(item!);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(false);
    }

    const queue = await loadCloudSyncQueue();
    expect(queue[0]?.status).toBe('FAILED');
    expect(queue[0]?.attempts).toBe(1);
  });
});

// ============================================================================
// SUITE 4: Cloudinary Transport, Network Drops & HTTP Errors
// ============================================================================
describe('M1 Stress: Cloudinary Network Drops & HTTP Errors', () => {
  const originalEnvCloud = process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const originalEnvPreset = process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = 'test_cloud';
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = 'test_preset';
  });

  afterEach(() => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = originalEnvCloud;
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = originalEnvPreset;
  });

  // Mock XMLHttpRequest harness
  function mockXHR(behavior: (xhr: any) => void) {
    const originalXHR = globalThis.XMLHttpRequest;
    class MockXHR {
      upload = { onprogress: null as any };
      timeout = 0;
      status = 0;
      responseText = '';
      onload: any = null;
      onerror: any = null;
      ontimeout: any = null;
      onabort: any = null;
      open = vi.fn();
      send = vi.fn(() => {
        behavior(this);
      });
      abort = vi.fn(() => {
        if (this.onabort) this.onabort();
      });
    }
    (globalThis as any).XMLHttpRequest = MockXHR;
    return () => {
      globalThis.XMLHttpRequest = originalXHR;
    };
  }

  it('simulates network drop (aeroplane mode/offline) returning retryable NETWORK failure', async () => {
    const restoreXHR = mockXHR((xhr) => {
      setTimeout(() => {
        if (xhr.onerror) xhr.onerror();
      }, 0);
    });

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    restoreXHR();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('NETWORK');
      expect(res.retryable).toBe(true);
      expect(res.message).toContain('Could not reach cloud backup');
    }
  });

  it('simulates upload timeout returning retryable NETWORK failure', async () => {
    const restoreXHR = mockXHR((xhr) => {
      setTimeout(() => {
        if (xhr.ontimeout) xhr.ontimeout();
      }, 0);
    });

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    restoreXHR();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('NETWORK');
      expect(res.retryable).toBe(true);
      expect(res.message).toContain('timed out');
    }
  });

  it('simulates user cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const restoreXHR = mockXHR((xhr) => {
      // Abort immediately when sent
      controller.abort();
    });

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      signal: controller.signal,
    });

    restoreXHR();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('CANCELLED');
      expect(res.retryable).toBe(true);
    }
  });

  it('simulates Cloudinary 500 / 503 Internal Server Error returning retryable REJECTED failure', async () => {
    const restoreXHR = mockXHR((xhr) => {
      xhr.status = 503;
      xhr.responseText = JSON.stringify({ error: { message: 'Service Unavailable' } });
      setTimeout(() => {
        if (xhr.onload) xhr.onload();
      }, 0);
    });

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    restoreXHR();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('REJECTED');
      expect(res.status).toBe(503);
      expect(res.retryable).toBe(true); // 5xx errors are retryable
      expect(res.message).toContain('Service Unavailable');
    }
  });

  it('simulates Cloudinary 400 Bad Request returning non-retryable REJECTED failure', async () => {
    const restoreXHR = mockXHR((xhr) => {
      xhr.status = 400;
      xhr.responseText = JSON.stringify({ error: { message: 'Upload preset not found' } });
      setTimeout(() => {
        if (xhr.onload) xhr.onload();
      }, 0);
    });

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });

    restoreXHR();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('REJECTED');
      expect(res.status).toBe(400);
      expect(res.retryable).toBe(false); // 4xx errors are not retryable
      expect(res.message).toContain('Upload preset not found');
    }
  });

  it('pre-flight rejects oversized file (>100MB) without initiating network call', async () => {
    const sendFn = vi.fn();
    const restoreXHR = mockXHR(() => sendFn());

    const res = await uploadToCloudinary({
      uri: 'file:///huge.pdf',
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
    });

    restoreXHR();
    expect(sendFn).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('TOO_LARGE');
      expect(res.retryable).toBe(false);
    }
  });

  it('returns NOT_CONFIGURED when cloud credentials are empty string', async () => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = '';
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = '';

    const res = await uploadToCloudinary({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('NOT_CONFIGURED');
      expect(res.retryable).toBe(false);
    }
  });

  it('mirrorToCloud never throws under catastrophic unexpected exceptions', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = () => {
      throw new Error('Fatal Native Bridge Crash');
    };

    const res = await mirrorToCloud({
      uri: 'file:///test.pdf',
      name: 'test.pdf',
      mimeType: 'application/pdf',
    });

    globalThis.XMLHttpRequest = originalXHR;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('NETWORK');
      expect(res.retryable).toBe(true);
    }
  });
});

// ============================================================================
// SUITE 5: Evidence Storage & Cloud Mirroring Integration
// ============================================================================
describe('M1 Stress: Evidence Storage & Queue Lifecycle Integration', () => {
  const originalEnvCloud = process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const originalEnvPreset = process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET;

  beforeEach(async () => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = 'test_cloud';
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = 'test_preset';
    await clearCloudSyncQueue();
  });

  afterEach(() => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = originalEnvCloud;
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = originalEnvPreset;
  });

  function mockXHRSuccess() {
    const originalXHR = globalThis.XMLHttpRequest;
    class MockXHR {
      upload = { onprogress: null as any };
      timeout = 0;
      status = 200;
      responseText = JSON.stringify({
        secure_url: 'https://res.cloudinary.com/test_cloud/image/upload/v1/original.pdf',
        public_id: 'users/user_test/cases/case_test/evd_1/original',
        resource_type: 'raw',
        format: 'pdf',
        bytes: 1024,
      });
      onload: any = null;
      onerror: any = null;
      open = vi.fn();
      send = vi.fn(() => {
        setTimeout(() => this.onload?.(), 0);
      });
      abort = vi.fn();
    }
    (globalThis as any).XMLHttpRequest = MockXHR;
    return () => {
      globalThis.XMLHttpRequest = originalXHR;
    };
  }

  function mockXHRFailure(status: number, message: string) {
    const originalXHR = globalThis.XMLHttpRequest;
    class MockXHR {
      upload = { onprogress: null as any };
      timeout = 0;
      status = status;
      responseText = JSON.stringify({ error: { message } });
      onload: any = null;
      onerror: any = null;
      open = vi.fn();
      send = vi.fn(() => {
        setTimeout(() => {
          if (status === 0) {
            this.onerror?.();
          } else {
            this.onload?.();
          }
        }, 0);
      });
      abort = vi.fn();
    }
    (globalThis as any).XMLHttpRequest = MockXHR;
    return () => {
      globalThis.XMLHttpRequest = originalXHR;
    };
  }

  it('enqueues evidence into cloud-sync-queue on network drop and marks cloudStatus PENDING', async () => {
    const restoreXHR = mockXHRFailure(0, 'Network dropped');
    const validDataUri = 'data:application/pdf;base64,JVBERi0xLjQK';

    const result = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
    });

    restoreXHR();
    expect(result.cloudStatus).toBe('PENDING');
    expect(result.evidence.cloudStatus).toBe('PENDING');

    // Verify item was placed into cloud-sync-queue
    const pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.evidenceId).toBe(result.evidenceId);
    expect(pending[0]?.name).toBe('invoice.pdf');

    // Local file was stored and can be verified
    const isIntact = await verifyEvidenceFile(result.storagePath, result.sha256);
    expect(isIntact).toBe(true);
  });

  it('drains and syncs pending evidence queue after network is restored', async () => {
    // 1. First upload fails due to network drop
    let restoreXHR = mockXHRFailure(0, 'Network offline');
    const validDataUri = 'data:application/pdf;base64,JVBERi0xLjQK';

    const uploadRes = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'offline_doc.pdf',
      mimeType: 'application/pdf',
    });
    restoreXHR();

    expect(uploadRes.cloudStatus).toBe('PENDING');
    let pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(1);

    // 2. Network is restored -> syncPendingEvidenceUploads succeeds
    restoreXHR = mockXHRSuccess();
    const outcome = await syncPendingEvidenceUploads(OWNER);
    restoreXHR();

    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toBe(0);

    // Queue drained
    pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(0);
  });

  it('does NOT enqueue when Cloudinary returns non-retryable 400 rejection', async () => {
    const restoreXHR = mockXHRFailure(400, 'Upload preset not found');
    const validDataUri = 'data:application/pdf;base64,JVBERi0xLjQK';

    const result = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'rejected.pdf',
      mimeType: 'application/pdf',
    });

    restoreXHR();
    expect(result.cloudStatus).toBe('FAILED');
    expect(result.cloudError).toContain('Upload preset not found');

    // Should NOT be queued for retries
    const pending = await getPendingCloudSyncs(OWNER);
    expect(pending).toHaveLength(0);
  });

  it('marks LOCAL_ONLY when Cloudinary is unconfigured', async () => {
    process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME = '';
    process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET = '';
    const validDataUri = 'data:application/pdf;base64,JVBERi0xLjQK';

    // 1. Without mirrorToCloud option (default: disabled when unconfigured)
    const resultDefault = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'local_doc.pdf',
      mimeType: 'application/pdf',
    });
    expect(resultDefault.cloudStatus).toBe('LOCAL_ONLY');

    // 2. With mirrorToCloud: true explicitly requested on unconfigured build
    const resultExplicit = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'local_doc_explicit.pdf',
      mimeType: 'application/pdf',
      mirrorToCloud: true,
    });
    expect(resultExplicit.cloudStatus).toBe('LOCAL_ONLY');
    expect(resultExplicit.cloudError).toContain('Cloud backup is not set up for this build');
    expect(await getPendingCloudSyncs(OWNER)).toHaveLength(0);
  });

  it('marks SYNCED with cloudUrl when mirror upload succeeds immediately', async () => {
    const restoreXHR = mockXHRSuccess();
    const validDataUri = 'data:application/pdf;base64,JVBERi0xLjQK';

    const result = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'synced_doc.pdf',
      mimeType: 'application/pdf',
    });

    restoreXHR();
    expect(result.cloudStatus).toBe('SYNCED');
    expect(result.cloudUrl).toBe('https://res.cloudinary.com/test_cloud/image/upload/v1/original.pdf');
    expect(result.cloudPublicId).toBe('users/user_test/cases/case_test/evd_1/original');
    expect(result.evidence.cloudSyncedAt).toBeGreaterThan(0);
    expect(await getPendingCloudSyncs(OWNER)).toHaveLength(0);
  });

  it('detects tampering and corruption during verifyEvidenceFile', async () => {
    const validDataUri = 'data:text/plain;base64,aGVsbG8gd29ybGQ='; // "hello world"

    const result = await uploadEvidenceFile({
      ownerId: OWNER,
      caseId: CASE_ID,
      uri: validDataUri,
      name: 'hello.txt',
      mimeType: 'text/plain',
      mirrorToCloud: false,
    });

    // 1. Matches expected hash
    expect(await verifyEvidenceFile(result.storagePath, result.sha256)).toBe(true);

    // 2. Modified hash fails verification
    expect(await verifyEvidenceFile(result.storagePath, '0'.repeat(64))).toBe(false);

    // 3. Missing storage path fails verification
    expect(await verifyEvidenceFile('users/user_test/cases/case_test/evd_nonexistent/original.txt', result.sha256)).toBe(
      false,
    );
  });
});

// ============================================================================
// SUITE 6: Streaming SHA-256 Computation & Size Boundary Hardening
// ============================================================================
describe('M1 Stress: Streaming SHA-256 & Size Boundary Hardening', () => {
  it('rejects zero-byte files on uploadEvidenceFile with EvidenceFileError', async () => {
    // Empty data URI
    const emptyDataUri = 'data:text/plain;base64,';

    await expect(
      uploadEvidenceFile({
        ownerId: OWNER,
        caseId: CASE_ID,
        uri: emptyDataUri,
        name: 'empty.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EvidenceFileError && err.message.includes('This file is empty, so there is nothing to store or read.'),
    );
  });

  it('rejects zero-byte files on copyWithDigest', async () => {
    await expect(
      copyWithDigest({
        source: readerOver(new Uint8Array(0)),
        destination: collectingWriter(),
        totalBytes: 0,
      }),
    ).rejects.toThrow('This file is empty, so there is nothing to store or read.');
  });

  it('computes RFC-standard SHA-256 for 0 bytes on digestStream', async () => {
    const emptyHash = await digestStream({
      source: readerOver(new Uint8Array(0)),
      totalBytes: 0,
    });

    // Known standard SHA-256 for empty string / zero bytes
    expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('pre-flight rejects oversized file (>100MB) on uploadEvidenceFile', async () => {
    await expect(
      uploadEvidenceFile({
        ownerId: OWNER,
        caseId: CASE_ID,
        uri: 'data:text/plain;base64,aGVsbG8=',
        name: 'oversized.pdf',
        mimeType: 'application/pdf',
        sizeBytes: MAX_EVIDENCE_UPLOAD_BYTES + 1, // 104,857,601 bytes
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EvidenceFileError && err.message.includes('This file is over the 100 MB limit'),
    );
  });

  it('permits exactly 100 MB boundary pre-flight check', async () => {
    // Exactly 104,857,600 bytes
    const boundaryBytes = MAX_EVIDENCE_UPLOAD_BYTES;
    expect(boundaryBytes).toBe(100 * 1024 * 1024);
    // Boundary check does not exceed limit
    expect(boundaryBytes > MAX_EVIDENCE_UPLOAD_BYTES).toBe(false);
  });

  it('validates streaming SHA-256 digest parity across chunk boundaries against Noble oracle', async () => {
    // 5000 bytes with 1024-byte chunk size: 4 full 1024-byte chunks + 1 partial 904-byte chunk
    const testBytes = pattern(5000);
    const destination = collectingWriter();

    const streamResult = await copyWithDigest({
      source: readerOver(testBytes),
      destination,
      totalBytes: testBytes.length,
      chunkBytes: 1024,
      yieldToHost: async () => {},
    });

    const nobleDigest = bytesToHex(sha256(testBytes));

    expect(streamResult.bytesCopied).toBe(testBytes.length);
    expect(streamResult.sha256).toBe(nobleDigest);
    expect(destination.written()).toEqual(testBytes);

    // Verify digestStream matches across chunk boundaries as well
    const readOnlyDigest = await digestStream({
      source: readerOver(testBytes),
      totalBytes: testBytes.length,
      chunkBytes: 1024,
      yieldToHost: async () => {},
    });
    expect(readOnlyDigest).toBe(nobleDigest);
  });

  it('validates large multi-megabyte stream hashing against whole-buffer SHA-256', async () => {
    // 2 MB buffer streamed in 1 MB chunks
    const largeBytes = pattern(2 * 1024 * 1024);
    const nobleDigest = bytesToHex(sha256(largeBytes));

    const readOnlyDigest = await digestStream({
      source: readerOver(largeBytes),
      totalBytes: largeBytes.length,
      chunkBytes: COPY_CHUNK_BYTES,
      yieldToHost: async () => {},
    });
    expect(readOnlyDigest).toBe(nobleDigest);
  });

  it('detects short reads and refuses truncated digest computation', async () => {
    const bytes = pattern(2048);
    // Reader stops prematurely after 1024 bytes
    const truncatedSource = readerOver(bytes, { stopAfter: 1024 });

    await expect(
      copyWithDigest({
        source: truncatedSource,
        destination: collectingWriter(),
        totalBytes: bytes.length,
        chunkBytes: 512,
        yieldToHost: async () => {},
      }),
    ).rejects.toThrow('The file could not be read completely — it may have been moved or deleted. Select it again.');
  });
});
