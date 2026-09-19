# Adversarial Review & Handoff Report: Milestone 2 Deliverables

**Reviewer**: M2 Reviewer 2 (Reviewer & Adversarial Critic)  
**Target Milestone**: Milestone 2 — Multimodal Ingestion & Immediate Deduplication Pipeline  
**Verdict**: **APPROVE**  
**Integrity Violations**: **NONE (0 detected)**  
**Date**: 2026-09-17  

---

## 1. Executive Summary & Review Verdict

Following a thorough adversarial inspection of Milestone 2 deliverables across `src/services/ingestion/dedup.ts`, `src/services/ingestion/ingest.ts`, and `app/case/[caseId]/upload.tsx`, along with full empirical test runs:

- **Verdict**: **APPROVE**
- **Integrity Assessment**: No hardcoded test digests, no dummy facades, no bypassed tasks, and no fabricated assertions. All hashing and ingestion pathways implement authentic cryptographic and parsing logic.
- **Edge Case & Boundary Resilience**: Empty (0-byte) files, multi-megabyte streams, oversized files (>100 MB), truncated streams, malformed URIs, and Unicode/Indic paths are reliably handled without process termination or unhandled rejections.
- **UI Responsiveness**: Pre-upload duplicate detection operates immediately upon picker selection with high-visibility warning chips, non-blocking user agency, and dynamic warning clearance upon item removal.

---

## 2. Observation

### 2.1 File Implementations Examined

1. **`src/services/ingestion/dedup.ts`**:
   - `computeFileSha256(file: PickedFile): Promise<string>`:
     - Handles Data URIs (both base64 and URI-encoded) (lines 33–57).
     - Dynamically imports `read-file` in React Native/Expo environments, leveraging `sha256File` streaming for files >2MB (lines 59–75).
     - In Node.js environments (test runners), streams via `fs.createReadStream` into `@noble/hashes/sha2.js` (lines 78–111).
     - Computes canonical SHA-256 (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) for 0-byte files without unnecessary I/O.
     - Web fetch streaming for `blob:`, `http://`, and `https://` URLs (lines 114–121).
   - `checkDuplicateBeforeUpload(file: PickedFile, existingEvidence: Evidence[]): Promise<DuplicateCheckResult>`:
     - Normalizes hashes (`toLowerCase().trim()`).
     - Ignores deleted records (`!item.deletedAt`) and records without hashes (`!item.sha256`).
     - Returns `{ isDuplicate: boolean, matchedEvidence?: Evidence, sha256: string }`.
   - `checkBatchDuplicatesBeforeUpload(files: PickedFile[], existingEvidence: Evidence[]): Promise<BatchDuplicateResult[]>`:
     - Evaluates files against case evidence first (scope `'case'`), then against earlier files within the batch (scope `'batch'`).
     - Maintains a map of seen batch hashes, correctly identifying the second occurrence as a duplicate pointing to the first.

2. **`src/services/ingestion/ingest.ts` & Supporting Storage Modules**:
   - `ingestFile(file: PickedFile): Promise<IngestResult>`:
     - Modalities: PDF (text layer & scanned page image OCR via ML Kit Latin/Devanagari), Images (ML Kit on-device OCR), Audio (Groq Whisper API), Video (Whisper transcription + frame OCR sampling + merged chronology), Office XML (`pako` inflation of DOCX/XLSX/PPTX), CSV/TSV (RFC 4180 parsing + column flattening), Email (RFC 822/MIME parsing), RTF (token-based formatting removal), and Text.
     - Memory Bounds:
       - Audio/Video: Handled purely as URIs; never read into JS memory buffers (lines 1134–1141).
       - Text/CSV/EML/RTF: Read up to `TEXT_PREFIX_BYTES` (2 MB) via `readPrefix` (lines 1197–1206), while `sha256File` streams the whole file for the original digest.
       - CSV: Flat rows capped at `MAX_CSV_ROWS` (5,000 rows). Partial cut rows at the end of a truncated prefix are pruned (`parsed.slice(0, -1)`) to avoid recording truncated numbers (lines 1676–1677).
       - Office XML: `MAX_MEMBERS = 512`, `MAX_MEMBER_BYTES = 8 MB`, `MAX_TEXT_CHARS = 1,000,000` (in `office-docs.ts:54-61`) protecting against zip bombs.
     - Corrupt Streams:
       - `stream-copy.ts` (`copyWithDigest` & `digestStream`): Explicitly checks `copied !== total` / `read !== total`. If early EOF occurs, throws: `"The file could not be read completely — it may have been moved or deleted. Select it again."` (lines 160, 207). Prevents truncated files from masquerading under false digests.

3. **`app/case/[caseId]/upload.tsx`**:
   - `addItemsAndCheckDuplicates(newItems: Item[])`:
     - Invoked immediately upon selection across `DocumentPicker.getDocumentAsync`, `ImagePicker.launchImageLibraryAsync`, `ImagePicker.launchCameraAsync`, and voice memos (lines 129–161).
     - Loops sequentially through added items, computing SHA-256 and evaluating duplicates against case evidence and batch predecessors.
     - Traps errors in `try / catch` (lines 157–159) ensuring that unreadable files fall back gracefully to standard upload error handling without freezing the UI.
   - UI Rendering & Feedback:
     - Renders a prominent warning `Chip`:
       ```tsx
       <Chip
         label={`Duplicate of: ${item.duplicate.title} (SHA-256: ${item.sha256.slice(0, 8)})`}
         tone="warn"
         icon="alert-circle-outline"
       />
       ```
     - Displays secondary contextual clarification distinguishing case collisions from intra-batch collisions (lines 541–543).
     - Offers `"Remove from selection"` button (`removeItem(id)`).
     - In `removeItem(id)` (lines 163–184), recomputes batch duplicate states across all remaining items, automatically clearing stale duplicate warnings if the predecessor is removed.
     - Upload is non-blocking: users may still proceed to save duplicate files if legitimately desired.

### 2.2 Independent Verification Tool Outputs

1. **`npm run typecheck`**:
   ```
   > detact@1.0.0 typecheck
   > tsc --noEmit
   (Exit code 0, 0 errors)
   ```

2. **`npx vitest run tests/dedup-on-selection.test.ts`**:
   ```
   ✓ tests/dedup-on-selection.test.ts (13 tests) 1044ms
   Test Files  1 passed (1)
        Tests  13 passed (13)
   (Exit code 0)
   ```

3. **`npx vitest run tests/m2-challenger-dedup-stress.test.ts tests/m2-challenger-expo-pathway.test.ts`**:
   ```
   ✓ tests/m2-challenger-expo-pathway.test.ts (3 tests) 28ms
   ✓ tests/m2-challenger-dedup-stress.test.ts (24 tests) 1018ms
   Test Files  2 passed (2)
        Tests  27 passed (27)
   (Exit code 0)
   ```

4. **`npx vitest run tests/e2e/`**:
   ```
   ✓ tests/e2e/tier4-scenarios.test.ts (9 tests) 77ms
   ✓ tests/e2e/tier3-combinations.test.ts (14 tests) 96ms
   ✓ tests/e2e/tier2-boundaries.test.ts (20 tests) 1542ms
   ✓ tests/e2e/tier1-features.test.ts (80 tests) 1558ms
   Test Files  4 passed (4)
        Tests  123 passed (123)
   (Exit code 0)
   ```

5. **`npm test`**:
   ```
   Test Files  83 passed | 1 skipped (84)
        Tests  1721 passed | 58 skipped (1779)
   Duration    22.79s
   (Exit code 0, 0 failures)
   ```

6. **`npx expo-doctor`**:
   ```
   Running 20 checks on your project...
   20/20 checks passed. No issues detected!
   (Exit code 0)
   ```

---

## 3. Logic Chain

1. **Integrity & Authenticity**:
   - Source code search for hardcoded digests revealed no stubbed hashes or predetermined return values.
   - `computeFileSha256` invokes `@noble/hashes/sha2.js` and streaming I/O.
   - Cryptographic equivalence was tested against `node:crypto` across 1B, 1KB, 64KB, and 2MB buffers, matching byte-for-byte.
   - Bit-flip avalanche tests across 14 distinct bit offsets verified zero false positives or hash collisions.
   - Conclusion: Implementations are authentic and free of integrity violations.

2. **Memory & Concurrency Bounds**:
   - `upload.tsx` processes duplicate checks sequentially (`for (const item of newItems) await checkDuplicateBeforeUpload(...)`), preventing concurrent thread contention or unbounded buffer allocations on mobile.
   - Disk and Expo file hashing uses 1 MB chunked streams (`digestStream`). Peak memory for hashing an 80 MB file is clamped to ~1 MB.
   - Files >100 MB are flagged as `'failed'` immediately upon selection (`source.size > MAX_EVIDENCE_UPLOAD_BYTES`), preventing memory allocation.
   - Ingestion text reads clamp to 2 MB (`TEXT_PREFIX_BYTES`), preventing multi-hundred megabyte heap bloat on 100 MB log files.
   - Conclusion: Memory bounds are strictly enforced and resilient against mobile OOM conditions.

3. **Stream Truncation & Corruption Safety**:
   - Both `copyWithDigest` and `digestStream` enforce `read === totalBytes`. Truncated inputs abort rather than producing valid hashes of partial reads.
   - `trimPartialUtf8` removes orphaned UTF-8 lead bytes at prefix boundaries, preventing spurious binary rejections.
   - `parseCsv` drops partial trailing rows on prefix boundaries, preventing truncated figures from being ingested as facts.
   - Conclusion: Corrupt and truncated streams are handled without data pollution.

4. **UI Responsiveness & Ergonomics**:
   - Warning chips with SHA-256 prefixes provide immediate, understandable feedback upon selection.
   - The user retains full agency: they can remove duplicate items via `"Remove from selection"` or proceed with upload.
   - Removing an earlier item re-evaluates remaining items, clearing stale batch duplicate warnings.
   - Conclusion: UI feedback in `upload.tsx` meets all UX requirements.

---

## 4. Adversarial Findings & Observations

### [Minor] Finding 1: Malformed Percent Encoding in Data URIs
- **Observation**: In `src/services/ingestion/dedup.ts:54`, `decodeURIComponent(data)` is used for non-base64 data URIs. If a URI contains an invalid percent sequence (e.g. `%ZZ`), `decodeURIComponent` throws a `URIError`.
- **Impact**: In `upload.tsx`, this is caught by the surrounding `try / catch` (line 157) and falls back gracefully to standard upload processing. If invoked directly via `checkBatchDuplicatesBeforeUpload` by an external consumer with unvalidated data URIs, the promise will reject.
- **Risk Level**: LOW. Standard document pickers yield `file://` or `content://` URIs, and data URIs from voice memos are base64-encoded.
- **Mitigation Recommendation**: In future polish, wrap `decodeURIComponent` with a try/catch or fallback to raw bytes.

---

## 5. Caveats

- **Native Hardware Camera Drivers**: In Vitest and Node test environments, native camera hardware and hardware video decoders are mocked or exercised through headless file abstractions. Real hardware camera permissions and frame decoders must be verified on physical Android devices during final release APK testing (M6).

---

## 6. Conclusion

Milestone 2 (Multimodal Ingestion & Immediate Deduplication Pipeline) fulfills all requirements specified in `PROJECT.md` and `ORIGINAL_REQUEST.md`:
1. Immediate duplicate detection on selection via content-addressable SHA-256 is fully operational.
2. Memory bounds, oversized file protections, corrupt stream guards, and decompression bomb defenses are robust.
3. UI feedback in `upload.tsx` is responsive, non-blocking, and accurate.
4. All 1,721 test cases and 123 E2E test cases pass with zero failures.

**Final Verdict**: **APPROVE**

---

## 7. Verification Method

To independently verify this assessment, run the following commands from the project root (`e:/Project Evid/detact`):

```bash
# 1. Typecheck
npm run typecheck

# 2. Duplicate Detection Unit Suite
npx vitest run tests/dedup-on-selection.test.ts

# 3. Adversarial Stress & Expo Pathway Suites
npx vitest run tests/m2-challenger-dedup-stress.test.ts tests/m2-challenger-expo-pathway.test.ts

# 4. Comprehensive E2E Test Suite (Tiers 1-4)
npx vitest run tests/e2e/

# 5. Full Test Suite
npm test

# 6. Expo Configuration & Dependency Doctor
npx expo-doctor
```
