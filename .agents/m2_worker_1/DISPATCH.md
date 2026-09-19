# Dispatch to Worker M2: Multimodal Ingestion & Immediate Deduplication Pipeline

You are Worker M2 (Implementation Specialist).
Your working directory: e:/Project Evid/detact/.agents/m2_worker_1
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusively Owned Files:
- `src/services/ingestion/dedup.ts` (create/implement)
- `app/case/[caseId]/upload.tsx` (update selection UI with duplicate detection & chips)
- `src/services/ingestion/ingest.ts` (multimodal intake robustness)
- `tests/dedup-on-selection.test.ts` (unit tests for deduplication on selection)

Implementation Tasks:
1. Implement `src/services/ingestion/dedup.ts`:
   - Export `checkDuplicateBeforeUpload(file: PickedFile, existingEvidence: Evidence[]): Promise<{ isDuplicate: boolean; matchedEvidence?: Evidence; sha256: string }>`.
   - Reads file bytes/stream, computes SHA-256 via `@noble/hashes`, and checks against existing case evidence by hash.
2. Update `app/case/[caseId]/upload.tsx`:
   - Immediately when the user picks files from image/document pickers, run `checkDuplicateBeforeUpload`.
   - Display an inline warning badge/chip on the selected item card: "Duplicate of: [Title] (SHA-256: [hash prefix])".
   - Allow user to remove the duplicate before upload or proceed with caution.
3. Verify multimodal intake in `src/services/ingestion/ingest.ts`:
   - Ensure PDF, Office (DOCX/XLSX/PPTX), images, audio/video (Groq Whisper), and structured notes are handled cleanly with zero unhandled exceptions or hangs.
4. Author comprehensive unit tests in `tests/dedup-on-selection.test.ts` testing:
   - Instant duplicate detection for identical bytes.
   - Non-duplicate verification for distinct files.
   - Handling of empty files, large files, and multiple duplicates in batch.
5. Run the full verification suite:
   - `npm run typecheck` (MUST pass with 0 errors)
   - `npm test` (MUST pass with 0 failures)
   - `npx expo-doctor` (MUST pass 20/20 checks)

Output:
Write `e:/Project Evid/detact/.agents/m2_worker_1/handoff.md` and send a message to orchestrator when complete.
