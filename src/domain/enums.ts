import { z } from 'zod';

/**
 * Every bounded value in Detact is an explicit enum rather than a free string.
 * The zod schema is the single source of truth; the TypeScript type is derived from
 * it so a value can never drift between validation and compilation.
 */

export const CaseStatusEnum = z.enum(['OPEN', 'IN_REVIEW', 'CLOSED', 'ARCHIVED']);
export type CaseStatus = z.infer<typeof CaseStatusEnum>;

export const EvidenceKindEnum = z.enum(['PDF', 'IMAGE', 'TEXT', 'EMAIL', 'NOTE', 'SPREADSHEET', 'AUDIO', 'VIDEO', 'DOCUMENT', 'OTHER']);
export type EvidenceKind = z.infer<typeof EvidenceKindEnum>;

/**
 * Lifecycle of a single evidence item. The order below is the normal happy path;
 * FAILED and REVIEW_REQUIRED are recoverable side states, not terminal errors.
 */
export const ProcessingStateEnum = z.enum([
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
  'EXTRACTED',
  'ANALYZED',
  'REVIEW_REQUIRED',
  'FAILED',
  'CONFIRMED',
]);
export type ProcessingState = z.infer<typeof ProcessingStateEnum>;

export const RelationshipTypeEnum = z.enum([
  'SUPPORTS',
  'CONTRADICTS',
  'RELATED_TO',
  'DERIVED_FROM',
  'DUPLICATE_OF',
  'ATTACHED_TO_EVENT',
  'RELEVANT_TO_CLAIM',
  'CORROBORATES',
  'INVOLVES',
  'MENTIONS',
]);
export type RelationshipType = z.infer<typeof RelationshipTypeEnum>;

export const AnalysisTypeEnum = z.enum([
  'POSSIBLE_CONFLICT',
  'UNSUPPORTED_CLAIM',
  'CORROBORATED_CLAIM',
  'CORROBORATED_EVENT',
  'DUPLICATE_EVIDENCE',
  'MISSING_EVIDENCE',
  'AMOUNT_MISMATCH',
  'RELATED_EVIDENCE',
  'TIMELINE_GAP',
  'PAYMENT_STATUS_CONFLICT',
  'HARASSMENT_INDICATOR',
  'STATEMENT_DISCREPANCY',
  /**
   * Evidence that exists in the case but is connected to nothing.
   *
   * Kept distinct from RELATED_EVIDENCE, which it is the exact inverse of: one says
   * "these documents are about the same thing", the other says "nothing has been said
   * about this document at all". Filing both under one type would let a filter for
   * connections return the disconnected.
   */
  'UNLINKED_EVIDENCE',
  /**
   * A complaint in the case has gone longer without an answer than its redressal scheme
   * generally allows, and nothing else in the case is dated since.
   *
   * The only finding type that is about the *calendar* rather than about the documents
   * agreeing with each other. It exists because the most common way a dispute in this
   * market is lost has nothing to do with the evidence: the complaint is filed, nobody
   * replies, and by the time anyone mentions that an ombudsman existed, the window has
   * closed. See `@domain/analysis/escalation` for the line this must not cross — it reports
   * elapsed time and names a forum, and never states a deadline.
   */
  'RESPONSE_OVERDUE',
]);
export type AnalysisType = z.infer<typeof AnalysisTypeEnum>;

/**
 * The finding types that say two records disagree.
 *
 * ## Why this is one set and not a condition at each call site
 *
 * It was six. `claim-state.ts` decided whether a claim is contradicted from a five-way `||`
 * chain; `graph.ts`, `case-analysis-panel.tsx` and two separate lists inside
 * `services/ai/case-analysis.ts` each hand-wrote an array; `semantic-assistant.ts` wrote the
 * chain twice more. No two of them matched.
 *
 * The consequences were not theoretical. The panel's list omitted `POSSIBLE_CONFLICT` and the
 * graph's included it, so the same case reported a different number of conflicts depending on
 * which screen you were reading — in a product whose entire claim is that it tells you what the
 * evidence says. One list also contained `'EVENT_DATE_CONFLICT'`, which has never been a member
 * of this enum: the rule in `definitions/event-date-conflict.ts` reports `POSSIBLE_CONFLICT`.
 * Nothing caught it because a bare `string[]` is compared against by `includes`, which accepts
 * any string, so the entry sat there matching nothing.
 *
 * Typed as `AnalysisType[]` before being frozen into a set, so a misspelling is a compile error
 * and a type added to the enum later is a decision someone makes here rather than a conflict
 * four screens quietly stop counting.
 *
 * ## What is deliberately not in it
 *
 * `DUPLICATE_EVIDENCE` and `RELATED_EVIDENCE` say two documents are *about the same thing*,
 * which is the opposite finding. `TIMELINE_GAP`, `MISSING_EVIDENCE`, `UNLINKED_EVIDENCE` and
 * `RESPONSE_OVERDUE` are about what is absent — nothing disagrees with anything in them, and
 * counting a silence as a conflict would be the app inventing a dispute.
 *
 * `HARASSMENT_INDICATOR` is in, following `claim-state.ts`, which is the module with the
 * strongest claim to have reasoned about it: it is the list that decides whether a user's claim
 * reads as contradicted, so it is the one whose membership has consequences for a conclusion.
 */
const CONFLICT_ANALYSIS_TYPE_LIST: readonly AnalysisType[] = [
  'POSSIBLE_CONFLICT',
  'AMOUNT_MISMATCH',
  'PAYMENT_STATUS_CONFLICT',
  'STATEMENT_DISCREPANCY',
  'HARASSMENT_INDICATOR',
];

export const CONFLICT_ANALYSIS_TYPES: ReadonlySet<AnalysisType> = new Set(CONFLICT_ANALYSIS_TYPE_LIST);

/** Whether a finding of this type asserts that two records disagree. */
export function isConflictFinding(type: AnalysisType): boolean {
  return CONFLICT_ANALYSIS_TYPES.has(type);
}

export const SeverityEnum = z.enum(['HIGH', 'MEDIUM', 'LOW', 'INFO']);
export type Severity = z.infer<typeof SeverityEnum>;

/**
 * Findings are reviewed, never deleted. RESOLVED means the underlying condition no
 * longer holds after a re-run; DISMISSED means a human judged it irrelevant.
 */
export const FindingStatusEnum = z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']);
export type FindingStatus = z.infer<typeof FindingStatusEnum>;

export const SuggestionStatusEnum = z.enum(['SUGGESTED', 'ACCEPTED', 'REJECTED']);
export type SuggestionStatus = z.infer<typeof SuggestionStatusEnum>;

/**
 * Provenance of a single extracted field. The precedence order used throughout the
 * app is MANUAL > DETERMINISTIC > OCR > AI: a confirmed human value is never overwritten
 * by a later machine extraction, and where two machines disagree the one that read the
 * characters off the page outranks the one that inferred them.
 */
export const ExtractionMethodEnum = z.enum(['MANUAL', 'DETERMINISTIC', 'OCR', 'AI']);
export type ExtractionMethod = z.infer<typeof ExtractionMethodEnum>;

/**
 * Interpretable confidence labels. A deliberate product decision: showing "99.7%"
 * next to a machine guess implies a precision the system does not have.
 */
export const MatchConfidenceEnum = z.enum(['EXACT_MATCH', 'STRONG_MATCH', 'SUGGESTED_MATCH', 'NEEDS_REVIEW']);
export type MatchConfidence = z.infer<typeof MatchConfidenceEnum>;

/**
 * A claim is never simply true or false. MIXED_REVIEW exists so that a claim with
 * both supporting and contradicting evidence is surfaced for a human rather than
 * silently resolved by the machine.
 */
export const ClaimStateEnum = z.enum(['SUPPORTED', 'CONTRADICTED', 'UNSUPPORTED', 'MIXED_REVIEW']);
export type ClaimState = z.infer<typeof ClaimStateEnum>;

export const EntityKindEnum = z.enum(['claim', 'event', 'evidence', 'entity', 'conflict']);
export type EntityKind = z.infer<typeof EntityKindEnum>;

export const DatePrecisionEnum = z.enum(['DAY', 'MONTH', 'YEAR', 'UNKNOWN']);
export type DatePrecision = z.infer<typeof DatePrecisionEnum>;

export const AuditActionEnum = z.enum([
  'CASE_CREATED',
  'CASE_UPDATED',
  'CASE_STATUS_CHANGED',
  'CLAIM_CREATED',
  'CLAIM_UPDATED',
  'CLAIM_DELETED',
  'EVENT_CREATED',
  'EVENT_UPDATED',
  'EVENT_DELETED',
  'EVIDENCE_UPLOADED',
  'EVIDENCE_PROCESSED',
  'EVIDENCE_CONFIRMED',
  'EVIDENCE_DELETED',
  'EVIDENCE_LINKED',
  'EVIDENCE_UNLINKED',
  'ANALYSIS_RUN',
  'FINDING_REVIEWED',
  'FINDING_DISMISSED',
  'SUGGESTION_ACCEPTED',
  'SUGGESTION_REJECTED',
  'PROCESSING_RETRIED',
  /**
   * A server sealed the case's audit chain — the one action in this list a client cannot
   * write. The seal is produced by a Cloud Function holding a key the device does not have,
   * and the entry recording it is written by that same function through the Admin SDK. It
   * names the chain head and entry count that were signed, so the audit trail carries its
   * own pointer to the attestation that covers it. See `@domain/crucible/seal`.
   */
  'SEAL_CREATED',
]);
export type AuditAction = z.infer<typeof AuditActionEnum>;

/** Human-facing labels. Kept beside the enums so a new member cannot be added without one. */

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  SUPPORTS: 'Supports',
  CONTRADICTS: 'Contradicts',
  RELATED_TO: 'Related to',
  DERIVED_FROM: 'Derived from',
  DUPLICATE_OF: 'Duplicate of',
  ATTACHED_TO_EVENT: 'Attached to event',
  RELEVANT_TO_CLAIM: 'Relevant to claim',
  CORROBORATES: 'Corroborates',
  INVOLVES: 'Involves party',
  MENTIONS: 'Mentions entity',
};

/**
 * How well grounded a finding or a comparison is.
 *
 * The word "match" is deliberately absent from every label. In forensic practice it carries
 * a claim of identity — that two things *are* the same — and the US Department of Justice's
 * uniform language guidance for forensic testimony specifically discourages examiners from
 * expressing conclusions in those terms, because a reader hears certainty that the method
 * cannot deliver. Nothing in this app establishes identity. It observes that two documents
 * state values that agree, which is a statement about documents, not about the world.
 *
 * So the ladder describes the *strength of the grounds* instead: exact, strong, possible,
 * or not yet decided by anyone. A reader can disagree with grounds. They cannot disagree
 * with a "match".
 */
export const CONFIDENCE_LABELS: Record<MatchConfidence, string> = {
  EXACT_MATCH: 'Exact',
  STRONG_MATCH: 'Strong grounds',
  SUGGESTED_MATCH: 'Possible',
  NEEDS_REVIEW: 'Needs review',
};

export const CLAIM_STATE_LABELS: Record<ClaimState, string> = {
  SUPPORTED: 'Supported',
  CONTRADICTED: 'Contradicted',
  UNSUPPORTED: 'Unsupported',
  MIXED_REVIEW: 'Mixed — needs review',
};

export const ANALYSIS_LABELS: Record<AnalysisType, string> = {
  POSSIBLE_CONFLICT: 'Possible conflict',
  UNSUPPORTED_CLAIM: 'Unsupported claim',
  CORROBORATED_CLAIM: 'Corroborated claim',
  CORROBORATED_EVENT: 'Corroborated event',
  DUPLICATE_EVIDENCE: 'Duplicate evidence',
  MISSING_EVIDENCE: 'Missing evidence',
  AMOUNT_MISMATCH: 'Amount mismatch',
  RELATED_EVIDENCE: 'Related evidence',
  TIMELINE_GAP: 'Timeline gap',
  PAYMENT_STATUS_CONFLICT: 'Payment status conflict',
  HARASSMENT_INDICATOR: 'Harassment / hostile tone detected',
  STATEMENT_DISCREPANCY: 'Cross-source statement discrepancy',
  UNLINKED_EVIDENCE: 'Not linked to anything',
  RESPONSE_OVERDUE: 'No reply yet',
};

export const PROCESSING_STATE_LABELS: Record<ProcessingState, string> = {
  UPLOADING: 'Uploading',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  EXTRACTED: 'Extracted',
  ANALYZED: 'Analysed',
  REVIEW_REQUIRED: 'Needs review',
  FAILED: 'Failed',
  CONFIRMED: 'Confirmed',
};

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  OPEN: 'Open',
  IN_REVIEW: 'In review',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

/**
 * How a value got into the app, in words.
 *
 * `DETERMINISTIC` and `OCR` are worded to keep a distinction the user must not lose: text
 * lifted verbatim from a document's own text layer versus text a recogniser guessed at from an
 * image. "Read from the document" is only honest for the former — the latter came from pixels
 * and may be wrong, so it says "an image", never "the document".
 *
 * ## Why this lives here rather than in the UI
 *
 * It used to be defined in `src/ui/semantics.ts` and nowhere else, which put it out of reach of
 * the one layer that also needs it: `src/domain/rules/` is deliberately free of UI imports, so
 * the response-overdue rule, needing to tell a reader where a date came from, wrote
 * `field.method` — and the finding table showed "Date read by: DETERMINISTIC". Naming a
 * provenance tier is domain vocabulary, the same as naming a case status, so it sits with its
 * eight siblings above and `src/ui/semantics.ts` re-exports it for the components that had it.
 */
export const EXTRACTION_METHOD_LABELS: Record<ExtractionMethod, string> = {
  MANUAL: 'Entered by you',
  DETERMINISTIC: 'Read from the document',
  OCR: 'Read from an image',
  AI: 'Suggested by AI',
};

/**
 * What each recorded action is called in the history.
 *
 * `AuditAction` was the last enum in this file without a label map, and the audit screen
 * paid for it: it rendered `action.replace(/_/g, ' ')`, so a reader was shown "CASE STATUS
 * CHANGED" and "SUGGESTION REJECTED" — the identifier, shouted.
 *
 * These labels name the *kind* of change and stop there, because every entry also carries a
 * written summary naming the record it touched ("Uploaded \"Invoice 4471\""). A label that
 * repeated that detail would make the pair read as a stutter, so it is category first and
 * specifics second.
 *
 * Where the enum member's own name and the wording of the mutation that writes it disagree,
 * the mutation wins, because that is the wording a person actually meets: `CASE_UPDATED` is
 * written for a deletion as well as an edit, so it stays the broad "Case updated"; and a
 * `SUGGESTION_REJECTED` entry is summarised "Dismissed AI suggestion", never "rejected".
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  CASE_CREATED: 'Case created',
  CASE_UPDATED: 'Case updated',
  CASE_STATUS_CHANGED: 'Case status changed',
  CLAIM_CREATED: 'Claim added',
  CLAIM_UPDATED: 'Claim edited',
  CLAIM_DELETED: 'Claim removed',
  EVENT_CREATED: 'Event added',
  EVENT_UPDATED: 'Event edited',
  EVENT_DELETED: 'Event removed',
  EVIDENCE_UPLOADED: 'Evidence added',
  EVIDENCE_PROCESSED: 'Evidence processed',
  EVIDENCE_CONFIRMED: 'Details confirmed',
  EVIDENCE_DELETED: 'Evidence deleted',
  EVIDENCE_LINKED: 'Link added',
  EVIDENCE_UNLINKED: 'Link removed',
  ANALYSIS_RUN: 'Case analysed',
  FINDING_REVIEWED: 'Finding reviewed',
  FINDING_DISMISSED: 'Finding dismissed',
  SUGGESTION_ACCEPTED: 'Suggestion accepted',
  SUGGESTION_REJECTED: 'Suggestion dismissed',
  PROCESSING_RETRIED: 'Processing retried',
  SEAL_CREATED: 'Record sealed',
};

/**
 * What a source is, in the words a reader would use for it.
 *
 * Each label names the thing rather than the file format where the two differ: NOTE is
 * the one kind with no underlying file — a statement the user typed — and calling it
 * "Note" on a screen full of uploaded documents would understate what it is. OTHER is
 * phrased as the honest negative ("Unrecognised file"), because the enum member means the
 * uploader could not classify it, not that the file belongs to some category named Other.
 */
export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  PDF: 'PDF document',
  IMAGE: 'Image',
  TEXT: 'Text file',
  EMAIL: 'Email',
  NOTE: 'Typed statement',
  SPREADSHEET: 'Spreadsheet',
  AUDIO: 'Audio recording',
  VIDEO: 'Video recording',
  DOCUMENT: 'Word document',
  OTHER: 'Unrecognised file',
};
