# Handoff Report: Survey of Existing Data Layer, Persistence Architecture, Services, and Domain Logic

**Agent**: Explorer Survey 1  
**Working Directory**: `e:/Project Evid/detact/.agents/explorer_survey_1`  
**Date**: 2026-09-17  
**Mission**: Comprehensive architectural survey of the data access layers, persistence engines, file storage, deterministic domain logic, hashing, ingestion, OCR/transcription, entity normalization, deduplication, and gap analysis against R1 and R2 of `ORIGINAL_REQUEST.md`.

---

## 1. Observation

### 1.1 Project Structure & Dependencies
- **Project Root**: `e:/Project Evid/detact`
- **Expo & React Native Stack** (`package.json:18-74`):
  - React Native `0.83.10`, React `19.2.0`, Expo SDK `~55.0.31`, Expo Router `~55.0.18`.
  - Firebase: `firebase: ^12.19.0`, `@firebase/rules-unit-testing: ^5.0.2`, `firebase-tools: ^15.30.0`.
  - Local storage: `@react-native-async-storage/async-storage: 2.2.0`, `expo-secure-store: ~55.0.18`, `expo-file-system: ~55.0.26`.
  - Cryptography: `@noble/hashes: ^2.4.0` (SHA-256), `@noble/curves: ^2.4.0` (Ed25519), `expo-crypto: ~55.0.19`.
  - Media & Vision: `@react-native-ml-kit/text-recognition: ^2.0.0`, `expo-audio: ~55.0.18`, `expo-image-picker: ~55.0.24`, `expo-document-picker: ~55.0.17`, `expo-video-thumbnails: ~55.0.19`.
  - Validation: `zod: ^4.6.2`, `pako: ^3.0.1` (decompression for PDF and Office XML).
  - Absence of SQLite / MMKV: Grep for `sqlite` and `mmkv` across the codebase confirmed no SQLite dependencies (`expo-sqlite`, `react-native-quick-sqlite`) or MMKV dependencies (`react-native-mmkv`) are installed or referenced. Persistence is purely AsyncStorage (device-local) and Firestore (cloud/cache).
  - Absence of NetInfo: Grep for `NetInfo` returned no references. `@react-native-community/netinfo` is not installed.

### 1.2 Data Access Layer & Persistence Architecture
- **Repository Interface** (`src/data/repository.ts:1-205`):
  - Defines the storage port `Repository` with `readonly kind: 'local' | 'firebase' | 'remote'`.
  - Methods: `loadProfile`, `saveProfile`, `listCases`, `loadWorkspace`, `loadAllWorkspace?`, `commit(ownerId, changes)`, `clear(ownerId)`, `dropLocalCache?()`, `watchWorkspace`, `watchCases`.
  - Atomic change model: `Change = PutChange | DeleteChange` with `MAX_ATOMIC_CHANGES = 400` (`repository.ts:112`). Writes are full-record puts or deletes (`put`, `remove`).
  - Change application: Pure in-memory reducer `applyChanges(workspace, changes)` (`repository.ts:267-290`) shared across UI and persistence.
- **Local Repository** (`src/data/local/local-repository.ts:1-380`):
  - Backed by `AsyncStorage` via `KeyValueStore` adapter (`src/data/local/async-storage-store.ts`).
  - Sharding: Stores records under key prefix `detact:v1:${userId}:`. Case metadata is stored in `detact:v1:${userId}:cases`, and per-case records are sharded under `detact:v1:${userId}:case:${caseId}` (`local-repository.ts:37-42`).
  - In-process event emitter handles `watchWorkspace` and `watchCases` (`local-repository.ts:248-268`).
- **Firebase Repository** (`src/data/firebase/firebase-repository.ts:1-849`):
  - Direct Firestore integration with client persistence:
    ```typescript
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
    ```
  - Schema layout: Flat top-level collections (`cases`, `claims`, `events`, `evidence`, `relationships`, `analysisResults`, `auditLogs`, `processingJobs`, `aiSuggestions`, `caseAnalyses`, `seals`).
  - Authorization check: All queries filter on `where('ownerId', '==', ownerId)` matching Security Rules.
  - Commits: Batched writes using Firestore `writeBatch` bounded by `MAX_BATCH_WRITES = 400`.
  - Bounded commit acknowledgement: `acknowledgedWithin` waits up to `COMMIT_ACK_TIMEOUT_MS = 10_000` (10 seconds). If offline or network hangs, it resolves with `durability: 'LOCAL_PENDING'` (`firebase-repository.ts:98-110, 786-809`), absorbing late rejections without throwing unhandled exceptions.
  - Real-time reactivity: Uses `onSnapshot` listeners per collection, assembling into a unified `Workspace` (`firebase-repository.ts:488-597`).
  - Boundary validation: Every document read is parsed through its Zod schema (`RECORD_SCHEMAS[name]`). Malformed records from previous versions are skipped rather than crashing the workspace (`firebase-repository.ts:763-784`).
- **Remote Repository** (`src/data/remote/remote-repository.ts:1-173`):
  - Talks via HTTP JSON to `functions/local-server.js` when `EXPO_PUBLIC_API_BASE_URL` is configured.
- **Repository Provider & Selection** (`src/services/repository-provider.tsx:1-205`):
  - Dynamically selects repository:
    - If `!cloudEnabled` (user in local/guest mode), instantiates `LocalRepository` with `AsyncStorage`.
    - If `cloudEnabled` and `apiBaseUrl()`, instantiates `RemoteRepository`.
    - If `cloudEnabled` and `isFirebaseConfigured()`, initializes `FirebaseRepository` (with 4-second timeout fallback to `LocalRepository`).
- **Case State Management** (`src/services/use-case-store.ts:1-352`):
  - React hooks: `useCaseList(ownerId)`, `useWorkspace(ownerId, caseId)`, `useMutator(ownerId, caseId, workspace, onApplied)`.
  - Optimistic UI updates: `useMutator` synchronously advances `workspaceRef.current = mutation.workspace` before calling `repository.commit(ownerId, mutation.changes)`.
  - Process restart reconciliation: First load of a case invokes `reconcileInterruptedEvidence(workspace, mutationContext)` to reset stranded `UPLOADING` or `PROCESSING` jobs (`use-case-store.ts:199-215`).

### 1.3 Storage & File Persistence Architecture
- **Evidence Storage** (`src/services/storage/evidence-storage.ts:1-518`):
  - Canonical storage path: `users/{ownerId}/cases/{caseId}/{evidenceId}/original.{ext}` (`evidenceStoragePath`, line 137).
  - Storage location: On native, files are saved locally via `expo-file-system` to `fs.Paths.document/evidence/...`. On web, stored in browser IndexedDB via `web-blob-store.ts`.
  - File size limit: `MAX_EVIDENCE_UPLOAD_BYTES = 100 * 1024 * 1024` (100 MB).
  - Streamed copy and digest: `copyWithDigest` (`src/services/storage/stream-copy.ts`) copies 1 MB chunks while computing SHA-256 incrementally, avoiding large memory allocations.
  - Path security: `validatePrivateEvidencePath` verifies that paths strictly match `users/${ownerId}/cases/...` with validated UUIDs (`evidence-storage.ts:161-180`).
- **Cloudinary Integration** (`src/services/storage/cloudinary.ts:1-284`):
  - Implements unsigned XHR upload to Cloudinary with upload progress tracking (`uploadToCloudinary`, `mirrorToCloud`).
  - Configuration via `EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME` and `EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET`.
  - **Critical Finding**: Grep for `mirrorToCloud` and `uploadToCloudinary` revealed **zero callers** across `src/`! Cloudinary backup exists as a standalone module but is never invoked during evidence upload.
- **Firebase Storage Integration**:
  - `firebase/storage` is not imported or used anywhere in `src/`. Neither `.env` nor client code provides Firebase Cloud Storage file uploads.

### 1.4 Domain Models & Schemas
- **Enums** (`src/domain/enums.ts:1-371`):
  - `CaseStatusEnum`: `OPEN`, `IN_REVIEW`, `CLOSED`, `ARCHIVED`.
  - `EvidenceKindEnum`: `PDF`, `IMAGE`, `TEXT`, `EMAIL`, `NOTE`, `SPREADSHEET`, `AUDIO`, `VIDEO`, `DOCUMENT`, `OTHER`.
  - `ProcessingStateEnum`: `UPLOADING`, `QUEUED`, `PROCESSING`, `EXTRACTED`, `ANALYZED`, `REVIEW_REQUIRED`, `FAILED`, `CONFIRMED`.
  - `RelationshipTypeEnum`: `SUPPORTS`, `CONTRADICTS`, `RELATED_TO`, `DERIVED_FROM`, `DUPLICATE_OF`, `ATTACHED_TO_EVENT`, `RELEVANT_TO_CLAIM`, `CORROBORATES`, `INVOLVES`, `MENTIONS`.
  - `AnalysisTypeEnum`: 14 types including `POSSIBLE_CONFLICT`, `AMOUNT_MISMATCH`, `PAYMENT_STATUS_CONFLICT`, `HARASSMENT_INDICATOR`, `STATEMENT_DISCREPANCY`, `DUPLICATE_EVIDENCE`, `UNLINKED_EVIDENCE`, `RESPONSE_OVERDUE`.
  - `ClaimStateEnum`: `SUPPORTED`, `CONTRADICTED`, `UNSUPPORTED`, `MIXED_REVIEW`.
  - `ExtractionMethodEnum`: `MANUAL`, `DETERMINISTIC`, `OCR`, `AI` (precedence order: MANUAL > DETERMINISTIC > OCR > AI).
- **Models** (`src/domain/models.ts:1-605`):
  - `Evidence`: `id`, `ownerId`, `caseId`, `title`, `kind`, `state`, `note`, `fileName`, `mimeType`, `sizeBytes`, `storagePath`, `sha256`, `extraction`, `confirmedFields`, `confirmedAt`, `failureReason`.
  - `Extraction`: `documentType`, `title`, `summary`, `dates: DateField[]`, `amounts: AmountField[]`, `parties`, `people`, `organizations`, `emails`, `phones`, `invoiceNumbers`, `orderNumbers`, `transactionIds`, `addresses`, `keywords`, `chatMessages`, `transactionStatus`, `sourceText` (max 40k chars), `segments: { id, text, startOffset, endOffset, page?, startMs?, endMs?, method }[]`.
  - `Claim`: `statement`, `detail`, `requiredEventIds`, `state`.
  - `CaseAnalysis`: Model/system assessment report with `claims: ClaimAssessment[]`, `agreements`, `contradictions`, `timeline`, `coverage`, `citations: CaseCitation[]`.
  - `CaseCitation`: `evidenceId`, `segmentId`, `quote`, `startOffset`, `endOffset`, `stance: 'SUPPORTS' | 'CONTRADICTS' | 'CONTEXT'`.

### 1.5 Ingestion, OCR, Transcription, Normalization & Deduplication
- **Hashing** (`src/domain/hashing.ts:1-49`):
  - `hashBytes(bytes)` / `hashText(text)` using pure JS `@noble/hashes/sha2.js`.
  - Streaming file hash via `digestStream` in `src/services/storage/stream-copy.ts`.
- **Intake Pipeline** (`src/services/ingestion/ingest.ts:1-1790`):
  - Unified entry point: `ingestFile(file: PickedFile): Promise<IngestResult>`.
  - Routes by file extension and MIME type.
  - Native text extraction for PDF (`pdf-text.ts`), Office XML (`office-docs.ts` via `pako`), CSV/TSV (`parseCsv`), EML (`parseEml`), RTF (`stripRtf`), plain text (`decodeUtf8`).
  - On-device OCR (`src/services/ingestion/ocr.ts`):
    - Uses `@react-native-ml-kit/text-recognition`.
    - Runs dual-pass Latin and Devanagari models simultaneously (`TextRecognitionScript.LATIN` and `TextRecognitionScript.DEVANAGARI`).
    - Compares content length, offering script switches when Devanagari detects more characters.
    - Scanned PDF fallback (`src/services/ingestion/pdf-images.ts`): Extracts JPEG image streams directly from PDF dictionaries and runs ML Kit OCR on each page.
  - Audio/Video Transcription (`src/services/ingestion/transcribe.ts`):
    - Communicates with Groq Whisper API (`whisper-large-v3-turbo` / `whisper-large-v3`).
    - Produces `TimedSegment[]` with `startMs` and `endMs`.
    - Video frames (`src/services/ingestion/video-frames.ts`): Extracts video frame thumbnails via `expo-video-thumbnails` and runs ML Kit OCR on frames.
- **Deterministic Entity Normalization**:
  - Dates (`src/domain/normalize/dates.ts`): Parses DMY, MDY, ISO 8601, alphanumeric month strings, flags ambiguous numeric dates (e.g. 03/04/2024), tags precision (`DAY`, `MONTH`, `YEAR`, `UNKNOWN`).
  - Monetary values (`src/domain/normalize/money.ts`): Converts amounts to integer minor units (paise/cents) per ISO 4217, parses Indian numbering system (`1,00,000`), accounts for currency symbols (`₹`, `$`, `€`, `£`, etc.).
  - Text & Counterparties (`src/domain/normalize/text.ts`): `normalizeName` strips legal entity suffixes (`pvt`, `ltd`, `inc`, `llc`); `normalizeIdentifier` strips delimiters (`INV-2024/018` -> `INV2024018`); `foldDigits` normalizes Indic script digits (Devanagari, Bengali, Tamil, etc.) to standard ASCII digits `0-9`.
- **Deduplication**:
  - Exact duplicates are identified strictly by matching SHA-256 lowercase hex hashes (`src/domain/hashing.ts:7-11`).
  - `upload-queue.ts:149-163` implements `findDuplicate(sha256, existing, batch)`.
  - In `app/case/[caseId]/upload.tsx:230-239`, duplicate matching is invoked only after `uploadEvidenceFile` writes to local storage. It is **not** currently performed upon initial file selection.

### 1.6 Deterministic Offline Rule Engine
- **Engine & Registry** (`src/domain/rules/engine.ts`, `registry.ts`):
  - 16 registered deterministic rules executed in `runAnalysis(workspace, caseId, now)`:
    1. `paymentStatusConflictRule`
    2. `statementDiscrepancyRule`
    3. `harassmentIndicatorRule`
    4. `eventDateConflictRule`
    5. `impossibleSequenceRule`
    6. `amountMismatchRule`
    7. `missingEvidenceRule`
    8. `unsupportedClaimRule`
    9. `duplicateEvidenceRule`
    10. `responseOverdueRule`
    11. `orphanedEvidenceRule`
    12. `timelineGapRule`
    13. `relatedIdentifiersRule`
    14. `corroboratedClaimRule`
    15. `consistentAmountRule`
    16. `corroboratedEventRule`
  - Completely offline, pure TypeScript execution with zero network requirements.
  - Provenance quarantine (`src/domain/rules/provenance.ts`): Any conflict finding based on unconfirmed OCR text is marked `provisional: true` and generates `unconfirmedReads` targets for human verification.
  - Claim state evaluation: Evaluates claim states (`SUPPORTED`, `CONTRADICTED`, `UNSUPPORTED`, `MIXED_REVIEW`) via `evaluateCaseClaims`.

### 1.7 Verification Commands Executed
1. `npm run typecheck` (`tsc --noEmit`):
   - **Result**: Passed with exit code 0 and zero errors.
2. `npm test` (`vitest run`):
   - **Result**: 73 test files passed, 1 skipped (emulator tests), 1 failed (`tests/scratch-probe.test.ts`).
   - Total tests: 1,474 passed, 58 skipped, 1 failed.
   - The single failure is `tests/scratch-probe.test.ts` (a 9-line test importing an expo-router screen without JSX transform). All 1,474 domain, rule, parser, OCR, hashing, and storage unit tests passed.

---

## 2. Logic Chain

1. **R1 Analysis (Persistence & Cloud-Native Storage)**:
   - *Requirement*: Authenticated cases, metadata, and files must persist to Firebase Firestore and Cloud Storage (or Cloudinary), while maintaining instant local offline caching, optimistic UI updates, and deterministic offline rule evaluation. Zero unhandled exceptions on network drops.
   - *Current State*:
     - Metadata persistence: Firestore is implemented (`FirebaseRepository`) with offline disk cache (`persistentLocalCache`) and optimistic commits (`useMutator`).
     - File storage: Files are stored **only locally on the device** via `expo-file-system` / IndexedDB (`evidence-storage.ts`).
     - Cloudinary integration exists in `cloudinary.ts` but has **no callers** in the intake flow.
     - Cloud Storage (`firebase/storage`) is completely omitted from the client app.
     - Offline rule evaluation is fully implemented and passes all tests.
     - Network state handling lacks active network connectivity monitoring (`@react-native-community/netinfo` is missing).
   - *Gap*: Authenticated evidence files are never backed up to Cloud Storage or Cloudinary; they remain stranded on the local device.

2. **R2 Analysis (Evidence Ingestion, Extraction & Verification)**:
   - *Requirement*: Provide a unified evidence intake workflow supporting images, PDFs, office documents, audio recordings, and structured notes. Compute SHA-256 content hashes, perform on-device and cloud OCR/transcription, normalize dates, monetary values, and counterparties, and detect duplicates upon selection.
   - *Current State*:
     - Multimodal intake: Fully supported for images, PDFs, office docs (DOCX/XLSX/PPTX), audio, video, and notes.
     - Hashing: SHA-256 is computed using `@noble/hashes` during ingestion and storage.
     - On-device OCR: ML Kit Latin + Devanagari and scanned PDF extraction are fully implemented.
     - Transcription: Groq Whisper transcription is implemented for audio/video.
     - Normalization: Dates, amounts, names, counterparties, and phone/email identifiers are normalized with high precision and test coverage.
     - Deduplication: Implemented via SHA-256 matching, but **only executes after the file is saved and written to disk**, not "upon selection" in the picker interface.
   - *Gap*: Immediate pre-upload duplicate detection upon selection is not yet wired in the UI.

3. **R3-R5 Contextual Gaps**:
   - R3 requires personal Gemini session proxy support. Currently, Gemini is hardcoded as refused on device (`GEMINI_IS_SERVER_ONLY = true` in `credentials.ts`), and the app only supports Groq/xAI with user-provided API keys in Settings.
   - R4 requires a 3-view Case Workspace (`[Evidence]`, `[Intelligence]`, `[Proof & Dossier]`). The current UI is fragmented across 12+ separate sub-routes.
   - R5 requires 5 specific intelligence capabilities (Opposing Narrative Simulator, Event Nexus, Truth Decay, Proof Capsule, Strategic Next-Move Playbook). Foundations exist in `evidence-intelligence.ts`, `escalation.ts`, and `seal.ts`, but need expansion and dedicated UI integration.

---

## 3. Caveats

1. **Emulator Tests**: `tests/firestore-rules.test.ts` (58 tests) was skipped during `npm test` because the local Firebase Emulator Suite was not running.
2. **Device-Specific Native Modules**: `@react-native-ml-kit/text-recognition` and `expo-file-system` are mocked under Vitest; real native execution requires an Android runtime or standalone APK build.
3. **External Provider Keys**: Tests mock Groq and Cloudinary APIs; live cloud calls depend on valid user configuration in `.env` or keystore.

---

## 4. Conclusion & Recommendations

### 4.1 Summary of Existing Capabilities
| Domain Component | Implemented | File Reference | Status / Quality |
|---|---|---|---|
| Repository Interface & Commit Port | Yes | `src/data/repository.ts` | Complete, clean contract |
| Firestore Repository & Disk Cache | Yes | `src/data/firebase/firebase-repository.ts` | High; handles `LOCAL_PENDING` timeout |
| Local AsyncStorage Repository | Yes | `src/data/local/local-repository.ts` | High; sharded per case |
| Reactive State & Optimistic Mutator | Yes | `src/services/use-case-store.ts` | High; handles optimistic apply & reconciliation |
| Local Evidence Storage & Verification | Yes | `src/services/storage/evidence-storage.ts` | High; 100 MB cap, SHA-256 verification |
| Cloudinary Storage Mirror | Partial | `src/services/storage/cloudinary.ts` | Implemented but NOT wired to upload pipeline |
| Cloud Storage (`firebase/storage`) | No | N/A | Missing in client |
| Network State Monitor | No | N/A | Missing NetInfo handler |
| Multimodal File Ingestion | Yes | `src/services/ingestion/ingest.ts` | High; PDF, DOCX, XLSX, audio, video, notes |
| On-Device OCR (ML Kit) | Yes | `src/services/ingestion/ocr.ts` | High; Latin + Devanagari dual-pass |
| Audio/Video Transcription (Whisper) | Yes | `src/services/ingestion/transcribe.ts` | High; Groq Whisper with TimedSegments |
| SHA-256 Hashing | Yes | `src/domain/hashing.ts` | High; `@noble/hashes` |
| Entity Normalization | Yes | `src/domain/normalize/*` | High; dates, money, text, Indic digits |
| Deduplication upon Selection | Partial | `upload-queue.ts`, `upload.tsx` | Deduplication logic exists but runs after upload |
| Deterministic Rule Engine | Yes | `src/domain/rules/engine.ts` | High; 16 offline rules, zero dependencies |
| Ed25519 Cryptographic Seal | Yes | `src/domain/crucible/seal.ts` | High; `@noble/curves` audit chain sealing |

### 4.2 Concrete Action Items for Implementers

1. **For R1 (Cloud-Native Storage & Offline Resilience)**:
   - Wire `uploadToCloudinary` or Firebase Storage directly into `uploadEvidenceFile` in `evidence-storage.ts` when authenticated with cloud enabled. When authenticated, upload to cloud in the background or inline while keeping the local file as instant cache.
   - Install or configure network state monitoring (`@react-native-community/netinfo`) to detect online/offline transitions, show offline banner, and trigger synchronization of any pending uploads.
2. **For R2 (Evidence Intake & Duplicate Detection upon Selection)**:
   - In `app/case/[caseId]/upload.tsx` (and the new 3-view Evidence View), compute file SHA-256 hashes immediately upon selection (via `readPrefix`/`sha256File`) before the user clicks "Save".
   - Run `findDuplicate` against `workspace.evidence` immediately upon selection and render inline warning chips ("Duplicate of: [Title]") on the selected item cards.
3. **Test Suite Maintenance**:
   - Clean up `tests/scratch-probe.test.ts` so `npm test` achieves 100% passing tests (0 failures).

---

## 5. Verification Method

### 5.1 Verification Commands
1. **Typecheck**:
   ```bash
   npm run typecheck
   ```
   *Expected*: Passes with exit code 0.
2. **Unit & Integration Test Suite**:
   ```bash
   npm test
   ```
   *Expected*: Passes all 1,474 domain and service tests.
3. **Data Layer Verification Tests**:
   ```bash
   npx vitest run tests/data-layer.test.ts tests/evidence-storage.test.ts tests/ingestion.test.ts tests/rule-engine.test.ts
   ```

### 5.2 Key Files to Inspect
- Repository & persistence: `src/data/repository.ts`, `src/data/firebase/firebase-repository.ts`, `src/data/local/local-repository.ts`
- Storage & Cloudinary: `src/services/storage/evidence-storage.ts`, `src/services/storage/cloudinary.ts`
- Ingestion & OCR: `src/services/ingestion/ingest.ts`, `src/services/ingestion/ocr.ts`, `src/services/ingestion/transcribe.ts`
- Normalization & Hashing: `src/domain/normalize/dates.ts`, `src/domain/normalize/money.ts`, `src/domain/hashing.ts`
- Rules & Provenance: `src/domain/rules/engine.ts`, `src/domain/rules/registry.ts`, `src/domain/rules/provenance.ts`
