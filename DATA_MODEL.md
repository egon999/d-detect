# Data model and API contracts

Client contracts are in src/domain/models.ts and src/domain/enums.ts. The local API validates allowed mutations in functions/src/local-api-validation.js; model reports and citations are validated in functions/src/contracts.js. Update these boundaries together.

## Persisted collections

| Collection | Purpose and relationships |
| --- | --- |
| users | Account profile mirror keyed by authenticated UID: name, email, photo, timestamps |
| cases | Owner, title, description, custom category, priority, participants, incident date, lifecycle, latest analysis timestamp |
| claims | Explicit statement/detail belonging to a case, required manual events, deterministic cached state |
| events | Manual case event, optional normalized date, related claims |
| evidence | Case/owner/source metadata, kind, filename/MIME/size, private storage path, SHA-256, processing state, source extraction, user corrections |
| relationships | Typed same-case references; user assertions retain origin |
| analysisResults | Deterministic rule findings and provenance, distinct from model reports |
| caseAnalyses | Immutable-by-client saved model report: claims, citations, entities, agreements, contradictions, timeline, coverage, limitations, model/prompt/schema versions |
| processingJobs | EVIDENCE/CASE job, state, attempts, timestamps, error, fingerprint and result path |
| auditLogs | Append-only-by-client activity entries; not external notarization |
| aiSuggestions | Retained suggestion records; do not substitute for a saved CaseAnalysis |
| processingLocks / processingQuotas | Server job coordination and hourly account limits |
| files | Server private-original metadata indexed by storage path |

Epoch timestamps are milliseconds. IDs support Firebase UID-compatible letters, digits, underscore and hyphen. Source offsets are UTF-16 character indices with an exclusive end, matching JavaScript string slicing. Page numbers and audio times are optional source anchors; unknown values must remain unknown.

A participant is descriptive case metadata, not an authenticated collaborator. There is no invitation or shared-case ACL model in the current server.

## Extraction and assessment

Extraction contains sourceText, truncation flag, source segments and a version. Segments contain id, text, startOffset, endOffset, extraction method and optional page/startMs/endMs. Shared deterministic parsing populates recognized names, dates, amounts, identifiers and chat fields from extracted text; an empty list does not establish their absence from the original. PDF native text and OCR remain distinct segments with the same original/page provenance. OCR failures and excluded pages contribute explicit limitations and partial coverage.

A model claim assessment is one of SUPPORTED, PARTIALLY_SUPPORTED, CONTRADICTED, DISPUTED, INSUFFICIENT_EVIDENCE, UNRESOLVED. It includes explanatory text, missing information, limitations and citations. A citation includes evidenceId, segmentId, quote, startOffset, endOffset and SUPPORTS/CONTRADICTS/CONTEXT stance.

For a uniquely occurring exact quote, the backend computes UTF-16 offsets from the named segment. All final citations must slice back to exactly that quote. Validation proves source location and that each requested claim was assessed exactly once; it does not verify semantic entailment. Entities also require their name to appear in a cited quote. The legacy deterministic Claim.state and the CaseAnalysis assessment status are separate contracts.

## Local HTTP API

All /api routes require Authorization: Bearer <Firebase ID token>. Responses containing data disable caching. JSON metadata requests are limited to 2 MB.

| Method and route | Request / response |
| --- | --- |
| GET /health | Public process-health result; does not test AI credentials |
| GET /api/workspace | Owned collections, validated and scoped further by the client |
| GET /api/profile | Authenticated user's profile or null |
| PUT /api/profile | Validated own profile; server preserves creation time and updates timestamps |
| POST /api/commit | {changes:[{collection,op,record or id}],expectedAbsentCaseId?} ; at most 400 validated changes, atomic final-batch checks. Recovery precondition allows only absent records for one new case |
| PUT /api/cases/{caseId}/evidence/{evidenceId}/file | Original bytes and Content-Type; private path/hash/size/state response |
| GET /api/cases/{caseId}/evidence/{evidenceId}/file | Owned original download |
| POST /api/cases/{caseId}/evidence/{evidenceId}/process | Persist an extraction job; returns jobId/state |
| POST /api/cases/{caseId}/analysis | Persist case analysis job; returns jobId/state |

Errors use an HTTP status and a safe {code,error} JSON body. Common classes: invalid argument 400, unauthenticated 401, forbidden 403, absent 404, conflict/precondition 409, too large 413, processing quota 429, internal 500. Provider/parser failures are stored on the job so leaving a screen does not discard them.

## Lifecycles and integrity

Files are reserved as metadata before upload. Published originals cannot be silently replaced with different bytes. Jobs move from QUEUED to PROCESSING to EXTRACTED/ANALYZED or FAILED. The server retains terminal jobs and source limitations. Retries create/reuse jobs rather than fabricating completion.

Soft deletion removes records from normal case/search views but does not erase their disk bytes. Metadata and originals must be backed up/restored as a set. There is no versioned schema migration framework yet; new fields should have compatible defaults and migrations must be tested on copies before changing existing data.

Previous-cloud recovery is a bounded account-authorized copy, not a general schema migration. It preserves case/claim/event/evidence IDs, resets old verification state, converts old evidence text into labelled NOTE records and records the recovery in the audit log. No historical file storage path or hash becomes a current original. Existing cloud data remains unchanged; collisions or oversized imports fail without a partial write.
