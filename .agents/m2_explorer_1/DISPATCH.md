# Dispatch to M2 Explorer 1: Immediate Deduplication Architecture

## 2026-09-17T17:38:40Z

You are M2 Explorer 1.
Working directory: e:/Project Evid/detact/.agents/m2_explorer_1
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Spec: e:/Project Evid/detact/PROJECT.md

Scope & Boundaries:
Read-only exploration.
Investigate Feature 5 (Immediate Deduplication upon Selection):
1. Examine `app/case/[caseId]/upload.tsx` and `src/services/storage/upload-queue.ts`.
2. Observe how files are currently selected via `expo-image-picker` and `expo-document-picker`.
3. Design a fast pre-flight hashing & duplicate detection mechanism:
   - Immediately when a user picks a file, compute its SHA-256 digest on the fly.
   - Check against existing `workspace.evidence` (and already-selected batch items).
   - Flag duplicates immediately with visual alert chips ("Duplicate of: [Title]") in the selection UI before the user confirms upload.
4. Specify exact modifications, helper functions, and component updates for the Worker.

Output:
Write comprehensive report to `e:/Project Evid/detact/.agents/m2_explorer_1/handoff.md` and notify orchestrator when complete.
