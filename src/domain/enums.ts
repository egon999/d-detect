import { z } from 'zod';

/**
 * Every bounded value in CaseGraph is an explicit enum rather than a free string.
 * The zod schema is the single source of truth; the TypeScript type is derived from
 * it so a value can never drift between validation and compilation.
 */

export const CaseStatusEnum = z.enum(['OPEN', 'IN_REVIEW', 'CLOSED', 'ARCHIVED']);
export type CaseStatus = z.infer<typeof CaseStatusEnum>;

export const EvidenceKindEnum = z.enum(['PDF', 'IMAGE', 'TEXT', 'EMAIL', 'NOTE', 'SPREADSHEET', 'OTHER']);
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
]);
export type AnalysisType = z.infer<typeof AnalysisTypeEnum>;

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
 * app is MANUAL > DETERMINISTIC > AI: a confirmed human value is never overwritten
 * by a later machine extraction.
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

export const EntityKindEnum = z.enum(['claim', 'event', 'evidence']);
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
};

export const CONFIDENCE_LABELS: Record<MatchConfidence, string> = {
  EXACT_MATCH: 'Exact match',
  STRONG_MATCH: 'Strong match',
  SUGGESTED_MATCH: 'Suggested match',
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
