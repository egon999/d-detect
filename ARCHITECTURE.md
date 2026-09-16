# Evidence review architecture

This document describes the implemented local platform, not a claim of public production readiness. The application compares explicit user claims with supplied evidence and preserves where its assessments came from. It cannot establish that a screenshot is authentic, identify an unknown speaker reliably, or adjudicate legal guilt.

## Runtime and boundaries

- Expo SDK 55, React Native 0.83 and Expo Router implement Android and web screens in app/.
- src/domain/ contains Zod record contracts, normalization, deterministic rules, comparisons, timeline and graph derivation.
- src/data/ defines Repository and pure mutation batches. The remote adapter is the active account-backed transport when EXPO_PUBLIC_API_BASE_URL is configured.
- src/services/session-provider.tsx owns Firebase authentication, real provider metadata, account identity and profile synchronization.
- functions/local-server.js is a Node 22 HTTP API running on the user's computer. Firebase Auth issues ID tokens; the server verifies them through Firebase Admin with the configured project ID.
- functions/src/local-store.js persists collections in functions/.data/database.json by default. Originals are stored below functions/.data/originals/. This is a serialized, single-process JSON store, not SQLite or a horizontally scalable database.
- functions/src/jobs.js and the local server worker perform extraction and case analysis independently of the screen that requested them.
- functions/src/provider.js owns Groq transport and reads a server-only credential. Users never configure that credential; the server's key is not reachable from the app. Separately, Settings (src/features/settings/ai-key-section.tsx) lets a user store their own Groq or xAI key in the device keystore for the on-device path described below. Gemini is refused on the device in every case (src/services/ai/credentials.ts, GEMINI_IS_SERVER_ONLY).

    Expo app -> Firebase Auth -> Firebase ID token
    Expo app -> authenticated /api -> private local store and originals
    persisted processing job -> local worker -> extractor / Groq
    saved extraction / case report -> repository polling -> source inspection

With the local API configured, the backend requires no Firebase Functions deployment or Firestore billing upgrade. Groq usage still depends on the account's actual quota/plan; running Node locally does not make provider usage unlimited.

## Which of the above a default build actually runs

Everything in the previous section describes functions/ — the local Node API. A default build does not reach it. EXPO_PUBLIC_API_BASE_URL is empty in .env, so src/services/api-client.ts returns null, src/services/repository-provider.tsx never constructs RemoteRepository, and the app selects the Firebase or the device-local adapter instead. Read the rest of this document as a description of the local API, not of the shipped default, unless a paragraph says otherwise.

In that default configuration:

- Original bytes are stored on the device, in the app's private document directory, and that is the source of truth. The PUT /api/.../file endpoint has no caller; see src/services/storage/evidence-storage.ts for the constraint that decided this (Spark plan: no Cloud Functions, and Storage now requires Blaze).
- There is no background worker and no durable job queue. Extraction runs inline in the screen that requested it (src/services/ingestion/), using ML Kit for on-device OCR rather than the server's Tesseract. A process that exits mid-extraction leaves records stranded, which src/data/mutations.ts reconcileInterruptedEvidence resets at the next load of that case.
- The deterministic rule engine (src/domain/rules/) runs entirely on the device and needs no key. The four AI reasoning passes use the user's own key from Settings if one is present; two of them (cross-document reconciliation, timeline coherence) also run with no key at all, on the device, and are recorded under a provenance that says so (src/services/ai/provenance.ts).
- Sealing is unavailable. It needs a server the build has no address for; see src/services/crucible/request-seal.ts.

## Repository modes

RemoteRepository authenticates requests with the current Firebase user, validates returned records, rejects mixed-owner data, and scopes workspaces to the requested case. Watchers poll after approximately three seconds and refresh after successful commits. Concurrent workspace loads for the same owner share an in-flight request.

LocalRepository stores a separate device workspace in AsyncStorage. It is an explicit offline mode, not a silent replica of an account. Switching accounts does not migrate device cases. The stable local identity is retained after sign-out so re-entering device mode does not strand its records.

The retained Firestore adapter and Firebase Functions entry point are alternative infrastructure. They are not the active local API deployment and should not be described as operating cloud services merely because source files exist.

## Case mutations and authorization

The client builds changes; the server validates the entire final batch before committing. A case, initial claim and audit entry can therefore be saved together. Every account-scoped object has ownerId, and case-scoped objects also carry caseId. Server checks use the verified token UID, never a trusted request-body owner.

The local API rejects ownership changes, cross-case links and writes to server-managed extraction, file identity, job/report collections or analysis timestamps. New claims start unresolved/unsupported by the deterministic state model; user input cannot write an AI assessment as a server result. User-created relationships remain distinguishable from model conclusions.

## Ingestion and processing

The numbered sequence below is the local API's pipeline. For what a default build does instead, see "Which of the above a default build actually runs".

1. Save metadata and an evidence identity through a validated commit.
2. Upload original bytes through the authenticated evidence file endpoint.
3. Stream to a temporary file, enforce the byte limit, compute SHA-256 and publish the private original with its metadata. An existing original accepts only an identical-content retry; changed bytes require a new evidence item.
4. Queue a durable EVIDENCE job after original storage succeeds. Typed notes do not need a file.
5. The worker reads the owned original, checks its storage location and extracts text.
6. Store sourceText and source segments with exact UTF-16 offsets, page numbers or transcription timing when available. Store extraction limitations and failure messages.
7. Queue a CASE job to compare explicit claims with processed evidence.
8. Validate the returned report, persist it with model/prompt/schema version and coverage, and expose the saved result to the UI.

DOCX parsing runs in a separate Node process with a 30-second deadline. PDF text/rendering uses a separate process with a 45-second deadline; image OCR uses a 30-second process per image. Each has a 256 MB V8 old-space cap, bounded output, and no inherited provider credentials. The PDF renderer targets 4 megapixels, caps each canvas at 8 megapixels and total rendered binary images at 24 MB. These controls limit failures but are not an operating-system sandbox or a cap on all native/WASM memory.

The worker checks its queue every 500 ms and processes one job at a time. Duplicate active requests reuse a job lock. A processing lease expires after ten minutes; terminal failed jobs remain inspectable and a user can request a new attempt. Processing requests are limited to 30 per account per hour. Case analysis fingerprints its input and refuses to publish a result if that input changed while the model was running.

## Extraction capabilities

| Source | Implemented processing | Important limit |
| --- | --- | --- |
| Typed notes | Text segments | A user's statement is not independent corroboration |
| PNG, JPEG, WebP | Local Tesseract.js English/Hindi OCR | 30 MB and 24 megapixels; OCR is a machine reading, not verified text |
| PDF | Native text with page anchors; sparse/scanned pages rendered and read with local OCR | First 80 pages; up to 10 sparse pages receive OCR; text-rich pages' embedded images are not visually analyzed |
| DOCX | Text with mammoth | Layout and embedded images are not analyzed |
| UTF-8 text, CSV, TSV, Markdown, JSON, XML, EML, logs | Text extraction | No spreadsheet formula execution or attachment traversal |
| MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, WebM, FLAC | Groq speech transcription and available segment timing | 25 MB; first audio track only |
| Video | Speech from supported recording container | No video-frame event analysis or verified speaker identity |
| Other accepted originals | Private storage | Unsupported extraction yields a real failure with guidance |

Storage limits: 100 MB per original, 2 GB of original files per account, 500 cases per account and 500 evidence records per case. Text limit: 40,000 extracted characters per source; PDF extraction is limited to the first 80 pages. Case model input: at most 60 selected sources, 180,000 characters and 100 claims. Excluded sources and truncated content are reflected in report coverage. These limits bound actual work; they are not claims that the entire original was analyzed.

## Report and provenance

CaseAnalysis persists claim assessments, agreements, contradictions, timeline observations, missing information, limitations and coverage. Claim assessment states are SUPPORTED, PARTIALLY_SUPPORTED, CONTRADICTED, DISPUTED, INSUFFICIENT_EVIDENCE and UNRESOLVED.

Each citation names evidenceId and segmentId and contains an exact quote and absolute start/end offsets. The model supplies a quote and source reference; the backend computes offsets when that quote occurs exactly once in the named segment. Ambiguous matches require already valid exact offsets and are never resolved by guessing. Validation rejects foreign/missing segments, wrong quotes, missing/duplicate claims and stance-inconsistent claim statuses. Supported conclusions require a supporting citation; contradicted conclusions require a contradicting citation; disputed conclusions require both. Agreements based solely on repeated bytes or passages from one original are removed.

Exact-quote validation establishes where quoted text came from. It does not prove that the model interpreted that quote correctly. Summary and explanatory prose still require human review. Source authenticity and legal meaning remain outside this validator's guarantees.

Deterministic AnalysisResult records and saved CaseAnalysis reports are different objects. They must remain visually attributable to their generating process. A generic absence-of-support rule is not proof that a claim is false.

## Graph, timeline and search

Graph rendering derives relationships from actual records, claims, participants, and saved source-cited assessments:
- The dispute topology maps all active entities: Claims, Sources, Conflicts, and Counterparties/Participants.
- Filter chips and type toggles ('All', 'Claims', 'Sources', 'Conflicts', 'Links') let the user focus on specific dispute dimensions.
- The interactive Node & Edge Inspector surfaces verbatim citation quotes, relationship justifications, and provides direct navigation to evidence records.
- When remote worker execution is not configured or in local mode, the direct client-side dispute analysis engine (`runDirectCaseAnalysis`) performs automatic text segmentation, rule-based conflict detection (such as payment status contradictions, harassment indicators, and amount mismatches), and produces a validated `CaseAnalysis` report conforming to `caseAnalysisSchema`.

Search indexes the signed-in owner's persistent cases, claims, evidence text and extracted entities, and manual timeline events. It filters deleted/foreign records and pages displayed results. The remote adapter fetches the whole owner workspace once; other adapters use at most four case reads at a time. Recent queries are account-scoped device preferences and can be disabled or cleared. This is client-side full-workspace search, not a scalable server search index.

Home summaries use saved claim assessments with citation/staleness checks rather than interpreting an empty rule-result list as a resolved case. Activity displays persisted job states and audit entries; it does not invent alerts or unread status.

## Previous cases and report export

Profile links to Previous cloud cases for an authenticated remote account. This reads only that user's retained Firestore cases, claims, events and evidence. A reviewed missing case may be copied through a single commit with expectedAbsentCaseId. The server checks the case and every record for absence inside the transaction, so recovery cannot overwrite current records. Original IDs are preserved; old AI reports, links, jobs and verification states are not promoted into the current workspace. Historical source text becomes a clearly labelled unverified note, capped at 4,000 characters; originals require re-upload. The old cloud records are unchanged and remain readable, including cases too large for the 400-write atomic import limit.

The export screen builds escaped HTML from the current case and latest saved assessment, with quoted citations, limitations, source index and available file hashes. Web uses the print dialog; native uses PDF creation and the system share/print flow. Original evidence files remain separate. Export is a readable assessment snapshot, not a verified or notarized evidence package.

## Deployment boundary and future extension

The default API binds to 127.0.0.1:8787. The current Android configuration reaches that PC backend using adb reverse tcp:8787 tcp:8787 over USB. Without the reverse tunnel, localhost on a phone means the phone itself. The PC must remain on, connected and running the backend; the release is not a standalone cloud service. Its network security configuration permits cleartext only to exact localhost/127.0.0.1 and denies other HTTP destinations. Public deployment requires HTTPS, supervision, backup/restore, operational resource monitoring and stronger parser sandboxing, plus a durable database/object-store strategy for expected load. See SECURITY.md and ROADMAP.md.

Extraction, provider transport, report validation and persistence are separate modules so new parsers, retrieval or specialist analyzers can be added without changing end-user credential settings. A future adapter must preserve source anchors and observed/inferred distinctions.
