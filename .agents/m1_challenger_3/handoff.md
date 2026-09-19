# Handoff Report — M1 Challenger 3 (Adversarial Empirical Verification)

**Challenger**: `m1_challenger_3` (Replacement Challenger)  
**Parent Agent**: `1bb3d463-48e2-4165-9c4e-fbe369e86bec` (`parent`)  
**Working Directory**: `e:/Project Evid/detact/.agents/m1_challenger_3`  
**Date**: 2026-09-17  
**Verdict**: **APPROVE** (Milestone 1 — Cloud-Native Storage & Data Layer)

---

## 1. Observation

1. **Storage, Data Layer & Queue Implementations**:
   - `src/services/storage/evidence-storage.ts`:
     - Preserves local-first persistence via private application storage before attempting cloud upload (`uploadEvidenceFile:255-376`).
     - Uses `MAX_EVIDENCE_UPLOAD_BYTES = 100 * 1024 * 1024` (100 MB ceiling matching Groq Whisper API limit) (`lines 70, 271, 313`).
     - Rejects zero-byte files with `EvidenceFileError('This file is empty, so there is nothing to store or read.')` (`lines 285, 311`).
     - Rejects files > 100 MB in pre-flight without moving bytes (`lines 271-273`).
     - Non-blocking cloud upload via `mirrorToCloud`: on retryable failures (e.g. network disconnect, 5xx), enqueues item into `cloud-sync-queue.ts` and sets `cloudStatus: 'PENDING'` (`lines 407-420, 423-435`).
     - On non-retryable refusal (e.g. 400 Bad Request, unconfigured), marks `cloudStatus: 'FAILED'` or `'LOCAL_ONLY'` and avoids polluting the retry queue (`lines 389-390, 407-408`).
     - Provides tamper detection in `verifyEvidenceFile` recomputing SHA-256 against stored bytes (`lines 540-573`).
   - `src/services/storage/cloud-sync-queue.ts`:
     - Durable offline queue backed by `@react-native-async-storage/async-storage` under key `@detact:v1:cloud_sync_queue` (`lines 14, 35, 45`).
     - Deduplicates items idempotently by evidenceId (`lines 56-69`).
     - Gracefully absorbs storage quota/write errors in `saveCloudSyncQueue` without crashing callers (`lines 46-48`).
     - When local file is missing on retry, marks queue entry `status: 'FAILED'` and sets `retryable: false` (`lines 101-118`).
     - `syncPendingEvidenceUploads` successfully drains pending queue when network is restored (`lines 173-190`).
   - `src/services/storage/cloudinary.ts`:
     - `uploadToCloudinary` unsigned transport using XMLHttpRequest progress tracking (`lines 168-267`).
     - Rejects files exceeding `MAX_UPLOAD_BYTES` (100 MB) with `TOO_LARGE` reason (`lines 177-179`).
     - Handles network failures (`xhr.onerror`), timeouts (`xhr.ontimeout`), user cancellations (`xhr.onabort`), 5xx server errors (`xhr.status >= 500`), and 4xx client errors (`xhr.status < 500`).
     - `mirrorToCloud` catches all unexpected runtime exceptions into a safe failure result without throwing unhandled promise rejections (`lines 277-283`).
   - `src/services/storage/stream-copy.ts`:
     - `copyWithDigest` and `digestStream` stream data in bounded 1 MB chunks (`COPY_CHUNK_BYTES = 1024 * 1024`) (`lines 66, 125-211`).
     - Folded into streaming digest via `@noble/hashes/sha2.js` while moving bytes, matching whole-buffer SHA-256 digests.
     - Detects truncated sources/short reads and throws clear error: `'The file could not be read completely — it may have been moved or deleted. Select it again.'` (`lines 159-161, 206-208`).
     - `copyWithDigest` rejects empty files (`total <= 0`) with `'This file is empty, so there is nothing to store or read.'` (`line 131`).
     - `digestStream` correctly computes RFC standard SHA-256 for zero bytes (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
   - `src/data/local/local-repository.ts`:
     - Sharded by case (`detact:v1:{ownerId}:case:{caseId}`) plus index (`detact:v1:{ownerId}:cases`).
     - Recovers from corrupted shard JSON by falling back to empty shard without throwing (`lines 62-66, 313`).
     - Recovers from corrupted case index without throwing `TypeError` (`lines 298-300`).
     - Sorts stored records deterministically by `a.id.localeCompare(b.id)` (`lines 174-176`).
     - Manages reactive listeners with safe unsubscription (`lines 240-263`).

2. **Empirical Stress Harness Execution (`tests/m1-challenger-stress.test.ts`)**:
   - 42 targeted stress tests executed across 6 suites:
     - **Suite 1: LocalRepository Durability & Boundary Testing (8 tests)**:
       - 400-item boundary commit (`MAX_ATOMIC_CHANGES = 400`) — PASS.
       - 450-item beyond-boundary commit — PASS.
       - Massive commit: 1,200 items across 5 distinct cases and collections — PASS.
       - 400 bulk deletes with unresolved caseIds — PASS.
       - 10 rapid concurrent commits without serialization crash — PASS.
       - Case shard corrupted JSON recovery — PASS.
       - Case index corrupted structure recovery — PASS.
       - Reactive watcher emission and clean unsubscribe — PASS.
     - **Suite 2: FirebaseRepository Batching & Timeout (6 tests)**:
       - Splits 450 items into 2 write batches bounded by 400 — PASS.
       - Splits 1,200 items into 3 batches of 400 each — PASS.
       - Sanitizes undefined properties and deeply nested values — PASS.
       - Transitions durability to `LOCAL_PENDING` on offline/timeout — PASS.
       - Absorbs late failure after timeout with 0 unhandled promise rejections — PASS.
       - Immediate server authorization rejection propagation — PASS.
     - **Suite 3: Cloud Sync Queue Persistence & Recovery (6 tests)**:
       - 500 queued offline evidence sync items without data loss — PASS.
       - Idempotent deduplication on duplicate enqueues — PASS.
       - Corrupted AsyncStorage payload recovery — PASS.
       - AsyncStorage write failure absorption — PASS.
       - Selective queue purge by `ownerId` vs global clear — PASS.
       - Local file missing during retry transitions item to `FAILED` — PASS.
     - **Suite 4: Cloudinary Transport, Network Drops & HTTP Errors (8 tests)**:
       - Network drop simulation (offline/aeroplane mode) -> retryable `NETWORK` failure — PASS.
       - Upload timeout simulation -> retryable `NETWORK` failure — PASS.
       - User cancellation via AbortSignal -> retryable `CANCELLED` — PASS.
       - Cloudinary 500 / 503 Internal Server Error -> retryable `REJECTED` — PASS.
       - Cloudinary 400 Bad Request -> non-retryable `REJECTED` — PASS.
       - Pre-flight rejection of oversized file (>100MB) without network call — PASS.
       - Unconfigured credentials handling -> `NOT_CONFIGURED` — PASS.
       - `mirrorToCloud` crash resilience (zero unhandled exceptions) — PASS.
     - **Suite 5: Evidence Storage & Queue Lifecycle Integration (6 tests)**:
       - Network drop enqueues item into queue and sets `cloudStatus: 'PENDING'` — PASS.
       - Queue drained and evidence marked synced when network is restored — PASS.
       - Cloudinary 400 error marks `cloudStatus: 'FAILED'` and avoids retry queue — PASS.
       - Unconfigured Cloudinary marks `cloudStatus: 'LOCAL_ONLY'` — PASS.
       - Immediate upload success marks `cloudStatus: 'SYNCED'` with remote URL — PASS.
       - Tamper and corruption detection in `verifyEvidenceFile` — PASS.
     - **Suite 6: Streaming SHA-256 Computation & Size Boundary Hardening (8 tests)**:
       - Zero-byte file rejected on `uploadEvidenceFile` with `EvidenceFileError` — PASS.
       - Zero-byte file rejected on `copyWithDigest` — PASS.
       - Zero-byte file on `digestStream` produces RFC standard hash — PASS.
       - Oversized file (>100MB) rejected in pre-flight — PASS.
       - Exactly 100 MB boundary check permitted — PASS.
       - Streaming SHA-256 chunk boundary validation matches Noble oracle — PASS.
       - Multi-megabyte stream hashing matches whole-buffer Noble oracle — PASS.
       - Short-read detection halts truncated digest computation — PASS.
   - Result: `42 passed | 0 failed (42 tests) in 958ms`.

3. **Full Test Suite & Health Verification**:
   - `npm test`: `81 test files passed | 1 skipped (82) | 1,684 tests passed | 0 failures` (exit code 0).
   - `npm run typecheck`: `tsc --noEmit` completed with 0 errors (exit code 0).
   - `npm run lint:expo`: `npx expo-doctor` passed 20/20 checks (exit code 0).

---

## 2. Logic Chain

1. **Storage Tiering and Local-First Invariants (Observation 1, 2)**:
   - In `uploadEvidenceFile`, persisting to the local filesystem or IndexedDB before any cloud request occurs ensures that no network dropout, slow latency, or Cloudinary outage can ever cause user data loss.
   - Empirically verified in Suite 5: when network fails during upload, local file integrity is 100% intact, `verifyEvidenceFile` succeeds, and `cloudStatus` reliably transitions to `'PENDING'`.

2. **Durable Cloud Mirroring & Offline Queue Resilience (Observation 1, 2)**:
   - In `cloud-sync-queue.ts` and `cloudinary.ts`, transient network failures and 5xx server errors must be retried with exponential backoff awareness, while 4xx errors (e.g. invalid presets, bad parameters) must not loop endlessly.
   - Empirically verified in Suite 3 & 4: 500 queued items persist without loss; corrupted AsyncStorage data is safely recovered; 400 Bad Request responses are marked non-retryable and evicted; and calling `syncPendingEvidenceUploads` once connectivity returns drains the queue to 0.

3. **Streaming SHA-256 Integrity on Zero-Byte & Boundary Files (Observation 1, 2)**:
   - Zero-byte files represent invalid evidence and must be rejected before ingestion (`uploadEvidenceFile` and `copyWithDigest` reject with human-readable sentences).
   - Pure streams without destination (`digestStream`) compute the deterministic RFC standard SHA-256 hash for 0 bytes (`e3b0c442...`).
   - Files exceeding 100 MB are rejected before allocation or transfer, guarding against OOM crashes on mobile handsets.
   - Streaming in 1 MB chunks across arbitrary boundaries produces byte-for-byte identical SHA-256 digests compared to `@noble/hashes` synchronous whole-buffer oracle.

4. **Durability and Concurrency in Data Repositories (Observation 1, 2)**:
   - `LocalRepository` successfully handles boundary commits (400 items), oversized commits (450 items), massive multi-case batches (1,200 items), bulk deletes, and rapid concurrent commits.
   - Corrupted index and shard structures degrade safely to empty lists rather than crashing the application with `TypeError`.
   - `FirebaseRepository` properly slices mutations into 400-operation batches, bounds server acknowledgement wait time, reports `LOCAL_PENDING` without throwing on disconnect, and absorbs late failures with 0 unhandled promise rejections.

---

## 3. Caveats

- In Node/Vitest test environments, `expo-file-system` and `expo-constants` are mocked at the harness level because Expo native runtime symbols (`ExpoGlobal.EventEmitter`) are only present in Metro/React Native runtime. This repository's architecture explicitly uses structural reader/writer interfaces (`ByteReader`, `ByteWriter`) and IndexedDB web adapters to allow pure Node testing of the exact streaming and durability control flow.
- Cloudinary credentials in `.env.example` remain demo/template credentials; live off-device mirroring in production requires valid Cloudinary environment variables as designed. In offline mode or when unconfigured, the system safely operates in `LOCAL_ONLY` status with full local functionality.
- No other caveats.

---

## 4. Conclusion

**Verdict: APPROVE.**

The Cloud-Native Storage, Cloudinary mirroring, offline retry queue, streaming SHA-256 hashing, and data layer durability implementations in `evidence-storage.ts`, `cloud-sync-queue.ts`, `cloudinary.ts`, `stream-copy.ts`, and `local-repository.ts` have been rigorously and empirically stress-tested. Every failure mode—including network dropouts, 500/503 server errors, 400 Bad Request rejections, 500-item queue saturation, corrupted AsyncStorage states, zero-byte uploads, oversized files (>100MB), and streaming chunk boundary hashing—was subjected to adversarial challenge and passed cleanly with zero unhandled exceptions and zero data loss.

Milestone 1 satisfies all requirements set forth in `PROJECT.md` (R1) and `ORIGINAL_REQUEST.md`.

---

## 5. Verification Method

To independently execute and verify the empirical stress tests and project health:

1. **Run Empirical Challenger Stress Harness (42 tests)**:
   ```bash
   npx vitest run tests/m1-challenger-stress.test.ts
   ```
   *Expected*: 42 passed, 0 failed, exit code 0.

2. **Run Storage & Data Layer Test Group (108 tests)**:
   ```bash
   npx vitest run tests/cloud-sync-queue.test.ts tests/evidence-storage.test.ts tests/stream-copy.test.ts tests/data-layer.test.ts
   ```
   *Expected*: 4 test files passed, 108 tests passed, exit code 0.

3. **Run Full Test Suite (1,684 tests)**:
   ```bash
   npm test
   ```
   *Expected*: 81 test files passed, 1,684 tests passed, 0 failures (1 emulator suite skipped), exit code 0.

4. **Static Type Checking**:
   ```bash
   npm run typecheck
   ```
   *Expected*: Zero TypeScript errors, exit code 0.

5. **Expo Doctor Linter**:
   ```bash
   npm run lint:expo
   ```
   *Expected*: 20/20 checks passed, exit code 0.
