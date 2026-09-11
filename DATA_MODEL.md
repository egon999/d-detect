# Data model

All canonical documents have stable `id`, `ownerId`, `createdAt`, `updatedAt`; case children also carry `caseId`. Domain times are integer UTC epoch milliseconds; Firestore codecs convert createdAt/updatedAt to Timestamp explicitly. Event dates use validated ISO calendar values with DAY/MONTH/UNKNOWN precision, original source strings and optional time; no guessed timezone or ambiguous regional date conversion.

Root collections:
- users: private user profile.
- cases: title, description, OPEN/REVIEW/CLOSED status.
- claims: statement and required event IDs. Derived state is SUPPORTED, CONTRADICTED, UNSUPPORTED or MIXED_REVIEW, never true/false.
- events: title, description, normalized date and claim IDs.
- evidence: title, type, immutable source path, size, MIME type, SHA-256, processing state, extraction, confirmed extraction, deletedAt tombstone.
- relationships: typed evidence/claim/event endpoints, explicit type, user/rule origin and material contradiction flag. Endpoints must exist in the same case.
- analysisResults: resultType, severity, explanation, supportingEvidenceIds, relatedClaimIds, relatedEventIds, triggeredRuleIds, input snapshot, status and confidence label.
- conflicts: projections of conflict/amount findings, referencing their analysis result.
- auditLogs: append-only action, entity IDs, safe summary, timestamp; no raw evidence text.
- processingJobs: evidence ID, source fingerprint, attempts, state, lease and safe error.
- rules: typed engine registry definitions; server controlled.
- aiSuggestions: validated structured candidates, model/prompt version, source IDs, SUGGESTED/ACCEPTED/REJECTED and confidence.
- userPreferences: optional owner settings (future).

## Extraction
Fields retain original text, normalized value, evidence ID and method (DETERMINISTIC/MANUAL/AI). Model covers dates, integer minor-unit amounts/currency, people, organizations, emails, phones, invoice/order/transaction identifiers, addresses, keywords and bounded sourceText. Confirmed extraction is a separate snapshot that reprocessing never overwrites.

## Queries and limits
Cases by ownerId; case children by ownerId+caseId. Client subscriptions are cleaned up when session changes. MVP caps case entity counts and file sizes to bound processing; do not load unbounded large investigations. Composite indexes are shipped. Graph is not persisted separately. Analysis IDs are deterministic from rule and source inputs; review changes are retained independently of a re-run.

## Deletion
Source removal is an explicit tombstone operation with an audit record. Tombstoned evidence is excluded from active reasoning and graph; links retain historical traceability. Physical erasure/retention automation and account deletion require a documented retention policy before production deployment; they are not silently simulated.
