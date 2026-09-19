# BRIEFING — 2026-09-17T16:11:30Z

## Mission
Investigate offline resilience, deterministic offline rule execution, and network disconnect handling across Firebase, LocalRepository, and Domain Rules, formulating concrete recommendations for Worker.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigation, synthesis
- Working directory: e:/Project Evid/detact/.agents/m1_explorer_3
- Original parent: 1bb3d463-48e2-4165-9c4e-fbe369e86bec
- Milestone: M1

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Examine `src/data/firebase/firebase-repository.ts`, `src/data/local/local-repository.ts`, and `src/domain/rules/registry.ts`
- Verify offline-resilience mechanisms: deterministic offline rules execution, handling network disconnects without throwing unhandled exceptions
- Provide concrete recommendations for Worker

## Current Parent
- Conversation ID: 1bb3d463-48e2-4165-9c4e-fbe369e86bec
- Updated: 2026-09-17T16:11:30Z

## Investigation State
- **Explored paths**:
  - `src/data/firebase/firebase-repository.ts`: Analyzed `COMMIT_ACK_TIMEOUT_MS`, `acknowledgedWithin`, `absorbLateFailure`, `persistentLocalCache`, `watchWorkspace`, `loadWorkspace`.
  - `src/data/local/local-repository.ts`: Identified fatal crash in `readIndex` (`parsed.flatMap is not a function` when case index is non-array or drifted).
  - `src/domain/rules/registry.ts`, `engine.ts`, `types.ts`, and 16 definitions: Verified 100% pure synchronous in-memory execution, zero network calls, deterministic IDs.
  - `src/services/use-case-store.ts`: Discovered unhandled 10s blocking in `useMutator` on offline commits and discarded `LOCAL_PENDING` durability.
  - `src/ui/primitives/Toast.tsx`: Identified available toast mechanism for offline status alerting.
  - Test suite run: Verified 1,477 passing tests; pinpointed exact failures in `tests/data-layer.test.ts`.
- **Key findings**:
  - Deterministic rules engine has 16 pure, synchronous, zero-I/O rules passing all tests.
  - `LocalRepository.readIndex` has a defect causing unhandled exceptions on non-array index data.
  - `FirebaseRepository` absorbs late write rejections cleanly via `absorbLateFailure` and reports `LOCAL_PENDING`, but `useMutator` drops `durability` and holds busy spinner for 10s.
- **Unexplored areas**: None within M1 Explorer 3 scope.

## Key Decisions Made
- Formulate concrete code fixes and architectural recommendations for Worker.
- Document exact diffs and verification tests.

## Artifact Index
- `e:/Project Evid/detact/.agents/m1_explorer_3/handoff.md` — Strategy and handoff report
