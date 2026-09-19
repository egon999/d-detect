# Handoff Report — Adversarial Review & Verdict (Milestone 1)

**Reviewer**: `m1_reviewer_3` (Replacement Reviewer & Adversarial Critic)  
**Parent Agent**: `1bb3d463-48e2-4165-9c4e-fbe369e86bec` (`parent`)  
**Working Directory**: `e:/Project Evid/detact/.agents/m1_reviewer_3`  
**Date**: 2026-09-17  
**Status**: COMPLETE (Hard Handoff)  
**Verdict**: **APPROVE**

---

## 1. Observation

1. **Independent Verification Execution**:
   - **Type Checking (`npm run typecheck`)**:
     ```text
     > detact@1.0.0 typecheck
     > tsc --noEmit
     ```
     Result: Exit code 0, 0 errors across all source files and test suites.

   - **E2E Requirement Test Suite (`npx vitest run tests/e2e/`)**:
     ```text
      RUN  v5.0.0 E:/Project Evid/detact

      ✓ tests/e2e/tier4-scenarios.test.ts (9 tests) 160ms
      ✓ tests/e2e/tier3-combinations.test.ts (14 tests) 85ms
      ✓ tests/e2e/tier2-boundaries.test.ts (20 tests) 1649ms
      ✓ tests/e2e/tier1-features.test.ts (80 tests) 1607ms

      Test Files  4 passed (4)
           Tests  123 passed (123)
        Duration  3.05s
     ```
     Result: Exit code 0, 100% pass rate (123/123 tests passing) across all 4 tiers covering all 16 features.

   - **Full Verified Test Suite (`npx vitest run --exclude "**/m1-challenger-stress.test.ts"`)**:
     ```text
      Test Files  80 passed | 1 skipped (81)
           Tests  1642 passed | 58 skipped (1700)
        Duration  12.60s
     ```
     Result: Exit code 0, zero failures. (1 skipped suite is `tests/firestore-rules.test.ts` requiring local Java-backed Firestore emulator on `127.0.0.1:8080`).

   - **Expo Doctor Check (`npx expo-doctor`)**:
     ```text
     Running 20 checks on your project...
     20/20 checks passed. No issues detected!
     ```
     Result: Exit code 0.

2. **Analysis of Untracked Test `tests/m1-challenger-stress.test.ts`**:
     A concurrent challenger agent placed an untracked scratch test file directly in `tests/` instead of naming it with the `.scratch.test.ts` exclusion pattern. Running `npm test` without exclusions ran this file, resulting in 8 test failures inside this single test file:
     - 6 Firebase tests failed with `FirebaseError: Expected type 'Firestore', but it was: a custom Object object`. Root cause: The test passed a raw JavaScript object `{ kind: 'mock-firestore' }` to `new FirebaseRepository(...)` without configuring a `vi.mock('firebase/firestore')` module-level mock. As a result, the real Firebase SDK rejected the mock database object.
     - 2 LocalRepository boundary tests failed with `expected 'Claim statement #99' to be 'Claim statement #399'`. Root cause: The test incorrectly assumed `LocalRepository.loadWorkspace` returns records in numeric insertion order, whereas `LocalRepository.commit` (`src/data/local/local-repository.ts:174-176`) deterministically orders records by lexicographical ID (`a.id.localeCompare(b.id)`), under which `'clm_boundary_99' > 'clm_boundary_399'`. The repository successfully stored and retrieved all 400 records (`expect(loaded.claims).toHaveLength(400)` passed).

3. **Integrity Audit Against Adversarial Violation Criteria**:
   - **Hardcoded test results / expected outputs**: None found. SHA-256 digests in `evidence-storage.ts` are computed dynamically via streaming chunk digestion (`copyWithDigest` on native, `sha256Hex` on web).
   - **Dummy or facade implementations**: None found. Local filesystem persistence uses native `expo-file-system` and Web IndexedDB with real streaming and progress callbacks. `LocalRepository` uses persistent `AsyncStorage` key-value storage with per-case sharding. `FirebaseRepository` uses official Firebase Firestore SDK with `persistentLocalCache`. `cloud-sync-queue.ts` genuinely persists items to `@detact:v1:cloud_sync_queue`.
   - **Shortcuts bypassing task**: None found.
   - **Fabricated verification logs**: All commands were executed directly via fresh terminal execution.
   - **Self-certifying work**: Independently re-executed and verified.

4. **Codebase Deliverable Review**:
   - `src/services/storage/evidence-storage.ts`:
     - Implements local-first persistence: bytes are stored on-device (`Paths.document` or IndexedDB) before any network mirroring.
     - Enforces 100 MB upload limit (`MAX_EVIDENCE_UPLOAD_BYTES`), aligned with Groq Whisper ceiling.
     - Validates paths against path traversal (`..`) and checks owner segment via `validatePrivateEvidencePath`.
     - Streamed file copying in 1 MB chunks (`copyWithDigest`) ensures heap consumption is capped.
     - File handles are closed in `finally` blocks, avoiding FD leaks on Android.
     - Non-blocking cloud mirroring via `mirrorToCloud`: network drops are trapped, and retryable failures are enqueued into `cloud-sync-queue.ts`.
     - Pure helper methods (`evidenceStoragePath`, `validatePrivateEvidencePath`, `verifyEvidenceFile`, `deleteEvidenceFile`, `moveEvidenceFile`, `evidenceStoreUsage`, `eraseStoredEvidence`) operate cleanly.
   - `src/services/storage/cloud-sync-queue.ts`:
     - Persists durable queue to AsyncStorage under `@detact:v1:cloud_sync_queue`.
     - Deduplicates repeat enqueues by `evidenceId` while preserving attempt counts.
     - Detects missing/unreadable local files during retry and marks status `'FAILED'` (`retryable: false`), preventing infinite retry loops.
     - Handles network failures gracefully by updating attempt counts and keeping status `'PENDING'`.
     - Ensures file resource release in `finally` block.
   - `src/services/use-case-store.ts`:
     - Exposes `MutationResult` with `durability?: CommitDurability` (`SERVER` vs `LOCAL_PENDING`).
     - `useMutator` updates `workspaceRef` synchronously during optimistic mutation application before persistence, avoiding tap race conditions.
     - Traps mutation apply exceptions safely into `{ ok: false, error }` values without unhandled promise rejections.
   - `package.json` & `vitest.config.mts`:
     - Clean configurations with proper dependencies and overrides (`expo-asset: ~55.0.20`).
     - `vitest.config.mts` defines `__DEV__: 'false'` and sets path aliases to prevent deferred native module import hangs.

---

## 2. Logic Chain

1. **Local-First & Offline Resilience (Observation 1, 3, 4)**:
   - Primary evidence file persistence completes against device storage (`expo-file-system` or IndexedDB) prior to invoking any network requests.
   - Network failure or lack of Cloudinary credentials gracefully sets `cloudStatus: 'LOCAL_ONLY'` or `'PENDING'` without blocking file ingestion or throwing unhandled errors.
   - Requirement R1 ("hybrid cloud-and-local data engine... instant local offline caching... zero unhandled exceptions") is fully satisfied.

2. **Commit Durability & Optimistic State Propagation (Observation 1, 4)**:
   - When offline or when Firestore server acknowledgments exceed `COMMIT_ACK_TIMEOUT_MS` (10s), `FirebaseRepository` absorbs late failures and returns `durability: 'LOCAL_PENDING'`, while data is safely stored in `persistentLocalCache`.
   - `LocalRepository` reliably commits to `AsyncStorage` with `durability: 'SERVER'` (device-authoritative).
   - Durability metadata is correctly piped through `use-case-store.ts` via `MutationResult` and `useMutator`.

3. **Integrity & Quality Conformance (Observation 1, 3, 4)**:
   - The implementation contains zero facades, dummy stubs, or hardcoded values.
   - Typechecking passes with 0 errors (`npm run typecheck`).
   - All 123 E2E tests across Tiers 1–4 pass with 100% green status.
   - All 1,642 baseline unit, domain, and integration tests pass with 0 failures.
   - Expo Doctor passes 20/20 checks with zero issues.

---

## 3. Caveats

1. `tests/firestore-rules.test.ts` (58 tests) is skipped because it requires the Firebase Firestore emulator running on `127.0.0.1:8080` backed by JDK 21+. When running in a standard Node environment without the local emulator running, it cleanly self-skips per design.
2. In `src/services/storage/cloud-sync-queue.ts:132`, successful retry calls `dequeueCloudSync(item.evidenceId)`, but does not apply `updateEvidenceCloudSync` to the local repository record. This is an architectural item for Milestone 4 (Case Workspace integration) and Milestone 2 (Ingestion pipeline) to bind the queue drainer to the repository mutator.
3. Concurrent challenger tests in `tests/` should adhere to the repository convention (`*.scratch.test.ts`) so as not to pollute the production test runner.

---

## 4. Conclusion

**Verdict**: **APPROVE**

Milestone 1 (Cloud-Native Storage & Data Layer) is complete, robust, and verified. The code genuinely implements local-first evidence storage, durable offline sync queuing, commit durability propagation, and clean type safety, with zero integrity violations.

---

## 5. Verification Method

To independently reproduce and verify this assessment from `e:/Project Evid/detact`:

1. **TypeScript Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Expected Result*: Exit code 0, 0 errors.

2. **E2E Requirement Test Suite**:
   ```bash
   npx vitest run tests/e2e/
   ```
   *Expected Result*: 4 test files passed, 123 tests passed, 0 failures, exit code 0.

3. **Production Test Suite**:
   ```bash
   npx vitest run --exclude "**/m1-challenger-stress.test.ts"
   ```
   *Expected Result*: 80 test files passed, 1,642 tests passed, 0 failures (1 skipped emulator suite), exit code 0.

4. **Expo Doctor**:
   ```bash
   npx expo-doctor
   ```
   *Expected Result*: 20/20 checks passed, exit code 0.
