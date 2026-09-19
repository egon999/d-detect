# Handoff Report: Offline Resilience, Deterministic Rules & Network Safety

**Agent**: M1 Explorer 3  
**Working Directory**: `e:/Project Evid/detact/.agents/m1_explorer_3`  
**Date**: 2026-09-17T16:12:00Z  
**Target Milestone**: M1 (Cloud-Native Storage & Data Layer)  

---

## 1. Observation

### 1.1 Deterministic Rules Execution (`src/domain/rules/`)
- **File**: `src/domain/rules/registry.ts` lines 38–55:
  ```typescript
  export const RULES: readonly Rule[] = [
    paymentStatusConflictRule,
    statementDiscrepancyRule,
    harassmentIndicatorRule,
    eventDateConflictRule,
    impossibleSequenceRule,
    amountMismatchRule,
    missingEvidenceRule,
    unsupportedClaimRule,
    duplicateEvidenceRule,
    responseOverdueRule,
    orphanedEvidenceRule,
    timelineGapRule,
    relatedIdentifiersRule,
    corroboratedClaimRule,
    consistentAmountRule,
    corroboratedEventRule,
  ];
  ```
  Exactly 16 rules registered across five categories (Contradiction, Absence, Corroboration, Connection, Elapsed time).
- **Rule Definitions**: Grep across `src/domain/rules/` for `(fetch|http|async|await|promise)` yielded **zero matches**.
- **Engine Execution**: `src/domain/rules/engine.ts` line 209:
  ```typescript
  export function runAnalysis(
    workspace: Readonly<Workspace>,
    caseId: string,
    now: number,
    rules = enabledRules(),
  ): AnalysisRunResult
  ```
  `runAnalysis` is 100% synchronous and operates exclusively over in-memory `Workspace` structures. All IDs are generated using `deterministicId('an', rule.id, ...finding.key)` via `@noble/hashes` SHA-256 (`src/domain/ids.ts`), ensuring stable IDs across re-runs.
- **Clock Determinism**: `now` is strictly injected (epoch ms) rather than queried via `Date.now()`.
- **Test Evidence**:
  - `tests/rule-engine.test.ts`: 44 tests passing (103ms)
  - `tests/rule-engine-corpus.test.ts`: 28 tests passing (85ms)

### 1.2 Local Repository Defect & Crashing Behavior (`src/data/local/local-repository.ts`)
- **File**: `src/data/local/local-repository.ts` lines 319–328:
  ```typescript
  private async readIndex(ownerId: string): Promise<Case[]> {
    const raw = await this.store.get(indexKey(ownerId));
    const parsed = parseJson<unknown[]>(raw, []);
    // Validate at the boundary: a record written by an older build of the app is
    // dropped rather than allowed to flow into the reasoning engine half-shaped.
    return parsed.flatMap((item) => {
      const result = caseSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  }
  ```
- **File**: `src/data/local/local-repository.ts` lines 83–118:
  `Skipped` class only handles `ScopedCollection = Exclude<WorkspaceCollection, 'cases'>`. It does not handle `'cases'`.
- **Verbatim Test Failure**:
  Command: `npx vitest run tests/data-layer.test.ts`
  ```
  FAIL tests/data-layer.test.ts > LocalRepository > a case index holding rows an older build wrote > still lists the readable cases of an index a build wrote as an object
  TypeError: parsed.flatMap is not a function
   ❯ LocalRepository.readIndex src/data/local/local-repository.ts:324:19
      322| // Validate at the boundary: a record written by an older build of…
      323| // dropped rather than allowed to flow into the reasoning engine h…
      324| return parsed.flatMap((item) => {
         | ^
      325| const result = caseSchema.safeParse(item);
      326| const result.success ? [result.data] : [];
   ❯ LocalRepository.listCases src/data/local/local-repository.ts:143:19
   ❯ tests/data-layer.test.ts:1056:14

  FAIL tests/data-layer.test.ts > LocalRepository > a case index holding rows an older build wrote > reports the dropped case by collection and count, naming no record and no owner
  AssertionError: expected false to be true
   ❯ tests/data-layer.test.ts:1039:63
  ```
- If `detact:v1:${ownerId}:cases` is an object or non-array (e.g., from an older build, interrupted write, or external tool), `parsed.flatMap` throws an unhandled `TypeError`, crashing `listCases` and `loadWorkspace`.

### 1.3 Firebase Repository Offline Handling (`src/data/firebase/firebase-repository.ts`)
- **Persistence Configuration**: Lines 680–690:
  ```typescript
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    ignoreUndefinedProperties: true,
  });
  ```
  Falls back gracefully to `getFirestore(app)` if persistence is unsupported.
- **Commit Timeout & Durability**:
  - Constant: `COMMIT_ACK_TIMEOUT_MS = 10_000` (10 seconds, line 110).
  - Lines 800–823:
    ```typescript
    const durability = await Promise.race([
      acknowledgement.then((): CommitDurability => 'SERVER'),
      expiry,
    ]);
    if (durability === 'LOCAL_PENDING') absorbLateFailure(acknowledgement);
    return durability;
    ```
  - When disconnected from network, `batch.commit()` writes to the persistent local disk cache immediately, but server acknowledgement does not arrive.
  - After 10s, it resolves with `durability: 'LOCAL_PENDING'`. Late network rejections are absorbed via `absorbLateFailure()` to prevent unhandled promise rejections.
  - Multi-slice optimization: After the first slice hits `LOCAL_PENDING`, subsequent slices immediately absorb late failures without waiting another 10s.
- **Vulnerability in Mutation Hook (`src/services/use-case-store.ts`)**:
  Lines 311–320:
  ```typescript
  setInFlight((count) => count + 1);
  try {
    await repository.commit(ownerId, mutation.changes);
    return { ok: true, value: mutation };
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    return { ok: false, error: caught, value: mutation };
  } finally {
    setInFlight((count) => Math.max(0, count - 1));
  }
  ```
  `useMutator` drops the returned `CommitOutcome` (`durability`). While waiting 10 seconds for `COMMIT_ACK_TIMEOUT_MS` during an offline commit, `inFlight > 0` causes `busy === true`, locking button spinners for 10 seconds. The user is never notified that their change was committed locally (`LOCAL_PENDING`).

### 1.4 Network State Observation & UI Feedback
- **Toast Primitive**: `src/ui/primitives/Toast.tsx` exposes `ToastProvider` and `useToast()` with tones (`'ok' | 'warn' | 'crit' | 'accent' | 'neutral'`), swipe-to-dismiss, deduplication, and accessibility announcements. It is already mounted in `app/_layout.tsx`.
- **Current Network Monitoring**: No `@react-native-community/netinfo` dependency exists in `package.json`. No active network listener exists to update UI or fast-path `LOCAL_PENDING`.

---

## 2. Logic Chain

1. **Deterministic Rule Safety**:
   - Because `RULES` in `src/domain/rules/registry.ts` are 100% pure functions accepting `RuleContext` and returning `RuleFinding[]` without async/await or I/O, they can execute identically on device, offline, in cloud functions, or in Node.js test environments.
   - Because `runCaseAnalysis` (`src/data/mutations.ts`) applies rule findings through the standard `applyChanges` mutation pipeline, rule evaluations produce immediate optimistic in-memory workspace updates without network calls.

2. **Local Repository Stability**:
   - In `src/data/local/local-repository.ts`, `readShard` uses `Skipped.keep(collection, rows)` which checks `!Array.isArray(rows)` and safely drops non-array collections while logging warnings.
   - In contrast, `readIndex` directly invoked `parsed.flatMap(...)` on the raw JSON result.
   - When an index was stored as an object or corrupted structure, `parsed.flatMap` threw a `TypeError`.
   - By expanding `Skipped.keep` to accept `WorkspaceCollection` (which includes `'cases'`), and routing `readIndex` through `skipped.keep('cases', parsed)`, non-array structures are safely dropped as unreadable records, and the two failing tests in `tests/data-layer.test.ts` are resolved.

3. **Network Disconnect and Durability Feedback**:
   - When a network disconnect occurs while using `FirebaseRepository`, local writes succeed instantly in Firestore's persistent cache.
   - However, because `COMMIT_ACK_TIMEOUT_MS` is 10 seconds, `useMutator` blocks with `busy = true` for 10 seconds before resolving.
   - By capturing `durability` from `repository.commit()`:
     - `useMutator` can return `{ ok: true, durability, value: mutation }`.
     - When `durability === 'LOCAL_PENDING'`, the UI can trigger a non-intrusive toast (`"Saved offline. Will sync to cloud when connected."`).
     - An adaptive timeout or offline state tracking can short-circuit subsequent writes from waiting 10 seconds when the app is already operating in an offline state.

---

## 3. Caveats

- **Firestore `clear()` Requires Signal**: `FirebaseRepository.clear()` intentionally does NOT timeout to `LOCAL_PENDING`; an account deletion must be server-confirmed to ensure total deletion. This is by design according to the repository contract.
- **Binary Media Storage**: Evidence original files are stored locally on device via `expo-file-system` / IndexedDB (`evidence-storage.ts`). Cloudinary mirroring (`cloudinary.ts`) is optional and non-blocking (`try/catch` with `{ ok: false, reason: 'NETWORK' }`).
- **Web vs Native NetInfo**: Adding `@react-native-community/netinfo` requires native modules; for web/node environments, fallback to `typeof navigator !== 'undefined' ? navigator.onLine : true` or repository commit feedback ensures multi-platform compatibility without breaking Vitest.

---

## 4. Conclusion & Concrete Recommendations for Worker

### Recommendation 1: Fix `LocalRepository.readIndex` & `Skipped` in `src/data/local/local-repository.ts`
Modify `src/data/local/local-repository.ts` so `Skipped` accepts any `WorkspaceCollection` and `readIndex` parses safely:

```typescript
// In src/data/local/local-repository.ts:
class Skipped {
  private count = 0;

  keep(collection: WorkspaceCollection, rows: unknown): StoredRecord[] {
    if (!Array.isArray(rows)) {
      if (rows !== undefined && rows !== null) this.drop(collection);
      return [];
    }
    const kept: StoredRecord[] = [];
    for (const row of rows) {
      const parsed = RECORD_SCHEMAS[collection].safeParse(row);
      if (parsed.success) kept.push(parsed.data);
      else this.drop(collection);
    }
    return kept;
  }

  report(): void {
    if (this.count === 0) return;
    console.warn(
      `[local] read a case with ${this.count} unreadable record(s) skipped; ` +
        'those records are not visible in the app',
    );
  }

  private drop(collection: WorkspaceCollection): void {
    this.count += 1;
    console.warn(`[local] skipping malformed record in ${collection}`);
  }
}

// In LocalRepository:
private async readIndex(ownerId: string): Promise<Case[]> {
  const raw = await this.store.get(indexKey(ownerId));
  const parsed = parseJson<unknown>(raw, []);
  const skipped = new Skipped();
  const cases = skipped.keep('cases', parsed) as Case[];
  skipped.report();
  return cases;
}
```

### Recommendation 2: Surface `durability` in `useMutator` (`src/services/use-case-store.ts`)
Update `MutationResult` to pass through `durability`:
```typescript
export type MutationResult =
  | { ok: true; durability?: CommitDurability }
  | { ok: false; error: Error };
```
In `useMutator.mutate`:
```typescript
const outcome = await repository.commit(ownerId, mutation.changes);
return { ok: true, durability: outcome.durability, value: mutation };
```

### Recommendation 3: Provide Offline Toast / Indicator for `LOCAL_PENDING`
When a mutation returns `durability === 'LOCAL_PENDING'`, trigger a subtle informational toast via `useToast`:
```typescript
toast.show({
  tone: 'neutral',
  message: 'Saved offline. Changes will sync when reconnected.',
  duration: 4000,
});
```

### Recommendation 4: Fast-Path Subsequent Writes When Offline
Maintain a transient flag in `FirebaseRepository` or `useMutator`: when a commit times out with `LOCAL_PENDING`, mark `isOfflinePending = true` with a shorter timeout (e.g. 1,000ms) or check online status before embarking on a 10s wait, resetting when a write achieves `'SERVER'` acknowledgement.

---

## 5. Verification Method

1. **Data Layer Tests**:
   Execute:
   ```bash
   npx vitest run tests/data-layer.test.ts
   ```
   **Expected**: 74 of 74 tests pass (100%), including:
   - `reports the dropped case by collection and count, naming no record and no owner`
   - `still lists the readable cases of an index a build wrote as an object`

2. **Rule Engine Determinism Tests**:
   Execute:
   ```bash
   npx vitest run tests/rule-engine.test.ts tests/rule-engine-corpus.test.ts
   ```
   **Expected**: 72 of 72 tests pass (100%) with 0 network calls.

3. **Type Checking**:
   Execute:
   ```bash
   npm run typecheck
   ```
   **Expected**: Clean compilation with 0 TypeScript diagnostics.

4. **Invalidation Conditions**:
   - If any rule in `src/domain/rules/definitions/` introduces `async`, `fetch`, or non-injected clocks.
   - If `LocalRepository.readIndex` throws on non-array input.
   - If `commit()` in `FirebaseRepository` throws unhandled promise rejections upon late server responses.
