import { z } from 'zod';

import {
  AnalysisTypeEnum,
  AuditActionEnum,
  CaseStatusEnum,
  ClaimStateEnum,
  DatePrecisionEnum,
  EntityKindEnum,
  EvidenceKindEnum,
  ExtractionMethodEnum,
  FindingStatusEnum,
  MatchConfidenceEnum,
  ProcessingStateEnum,
  RelationshipTypeEnum,
  SeverityEnum,
  SuggestionStatusEnum,
} from './enums';
import { ID_PATTERN } from './ids';

/**
 * Entity schemas.
 *
 * These zod schemas are the contract at every boundary — Firestore reads, local
 * storage reads, seed data and Cloud Function payloads all pass through them. A
 * malformed document therefore fails loudly at the edge instead of producing an
 * `undefined` three screens later.
 */

export const idSchema = z.string().regex(ID_PATTERN, 'Invalid identifier');

/** Epoch milliseconds. Chosen over Firestore `Timestamp` so the domain layer stays free of SDK types. */
export const timestampSchema = z.number().int().nonnegative();

const baseEntity = {
  id: idSchema,
  ownerId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** Every case-scoped document carries `caseId` explicitly so Security Rules can authorise it in one read. */
const caseScopedEntity = { ...baseEntity, caseId: idSchema };

// ---------------------------------------------------------------------------
// Extracted values and their provenance
// ---------------------------------------------------------------------------

/**
 * Provenance attached to every extracted value. `method` drives the precedence rule
 * (MANUAL beats DETERMINISTIC beats AI) and `sourceQuote` is what the UI shows when
 * a user asks "where did this come from?".
 */
export const provenanceSchema = z.object({
  evidenceId: idSchema,
  method: ExtractionMethodEnum,
  /** The surrounding snippet the value was read from. Kept short on purpose. */
  sourceQuote: z.string().max(400).optional(),
  /** Populated only for AI-derived values. */
  model: z.string().max(120).optional(),
  extractionVersion: z.string().max(60).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const textFieldSchema = provenanceSchema.extend({
  original: z.string().max(600),
  normalized: z.string().max(600),
});
export type TextField = z.infer<typeof textFieldSchema>;

export const dateFieldSchema = provenanceSchema.extend({
  original: z.string().max(120),
  iso: z.string().max(10).nullable(),
  precision: DatePrecisionEnum,
  ambiguous: z.boolean(),
  /** Optional role hint, e.g. "issued", "due", "paid". */
  role: z.string().max(40).optional(),
});
export type DateField = z.infer<typeof dateFieldSchema>;

export const amountFieldSchema = provenanceSchema.extend({
  original: z.string().max(120),
  minorUnits: z.number().int(),
  currency: z.string().length(3),
  role: z.string().max(40).optional(),
});
export type AmountField = z.infer<typeof amountFieldSchema>;

/**
 * The normalized shape every evidence item is reduced to, whatever its source format.
 * Adding a new entity type here is the single place that changes.
 */
export const extractionSchema = z.object({
  documentType: z.string().max(80),
  title: z.string().max(200),
  summary: z.string().max(1200).default(''),
  dates: z.array(dateFieldSchema).default([]),
  amounts: z.array(amountFieldSchema).default([]),
  people: z.array(textFieldSchema).default([]),
  organizations: z.array(textFieldSchema).default([]),
  emails: z.array(textFieldSchema).default([]),
  phones: z.array(textFieldSchema).default([]),
  invoiceNumbers: z.array(textFieldSchema).default([]),
  orderNumbers: z.array(textFieldSchema).default([]),
  transactionIds: z.array(textFieldSchema).default([]),
  addresses: z.array(textFieldSchema).default([]),
  keywords: z.array(textFieldSchema).default([]),
  /** Raw text the extraction was derived from. Bounded, and never written to logs. */
  sourceText: z.string().max(40_000).default(''),
  sourceTextTruncated: z.boolean().default(false),
  /** Identifies the extractor build that produced this result, for reproducibility. */
  extractorVersion: z.string().max(60),
});
export type Extraction = z.infer<typeof extractionSchema>;

/** The list-valued entity fields, used by generic merge and display code. */
export const TEXT_FIELD_KEYS = [
  'people',
  'organizations',
  'emails',
  'phones',
  'invoiceNumbers',
  'orderNumbers',
  'transactionIds',
  'addresses',
  'keywords',
] as const;
export type TextFieldKey = (typeof TEXT_FIELD_KEYS)[number];

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export const userProfileSchema = z.object({
  ...baseEntity,
  email: z.email(),
  displayName: z.string().max(120).default(''),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const caseSchema = z.object({
  ...baseEntity,
  title: z.string().min(1).max(160),
  description: z.string().max(4000).default(''),
  status: CaseStatusEnum,
  /** Free-form categorisation, e.g. "Payment dispute". Not an enum: users define their own. */
  category: z.string().max(80).default(''),
  /** Timestamp of the last successful rule-engine run, used to show staleness. */
  lastAnalyzedAt: timestampSchema.nullable().default(null),
  deletedAt: timestampSchema.nullable().default(null),
});
export type Case = z.infer<typeof caseSchema>;

export const claimSchema = z.object({
  ...caseScopedEntity,
  statement: z.string().min(1).max(2000),
  detail: z.string().max(4000).default(''),
  /** Events that must be evidenced for this claim to stand. Drives MISSING_EVIDENCE. */
  requiredEventIds: z.array(idSchema).default([]),
  /**
   * Cached result of `deriveClaimState`. Stored for list rendering and querying only;
   * the relationships remain the source of truth and the cache is recomputed on
   * every analysis run.
   */
  state: ClaimStateEnum.default('UNSUPPORTED'),
  deletedAt: timestampSchema.nullable().default(null),
});
export type Claim = z.infer<typeof claimSchema>;

export const caseEventSchema = z.object({
  ...caseScopedEntity,
  title: z.string().min(1).max(160),
  description: z.string().max(4000).default(''),
  occurredAt: dateFieldSchema.nullable(),
  /** Claims this event is part of the story for. */
  claimIds: z.array(idSchema).default([]),
  deletedAt: timestampSchema.nullable().default(null),
});
export type CaseEvent = z.infer<typeof caseEventSchema>;

export const evidenceSchema = z.object({
  ...caseScopedEntity,
  title: z.string().min(1).max(200),
  kind: EvidenceKindEnum,
  state: ProcessingStateEnum,
  note: z.string().max(4000).default(''),

  /** File metadata. Null for NOTE evidence, which has no underlying file. */
  fileName: z.string().max(260).nullable().default(null),
  mimeType: z.string().max(160).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  /** Path inside the storage provider. Never a public URL. */
  storagePath: z.string().max(600).nullable().default(null),
  /** Lowercase hex SHA-256 of the file bytes. The only basis for an exact-duplicate claim. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),

  extraction: extractionSchema.nullable().default(null),
  /**
   * Human corrections, keyed by field path (e.g. `invoiceNumbers.0`, `documentType`).
   * Held separately from `extraction` so a reprocess can refresh machine values
   * without ever discarding what a person confirmed.
   */
  confirmedFields: z.record(z.string(), z.string()).default({}),
  confirmedAt: timestampSchema.nullable().default(null),

  failureReason: z.string().max(600).nullable().default(null),
  deletedAt: timestampSchema.nullable().default(null),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const entityRefSchema = z.object({
  kind: EntityKindEnum,
  id: idSchema,
});
export type EntityRef = z.infer<typeof entityRefSchema>;

export const relationshipSchema = z.object({
  ...caseScopedEntity,
  from: entityRefSchema,
  to: entityRefSchema,
  type: RelationshipTypeEnum,
  /** Who asserted this link. Rule-created links are recomputed; user links are permanent. */
  origin: z.enum(['USER', 'RULE', 'AI']),
  /**
   * Whether a CONTRADICTS link is strong enough to flip a claim to CONTRADICTED.
   * A passing remark that disagrees is not the same as a signed document that does.
   */
  material: z.boolean().default(false),
  note: z.string().max(2000).default(''),
  createdByRuleId: z.string().max(80).nullable().default(null),
});
export type EvidenceRelationship = z.infer<typeof relationshipSchema>;

export const analysisResultSchema = z.object({
  ...caseScopedEntity,
  resultType: AnalysisTypeEnum,
  severity: SeverityEnum,
  title: z.string().max(200),
  /** Plain-language explanation aimed at a non-technical reader. */
  explanation: z.string().max(2000),
  supportingEvidenceIds: z.array(idSchema).default([]),
  relatedClaimIds: z.array(idSchema).default([]),
  relatedEventIds: z.array(idSchema).default([]),
  /** Which rules fired. Lets the UI show the reasoning trace and the rule's definition. */
  triggeredRuleIds: z.array(z.string().max(80)).default([]),
  aiSuggestionIds: z.array(idSchema).default([]),
  /** The exact values compared, so a reader can verify the conclusion themselves. */
  inputs: z.record(z.string(), z.string()).default({}),
  confidence: MatchConfidenceEnum,
  status: FindingStatusEnum,
  /** Set when a human reviews or dismisses the finding. */
  reviewedAt: timestampSchema.nullable().default(null),
  reviewNote: z.string().max(1000).default(''),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const auditLogSchema = z.object({
  ...caseScopedEntity,
  action: AuditActionEnum,
  actorId: idSchema,
  /** Entities this action touched, for filtering the per-case history view. */
  entityRefs: z.array(entityRefSchema).default([]),
  summary: z.string().max(400),
  /** Bounded, non-sensitive context. Raw evidence content is never recorded here. */
  metadata: z.record(z.string(), z.string()).default({}),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const processingJobSchema = z.object({
  ...caseScopedEntity,
  evidenceId: idSchema,
  state: ProcessingStateEnum,
  attempts: z.number().int().nonnegative().default(0),
  /**
   * Hash of the inputs this job consumed. A retry with an identical fingerprint is a
   * no-op, which is what makes the pipeline safe to run repeatedly.
   */
  fingerprint: z.string().max(120).nullable().default(null),
  startedAt: timestampSchema.nullable().default(null),
  finishedAt: timestampSchema.nullable().default(null),
  lastError: z.string().max(600).nullable().default(null),
  /** Steps completed so far, so a resumed job skips work it already did. */
  completedSteps: z.array(z.string().max(60)).default([]),
});
export type ProcessingJob = z.infer<typeof processingJobSchema>;

export const aiSuggestionSchema = z.object({
  ...caseScopedEntity,
  evidenceId: idSchema.nullable().default(null),
  kind: z.enum(['FIELD_EXTRACTION', 'RELATIONSHIP', 'DOCUMENT_TYPE', 'EVENT_MATCH']),
  status: SuggestionStatusEnum,
  /** Model-reported or application-derived, kept separate from deterministic confidence. */
  confidence: z.number().min(0).max(1),
  model: z.string().max(120),
  promptVersion: z.string().max(60),
  summary: z.string().max(600),
  /** The proposal itself, as validated JSON. Shape depends on `kind`. */
  payload: z.record(z.string(), z.unknown()).default({}),
  sourceEvidenceIds: z.array(idSchema).default([]),
  reviewedAt: timestampSchema.nullable().default(null),
});
export type AIExtractionSuggestion = z.infer<typeof aiSuggestionSchema>;

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Everything the reasoning engine needs for one case, loaded into memory.
 *
 * The rule engine takes a `Workspace` and returns findings — it never performs I/O.
 * That is what allows the whole engine to be unit tested without Firebase, an
 * emulator or a network.
 */
export interface Workspace {
  cases: Case[];
  claims: Claim[];
  events: CaseEvent[];
  evidence: Evidence[];
  relationships: EvidenceRelationship[];
  analysisResults: AnalysisResult[];
  auditLogs: AuditLog[];
  processingJobs: ProcessingJob[];
  aiSuggestions: AIExtractionSuggestion[];
}

export function emptyWorkspace(): Workspace {
  return {
    cases: [],
    claims: [],
    events: [],
    evidence: [],
    relationships: [],
    analysisResults: [],
    auditLogs: [],
    processingJobs: [],
    aiSuggestions: [],
  };
}

export const workspaceSchema = z.object({
  cases: z.array(caseSchema),
  claims: z.array(claimSchema),
  events: z.array(caseEventSchema),
  evidence: z.array(evidenceSchema),
  relationships: z.array(relationshipSchema),
  analysisResults: z.array(analysisResultSchema),
  auditLogs: z.array(auditLogSchema),
  processingJobs: z.array(processingJobSchema),
  aiSuggestions: z.array(aiSuggestionSchema),
});

/** Collection names, shared by the Firestore adapter, Security Rules and the local adapter. */
export const COLLECTIONS = {
  users: 'users',
  cases: 'cases',
  claims: 'claims',
  events: 'events',
  evidence: 'evidence',
  relationships: 'relationships',
  analysisResults: 'analysisResults',
  auditLogs: 'auditLogs',
  processingJobs: 'processingJobs',
  aiSuggestions: 'aiSuggestions',
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
