# Forensic Audit Report: Milestone 2

**Work Product**: Milestone 2 — Multimodal Ingestion & Immediate Deduplication Pipeline
**Profile**: General Project
**Verdict**: CLEAN

---

## 1. Observation

Direct empirical observations from code inspection and test execution:

### 1. Genuine SHA-256 Computation in `src/services/ingestion/dedup.ts`
- **Noble Hashes Import**:
  Lines 8-9:
  ```ts
  import { sha256 } from '@noble/hashes/sha2.js';
  import { bytesToHex } from '@noble/hashes/utils.js';
  ```
- **Byte Level Hashing & Streaming**:
  - Data URIs (Lines 33-56): Decodes base64 or URL-encoded bytes, evaluates `bytesToHex(sha256(bytes))`.
  - Expo/React Native FileSystem (Lines 59-75): Calls `readFile.readBytes(uri)` or chunked `readFile.sha256File(uri, size)`. Empty files hash via `bytesToHex(sha256(new Uint8Array(0)))`.
  - Node.js Filesystem Streams (Lines 78-107): Uses `fs.createReadStream` and incremental `hasher = sha256.create()`, updating per chunk and resolving `bytesToHex(hasher.digest())`.
  - Web fetch (Lines 114-121): Resolves `response.arrayBuffer()` and computes `bytesToHex(sha256(new Uint8Array(arrayBuffer)))`.
- **Absence of Hardcoded Digests**:
  - Grep search for hardcoded hash digests (e.g., standard empty hash `e3b0c442...`) returned 0 occurrences in `dedup.ts`. Every single return statement returns calculated bytes or hashes (`bytesToHex(sha256(...))`).

### 2. Genuine Duplicate Checking Against Case Evidence & Batch Files
- **Single File Duplicate Check (`checkDuplicateBeforeUpload`)**:
  Lines 136-154:
  ```ts
  const fileHash = await computeFileSha256(file);
  const normalizedHash = fileHash.toLowerCase().trim();

  const matched = existingEvidence.find((item) => {
    if (item.deletedAt) return false;
    if (!item.sha256) return false;
    return item.sha256.toLowerCase().trim() === normalizedHash;
  });

  return {
    isDuplicate: Boolean(matched),
    matchedEvidence: matched,
    sha256: normalizedHash,
  };
  ```
  Verified: Ignores deleted items (`deletedAt`), ignores records without hashes (`!item.sha256`), and performs normalized hex comparison against active case evidence.
- **Batch Duplicate Check (`checkBatchDuplicatesBeforeUpload`)**:
  Lines 169-215:
  Maintains `seenBatchHashes = new Map<string, PickedFile>()`. Accurately checks against existing case evidence (yielding `scope: 'case'`) and previously encountered files in the batch (yielding `scope: 'batch'`), correctly prioritizing case collisions over intra-batch collisions.

### 3. Immediate Selection UI & Dynamic Warning Chip in `app/case/[caseId]/upload.tsx`
- **Immediate Selection Hookup**:
  Lines 129-160: `addItemsAndCheckDuplicates` runs immediately upon selecting files via `pick()` (`DocumentPicker` / `ImagePicker`), `takePhoto()`, and `keepMemo()`.
- **Dynamic Chip Rendering**:
  Lines 532-543:
  ```tsx
  {item.duplicate && item.sha256 ? (
    <Row gap="sm" align="center">
      <Chip
        label={`Duplicate of: ${item.duplicate.title} (SHA-256: ${item.sha256.slice(0, 8)})`}
        tone="warn"
        icon="alert-circle-outline"
      />
    </Row>
  ) : null}
  {item.duplicate ? <Text colorToken="textSecondary">{item.duplicate.scope === 'case'
    ? `Same file as "${item.duplicate.title}", already saved in this case. Both are kept; the analysis treats identical files as one document.`
    : `Same file as "${item.duplicate.title}", picked earlier in this batch.`}</Text> : null}
  ```
- **Pre-Upload Removal Support**:
  Lines 163-184: `removeItem(id)` filters out the removed file and re-evaluates duplicate states among remaining batch items, clearing stale batch warnings dynamically.

### 4. Multimodal Robustness in `src/services/ingestion/ingest.ts`
- Modalities verified:
  - PDF (lines 1157-1303): `extractPdfText` & `extractPdfImages`
  - Images (lines 1305-1380): on-device ML Kit Latin & Devanagari OCR via `orderRecognisedLines`
  - Audio (lines 1383-1464): `transcribeMedia` with Groq Whisper
  - Video (lines 1467-1562): `readVideoFrameText` + `transcribeMedia` + `mergeMediaText`
  - Office documents (lines 1565-1644): `extractOfficeText` (DOCX, XLSX, PPTX via `pako` inflation)
  - Text, CSV, EML, RTF (lines 1646-1859): `decodeUtf8`, `parseCsv`, `parseEml`, `stripRtf`
- Comprehensive error encapsulation: Each parser block wraps execution in robust `try/catch` handlers returning structured `IngestResult` with `method: 'none'` and honest notes. Zero unhandled promise rejections or exceptions.

### 5. Non-Tautological Assertions in `tests/dedup-on-selection.test.ts`
- 13 distinct, fully populated unit tests:
  - Byte-for-byte SHA-256 calculation and duplicate matching against mock evidence.
  - Content-based matching regardless of filename/extension.
  - Case-insensitive hex hash comparison.
  - Non-duplicate verification for unique file bytes.
  - Filtering soft-deleted evidence records (`deletedAt != null`).
  - Skipping legacy evidence with null hashes.
  - Empty 0-byte file hashing (in-memory and on disk) against canonical `e3b0c442...`.
  - Large 3 MB patterned binary file creation, chunk streaming, and verification.
  - Batch duplicate detection, case collision priority over batch, and tracking multiple distinct duplicate pairs.
- Zero tautological assertions (`expect(true).toBe(true)` does not occur).

### 6. Clean Typecheck and Test Suite Runs
- `npm run typecheck`:
  ```
  > detact@1.0.0 typecheck
  > tsc --noEmit
  Exit code: 0, 0 errors
  ```
- `npx vitest run tests/dedup-on-selection.test.ts`:
  ```
  ✓ tests/dedup-on-selection.test.ts (13 tests) 518ms
  Test Files  1 passed (1)
  Tests  13 passed (13)
  Exit code: 0
  ```
- `npm test`:
  ```
  Test Files  83 passed | 1 skipped (84)
  Tests  1721 passed | 58 skipped (1779)
  Duration  23.08s
  Exit code: 0, 0 failures
  ```

---

## 2. Logic Chain

1. **Rule Verification (No Facades or Hardcoded Values)**:
   - In `dedup.ts`, all hashing is executed via `@noble/hashes/sha2.js` and streamed chunks or Uint8Array buffers.
   - No hardcoded hash digests or pre-canned PASS responses exist.
2. **Behavioral Integrity**:
   - The pre-upload duplicate detection pipeline operates on raw file bytes before upload or persistence occurs.
   - The UI in `app/case/[caseId]/upload.tsx` integrates directly with `checkDuplicateBeforeUpload`, displaying a `tone="warn"` chip with the truncated SHA-256 digest, and dynamically recalculating duplicate states if files are removed before upload.
3. **Multimodal Parsing Integrity**:
   - `ingest.ts` implements real decoders and protects all decoding and network pathways against unhandled exceptions.
4. **Test & Static Quality**:
   - Both `npm run typecheck` and `npm test` execute with zero errors, validating structural soundness and non-regression across all 84 test suites.

---

## 3. Caveats

No caveats. All investigated components conform to the project specification and the authoritative original request.

---

## 4. Conclusion

**Verdict: CLEAN**

Milestone 2 (Multimodal Ingestion & Immediate Deduplication Pipeline) implements all requested functionality genuinely, without facades, shortcuts, or hardcoded cheating. All acceptance criteria and forensic checks pass.

---

## 5. Verification Method

Independently reproducible using the following commands in `e:/Project Evid/detact`:

1. Run TypeScript check:
   ```bash
   npm run typecheck
   ```
2. Run M2 Deduplication test suite:
   ```bash
   npx vitest run tests/dedup-on-selection.test.ts
   ```
3. Run full project test suite:
   ```bash
   npm test
   ```
4. Verify lack of hardcoded hashes in deduplication service:
   ```bash
   git grep -i "e3b0c442" src/services/ingestion/dedup.ts
   ```
