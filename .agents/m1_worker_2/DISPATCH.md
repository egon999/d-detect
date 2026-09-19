# Dispatch to Replacement Worker M1 (m1_worker_2)

You are the Replacement Worker for Milestone 1 (Cloud-Native Storage & Data Layer).
Your predecessor `m1_worker_1` stopped at Task 4 due to a 429 quota exhaustion.
Your working directory: e:/Project Evid/detact/.agents/m1_worker_2
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md

Predecessor progress:
- Task 1: COMPLETED (scratch probe test handled).
- Task 2: COMPLETED (`package.json` updated).
- Task 3: COMPLETED (`LocalRepository` checked).
- Task 4: PARTIALLY DONE. Note: in `src/services/storage/evidence-storage.ts:444`, there is an ECMAScript syntax error:
  `title: options.name ?? options.file?.name ?? name.replace(/\.[^/.]+$/, '').trim() || name,`
  Must be fixed with parentheses:
  `title: options.name ?? options.file?.name ?? (name.replace(/\.[^/.]+$/, '').trim() || name),`
  Also complete the Cloud Storage / Cloudinary mirroring in `evidence-storage.ts` and `src/services/storage/cloud-sync-queue.ts`.
- Task 5: Enhance `src/services/use-case-store.ts` for durability awareness.
- Task 6: Ensure unit tests pass for M1.
- Task 7: Run verification suite:
  - `npm run typecheck` (0 errors)
  - `npm test` (0 failures)
  - `npx expo-doctor` (all checks pass)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Output:
Write `e:/Project Evid/detact/.agents/m1_worker_2/handoff.md` and notify the orchestrator when complete.

## 2026-09-17T16:41:39Z
You are the Replacement Worker for Milestone 1 (m1_worker_2).
Your predecessor m1_worker_1 stopped at Task 4 due to a quota interruption.
Working directory: e:/Project Evid/detact/.agents/m1_worker_2
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md
Read DISPATCH.md in your working directory first.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Resume work from Task 4:
1. Fix line 444 in `src/services/storage/evidence-storage.ts`: wrap the logical expression in parentheses:
   `title: options.name ?? options.file?.name ?? (name.replace(/\.[^/.]+$/, '').trim() || name),`
2. Complete Cloud Storage / Cloudinary mirroring in `evidence-storage.ts` with local offline caching, and ensure `src/services/storage/cloud-sync-queue.ts` exists and handles offline retries cleanly.
3. Enhance `src/services/use-case-store.ts` for commit durability awareness.
4. Run:
   - `npm run typecheck` — MUST pass with 0 errors.
   - `npm test` — MUST pass all tests with 0 failures.
   - `npx expo-doctor` — verify all checks pass.

Write your handoff report to `e:/Project Evid/detact/.agents/m1_worker_2/handoff.md` and send a message to orchestrator when complete.

