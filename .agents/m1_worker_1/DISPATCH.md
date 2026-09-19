## 2026-09-17T16:11:34Z

# Dispatch to M1 Worker: Cloud-Native Storage & Data Layer

You are Worker M1 (Implementation Specialist).
Your working directory: e:/Project Evid/detact/.agents/m1_worker_1
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md

Read the 3 M1 Explorer reports first:
- e:/Project Evid/detact/.agents/m1_explorer_1/handoff.md (Cloud Storage & Cloudinary Mirroring)
- e:/Project Evid/detact/.agents/m1_explorer_2/handoff.md (Test Baseline & Config Alignment)
- e:/Project Evid/detact/.agents/m1_explorer_3/handoff.md (Offline Resilience & LocalRepository Fix)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusively Owned Files for this Milestone:
- `tests/scratch-probe.test.ts` (delete or remove)
- `vitest.config.mts` (add exclude pattern for scratch tests)
- `package.json` (update `"lint:expo"` to `"npx expo-doctor"`, add `"expo-asset": "~55.0.20"` to `"dependencies"`, add expo doctor config)
- `src/services/storage/evidence-storage.ts` (wire Cloudinary / cloud mirroring with local cache)
- `src/services/storage/cloud-sync-queue.ts` (create offline retry queue)
- `src/data/local/local-repository.ts` (fix `readIndex` defect per M1 Explorer 3)
- `src/services/use-case-store.ts` (durability awareness)
- Unit tests verifying M1 functionality under `tests/`

Implementation Tasks:
1. Restore 100% test baseline: Delete `tests/scratch-probe.test.ts` and update `vitest.config.mts` exclude list.
2. Fix `package.json`: Update `"lint:expo": "npx expo-doctor"`, add `"expo-asset": "~55.0.20"` to `"dependencies"`, and add doctor exclude for `@react-native-ml-kit/text-recognition`.
3. Fix `LocalRepository.readIndex`: Add array guard / `WorkspaceCollection` support so invalid or object index structures don't throw `TypeError`.
4. Implement Cloud Storage Mirroring in `evidence-storage.ts`:
   - Keep local file persistence instant via `copyWithDigest` / IndexedDB.
   - When authenticated with cloud enabled, call `mirrorToCloud` / Cloudinary upload.
   - Catch network errors safely, mark upload status PENDING for background retry in `cloud-sync-queue.ts`, zero unhandled rejections.
5. Run build and tests:
   - Run `npm run typecheck` — MUST pass with 0 errors.
   - Run `npm test` — MUST pass 100% of tests with 0 failures.
   - Run `npx expo-doctor` — verify all checks pass.

Output:
Write your handoff report to `e:/Project Evid/detact/.agents/m1_worker_1/handoff.md`. Include exact verification commands, test output, and file diff summaries. Send a message to the orchestrator when complete.

## 2026-09-17T16:15:30Z
Error: The stream was interrupted. Please continue the task you were working on.

## 2026-09-17T16:21:48Z
**Context**: Implementation in `src/services/storage/evidence-storage.ts`
**Content**: Syntax error detected on line 444:
`title: options.name ?? options.file?.name ?? name.replace(/\.[^/.]+$/, '').trim() || name,`
Mixing `??` and `||` without parentheses violates ECMAScript and fails the Vite/OXC parser with `[PARSE_ERROR] Logical expressions and coalesce expressions cannot be mixed`.
**Action**: Please wrap the logical expression in parentheses immediately:
`title: options.name ?? options.file?.name ?? (name.replace(/\.[^/.]+$/, '').trim() || name),`
Verify with `npm run typecheck` and `npm test`.
