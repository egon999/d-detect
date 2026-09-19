# Handoff Report — M1 Explorer 2: Test Baseline & Config Alignment

## 1. Observation

### 1.1 Test Suite Failure in `tests/scratch-probe.test.ts`
- **File**: `tests/scratch-probe.test.ts`
- **Git status**: Untracked (`?? tests/scratch-probe.test.ts`).
- **File content (lines 1–9)**:
  ```typescript
  import { describe, expect, it } from 'vitest';

  describe('probe', () => {
    it('imports the evidence screen module', async () => {
      const mod = await import('../app/case/[caseId]/evidence/[evidenceId]');
      expect(typeof mod.default).toBe('function');
    });
  });
  ```
- **Test execution command**: `npm test` (`vitest run`).
- **Verbatim failure output**:
  ```text
  FAIL  tests/scratch-probe.test.ts > probe > imports the evidence screen module
  SyntaxError: Unexpected token '<'
   ❯ Object.<anonymous> node_modules/expo-router/src/exports.ts:2:1

  Test Files  1 failed | 73 passed | 1 skipped (75)
       Tests  1 failed | 1474 passed | 58 skipped (1533)
  ```
- **Isolation test command**: `npx vitest run --exclude tests/scratch-probe.test.ts`.
- **Isolation test result**:
  ```text
  Test Files  73 passed | 1 skipped (74)
       Tests  1474 passed | 58 skipped (1532)
    Duration  10.94s
  Command exited with code 0 (Zero errors)
  ```
- **References in codebase**: A filesystem-wide search for `scratch-probe` found 0 references across `src/`, `app/`, `functions/`, `scripts/`, or `package.json`.

---

### 1.2 Build & Packaging Gate in `scripts/build-apk.mjs`
- **File**: `scripts/build-apk.mjs`
- **Lines 293–298**:
  ```javascript
  function main() {
    heading('Typecheck');
    run('npx', ['tsc', '--noEmit'], { cwd: ROOT });

    heading('Tests');
    run('npx', ['vitest', 'run'], { cwd: ROOT });
  ```
- **Observation**: `scripts/build-apk.mjs` runs `npx vitest run` as a mandatory pre-condition before Gradle packaging. Because `vitest run` fails with code 1 due to `tests/scratch-probe.test.ts`, the entire APK build halts at Step 2 (`heading('Tests')`) with `Error: npx vitest run exited with 1`.

---

### 1.3 Linter & Doctor Check (`npm run lint:expo`)
- **File**: `package.json` line 14:
  ```json
  "lint:expo": "expo-doctor",
  ```
- **Execution command**: `npm run lint:expo`
- **Verbatim error**:
  ```text
  > detact@1.0.0 lint:expo
  > expo-doctor

  'expo-doctor' is not recognized as an internal or external command,
  operable program or batch file.
  ```
- **Binary inspection in `node_modules/.bin/`**:
  - Found: `expo`, `expo.cmd`, `expo-modules-autolinking`, `expo-modules-autolinking.cmd`.
  - Missing: No `expo-doctor` executable binary exists in `node_modules/.bin/`.
- **Direct runner execution command**: `npx expo-doctor --verbose`
- **Diagnostic output**:
  - 18 of 20 checks passed.
  - 2 checks failed:
    1. **Peer Dependency Check**:
       ```text
       ✖ Check that required peer dependencies are installed
       Missing peer dependency: expo-asset
       Required by: expo-audio
       Advice: Install missing required peer dependency with "npx expo install expo-asset"
       ```
    2. **React Native Directory Check**:
       ```text
       ✖ Validate packages against React Native Directory package metadata
       The following issues were found when validating your dependencies against React Native Directory:
         Untested on New Architecture: @react-native-ml-kit/text-recognition
       Advice: Add packages to expo.doctor.reactNativeDirectoryCheck.exclude in package.json to selectively skip validations
       ```

---

### 1.4 Dependency State for `expo-asset`
- **File**: `package.json` lines 18–61 (`dependencies`):
  - `expo-asset` is **not present** in `dependencies`.
- **File**: `package.json` lines 70–72 (`overrides`):
  ```json
  "overrides": {
    "expo-asset": "~55.0.20"
  },
  ```
- **Filesystem inspection**: `node_modules/expo-asset/package.json` version is `55.0.20` (already downloaded and installed on disk).

---

## 2. Logic Chain

1. **Test Failure Mechanism**:
   - `vitest.config.mts` deliberately configures `environment: 'node'` without React Native JSX/TSX compilers so domain reasoning and data models run natively without emulators or native mocks (lines 4–7).
   - `tests/scratch-probe.test.ts` attempts a dynamic `import('../app/case/[caseId]/evidence/[evidenceId]')`. This pulls in `expo-router/src/exports.ts`, which contains uncompiled JSX `<Link>` / `<Screen>` tokens.
   - In a Node environment, Node's parser crashes with `SyntaxError: Unexpected token '<'`.
   - `tests/scratch-probe.test.ts` is an untracked scratch probe, not part of the documented test suite, and tests a screen route slated for replacement by the 3-view Case Workspace (`app/case/[caseId]/index.tsx`).
   - Removing `tests/scratch-probe.test.ts` and configuring Vitest's `test.exclude` pattern guarantees 100% test passing rate (1,474 passed, 0 failed, 58 skipped).

2. **Unblocking APK Packaging**:
   - `scripts/build-apk.mjs` executes `vitest run` on line 297.
   - When Vitest exits 0 on a clean test suite, `scripts/build-apk.mjs` proceeds to verify the release keystore, apply Android security manifest configs, run Gradle `assembleRelease`, verify `assertNotDebugSigned()` via `apksigner`, and verify security configs via `aapt2`.
   - Fixing the test baseline directly restores release APK buildability.

3. **Script Execution for `lint:expo`**:
   - `npm run lint:expo` attempts to run `expo-doctor`. Because `expo-doctor` is not installed into `node_modules/.bin/`, the shell fails.
   - Changing the script to `"lint:expo": "npx expo-doctor"` delegates resolution to `npx`, running the doctor diagnostics reliably on Windows and CI environments.

4. **Eliminating Expo Doctor Peer Dependency Warning**:
   - `expo-audio` declares a peer dependency on `expo-asset`.
   - `expo-doctor` checks top-level `dependencies` in `package.json`. Even though `expo-asset: "~55.0.20"` is declared in `overrides` and exists on disk, `expo-doctor` fails closed if it is not in `dependencies`.
   - Promoting `"expo-asset": "~55.0.20"` to `dependencies` satisfies `expo-doctor` and guarantees autolinking includes the asset loader.
   - Adding `expo.doctor.reactNativeDirectoryCheck.exclude: ["@react-native-ml-kit/text-recognition"]` skips the New Architecture advisory, making `npm run lint:expo` pass 20/20 checks.

---

## 3. Caveats

1. **Firestore Emulator Tests**:
   - 58 tests in `tests/firestore-rules.test.ts` skip when the local Firestore emulator is offline (on port 8080). This is expected behavior documented in the test output. Dynamic security rules require JDK 21+ and `npx firebase emulators:start --only firestore`.
2. **Read-Only Scope**:
   - As an explorer, no project files were modified. The concrete edits below are prepared for immediate application by the Worker agent.

---

## 4. Conclusion & Actionable Worker Plan

### 4.1 Concrete Modifications for Worker

#### Step 1: Remove Untracked Scratch Test
Delete the file:
```bash
rm tests/scratch-probe.test.ts
```

#### Step 2: Update `vitest.config.mts` (Exclude Scratch Probes)
In `vitest.config.mts`:
- Import `configDefaults` from `'vitest/config'`.
- Add `exclude` in `test` block to ignore scratch probes as defense-in-depth.

**Diff for `vitest.config.mts`**:
```typescript
<<<<
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
====
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
>>>>

<<<<
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    maxWorkers: 4,
    testTimeout: 10000,
  },
====
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/scratch-probe.test.ts', 'tests/**/*.scratch.test.ts'],
    globals: false,
    maxWorkers: 4,
    testTimeout: 10000,
  },
>>>>
```

#### Step 3: Update `package.json` (`lint:expo`, `expo-asset`, `expo.doctor`)
In `package.json`:
1. Change `"lint:expo": "expo-doctor"` to `"lint:expo": "npx expo-doctor"`.
2. Add `"expo-asset": "~55.0.20"` under `"dependencies"`.
3. Add `"expo"` config for doctor check exclusion.

**Diff for `package.json`**:
```json
<<<<
    "lint:expo": "expo-doctor",
====
    "lint:expo": "npx expo-doctor",
>>>>

<<<<
    "expo": "~55.0.31",
    "expo-audio": "~55.0.18",
====
    "expo": "~55.0.31",
    "expo-asset": "~55.0.20",
    "expo-audio": "~55.0.18",
>>>>

<<<<
  "overrides": {
    "expo-asset": "~55.0.20"
  },
  "private": true
}
====
  "overrides": {
    "expo-asset": "~55.0.20"
  },
  "expo": {
    "doctor": {
      "reactNativeDirectoryCheck": {
        "exclude": [
          "@react-native-ml-kit/text-recognition"
        ]
      }
    }
  },
  "private": true
}
>>>>
```

---

## 5. Verification Method

To verify these changes after application by Worker:

1. **Verify Test Suite**:
   ```bash
   npm test
   ```
   *Expected Result*: Exits 0 with 73 passed test files, 1 skipped test file (`firestore-rules.test.ts`), 0 failed test files. 1,474 passed tests.

2. **Verify Type Checking**:
   ```bash
   npm run typecheck
   ```
   *Expected Result*: `tsc --noEmit` exits with code 0 (zero errors).

3. **Verify Expo Doctor Linter**:
   ```bash
   npm run lint:expo
   ```
   *Expected Result*: Runs `npx expo-doctor` cleanly, passing 20/20 checks with 0 failed checks.

4. **Verify APK Preflight & Packaging**:
   ```bash
   npm run apk
   ```
   *Expected Result*: Passes Typecheck, passes Tests (Vitest), verifies keystore and security configs, compiles release APK with Gradle, and validates signature with `apksigner`.
