import { z } from 'zod';

import {
  AnalysisTypeEnum,
  AuditActionEnum,
  CaseStatusEnum,
  ClaimStateEnum,
  CloudStatusEnum,
  type CloudStatus,
  DatePrecisionEnum,
  EntityKindEnum,
  EvidenceKindEnum,
  type EvidenceKind,
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
  normalized: z.number().optional(),
});
export type AmountField = z.infer<typeof amountFieldSchema>;

export const chatMessageSchema = z.object({
  sender: z.string().max(120),
  recipient: z.string().max(120).optional(),
  timestamp: z.string().max(80).optional(),
  content: z.string().max(3000),
  tone: z.string().max(60).optional(),
  suspicious: z.boolean().default(false),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * One span of a time-based recording, with the clock positions it occupies.
 */
export interface TimedSegment {
  index: number;
  text: string;
  startMs: number;
  endMs?: number;
  source: 'speech' | 'frame-text';
}

/**
 * The normalized shape every evidence item is reduced to, whatever its source format.
 * Adding a new entity type here is the single place that changes.
 */
export const extractionSchema = z.object({
  limitations: z.array(z.string().max(2000)).default([]),
  segments: z.array(z.object({
    id: z.string().min(1).max(160),
    text: z.string().max(30000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    page: z.number().int().positive().optional(),
    startMs: z.number().nonnegative().optional(),
    endMs: z.number().nonnegative().optional(),
    method: z.string().min(1).max(60),
  })).default([]),
  documentType: z.string().max(80),
  title: z.string().max(200),
  summary: z.string().max(1200).default(''),
  dates: z.array(dateFieldSchema).default([]),
  amounts: z.array(amountFieldSchema).default([]),
  parties: z.array(textFieldSchema).default([]),
  people: z.array(textFieldSchema).default([]),
  organizations: z.array(textFieldSchema).default([]),
  emails: z.array(textFieldSchema).default([]),
  phones: z.array(textFieldSchema).default([]),
  invoiceNumbers: z.array(textFieldSchema).default([]),
  orderNumbers: z.array(textFieldSchema).default([]),
  transactionIds: z.array(textFieldSchema).default([]),
  addresses: z.array(textFieldSchema).default([]),
  keywords: z.array(textFieldSchema).default([]),
  chatMessages: z.array(chatMessageSchema).default([]),
  transactionStatus: z.enum(['SUCCESS', 'FAILED', 'PENDING', 'CANCELLED', 'UNKNOWN']).default('UNKNOWN'),
  disputedPoints: z.array(z.string().max(400)).default([]),
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
  email: z.string().max(255),
  displayName: z.string().max(120).default(''),
  photoURL: z.string().max(1000).nullable().default(null),
  phone: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const caseParticipantSchema = z.object({
  id: idSchema,
  name: z.string().max(120),
  role: z.string().max(80),
  contact: z.string().max(160).optional(),
});
export type CaseParticipant = z.infer<typeof caseParticipantSchema>;

export const caseSchema = z.object({
  ...baseEntity,
  title: z.string().min(1).max(160),
  description: z.string().max(4000).default(''),
  status: CaseStatusEnum,
  /** Free-form categorisation, e.g. "Payment dispute". Not an enum: users define their own. */
  category: z.string().max(80).default(''),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  participants: z.array(caseParticipantSchema).default([]),
  tags: z.array(z.string().max(60)).default([]),
  incidentDate: z.string().max(60).nullable().default(null),
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
  sourceLabel: z.string().max(240).optional(),
  capturedAt: z.string().max(120).optional(),

  /** File metadata. Null for NOTE evidence, which has no underlying file. */
  fileName: z.string().max(260).nullable().default(null),
  mimeType: z.string().max(160).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  /** Path inside the storage provider. Never a public URL. */
  storagePath: z.string().max(600).nullable().default(null),
  /** Lowercase hex SHA-256 of the file bytes. The only basis for an exact-duplicate claim. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),

  /** Remote delivery / backup URL when mirrored to Cloud Storage / Cloudinary. */
  cloudUrl: z.string().max(1000).nullable().optional(),
  /** Remote asset identifier (e.g. Cloudinary public_id). */
  cloudPublicId: z.string().max(300).nullable().optional(),
  /** Cloud sync lifecycle state. Default: LOCAL_ONLY */
  cloudStatus: CloudStatusEnum.optional(),
  /** Timestamp when remote sync succeeded. */
  cloudSyncedAt: timestampSchema.nullable().optional(),

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

/**
 * One value a finding rests on that was read from pixels and that no person has confirmed.
 *
 * Carries everything the prompt needs to be actionable without a second lookup: which
 * evidence item, which field inside its extraction, what to call it, and what it currently
 * reads as. `path` is the same key `confirmEvidenceFields` writes (`amounts.0`,
 * `dates.2`), so confirming from a finding and confirming from the evidence screen are
 * the same operation and cannot drift apart.
 */
export const unconfirmedReadSchema = z.object({
  evidenceId: idSchema,
  path: z.string().max(60),
  label: z.string().max(60),
  /** The value as currently read, so the prompt can show what is being confirmed. */
  reading: z.string().max(200),
});
export type UnconfirmedRead = z.infer<typeof unconfirmedReadSchema>;

export const analysisResultSchema = z.object({
  ...caseScopedEntity,
  resultType: AnalysisTypeEnum,
  severity: SeverityEnum,
  title: z.string().max(200),
  /**
   * Plain-language statement of what the records say. The observation only.
   *
   * The 2000-character ceiling is a storage guard, not the editorial budget: rule copy is held
   * to roughly 180 characters by `tests/rule-copy.test.ts`, because `FindingCard` renders this
   * in full. The ceiling stays wide so that a finding written by the AI layer, or one carried
   * over from a build before the split, is stored rather than rejected.
   */
  explanation: z.string().max(2000),
  /**
   * Why this reading might be wrong — the hedge, the assumption, the thing to check.
   *
   * Empty on a finding that compared exact values out of machine-readable text, and on every
   * record written before this field existed; the default is what makes those load. See
   * `docs/copy-doctrine.md` for why this is a separate field rather than two more sentences
   * on `explanation`.
   */
  caveat: z.string().max(1200).default(''),
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
  /**
   * True when this finding accuses two documents of disagreeing, but at least one of the
   * values it compared was read from an image and never confirmed by a person.
   *
   * A misread digit turning ₹1,500 into ₹7,500 would manufacture a contradiction that
   * does not exist — the worst failure this product can have. Such a finding is still
   * shown (hiding it would be its own kind of lie), but it is shown as a question rather
   * than an accusation, and `unconfirmedReads` lists exactly what must be checked to turn
   * it into one or make it disappear.
   *
   * Only conflict-shaped findings are ever provisional. An unconfirmed read that merely
   * groups or corroborates is left alone: a misread there fails towards silence.
   */
  provisional: z.boolean().default(false),
  /**
   * The unconfirmed image-read values this finding rests on, each one a one-tap confirm
   * target. Can be empty on a provisional finding — an AI reading of a whole document has
   * no single field to confirm — in which case the cited evidence is what must be read.
   */
  unconfirmedReads: z.array(unconfirmedReadSchema).default([]),
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
  type: z.enum(['EVIDENCE', 'CASE']).default('EVIDENCE'),
  evidenceId: idSchema.nullable().default(null),
  resultPath: z.string().max(600).nullable().default(null),
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

export const caseCitationSchema = z.object({
  evidenceId: idSchema,
  segmentId: z.string().min(1).max(160),
  quote: z.string().min(1).max(4000),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  stance: z.enum(['SUPPORTS', 'CONTRADICTS', 'CONTEXT']),
}).refine((value) => value.endOffset > value.startOffset, 'Citation offsets must identify source text');
export type CaseCitation = z.infer<typeof caseCitationSchema>;

export const claimAssessmentSchema = z.object({
  claimId: idSchema,
  statement: z.string().min(1).max(2000),
  status: z.enum(['SUPPORTED', 'PARTIALLY_SUPPORTED', 'CONTRADICTED', 'DISPUTED', 'INSUFFICIENT_EVIDENCE', 'UNRESOLVED']),
  explanation: z.string().max(8000),
  citations: z.array(caseCitationSchema).max(100),
  missingInformation: z.array(z.string().max(2000)).max(40),
  limitations: z.array(z.string().max(2000)).max(40),
});
export type ClaimAssessment = z.infer<typeof claimAssessmentSchema>;

const citedStatementSchema = z.object({
  statement: z.string().min(1).max(4000),
  citations: z.array(caseCitationSchema).min(1).max(100),
});

/** Saved by the backend after citations are checked against the source segments. */
export const caseAnalysisSchema = z.object({
  ...caseScopedEntity,
  jobId: idSchema,
  schemaVersion: z.literal('1'),
  summary: z.string().max(10000),
  claims: z.array(claimAssessmentSchema).max(200),
  agreements: z.array(citedStatementSchema).max(100),
  entities: z.array(z.object({
    name: z.string().min(1).max(240),
    type: z.enum(['PERSON', 'ORG', 'TRANSACTION', 'DOCUMENT', 'LOCATION']),
    citations: z.array(caseCitationSchema).min(1).max(100),
  })).default([]),
  contradictions: z.array(citedStatementSchema).max(100),
  timeline: z.array(z.object({
    description: z.string().max(4000),
    occurredAt: z.string().max(120).nullable(),
    citations: z.array(caseCitationSchema).min(1).max(100),
  })).max(200),
  limitations: z.array(z.string().max(2000)).max(100),
  coverage: z.object({
    totalEvidence: z.number().int().nonnegative(),
    processedEvidence: z.number().int().nonnegative(),
    excludedEvidenceIds: z.array(idSchema),
    truncated: z.boolean(),
  }),
  model: z.string().min(1).max(160),
  promptVersion: z.string().min(1).max(80),
});
export type CaseAnalysis = z.infer<typeof caseAnalysisSchema>;

/**
 * A server's signature over a case's audit chain at a moment in time.
 *
 * The one record in this model a client cannot write. It is produced by a Cloud Function
 * holding an Ed25519 key the device does not have, and stored so that anyone — with no
 * account — can re-derive the chain and check the signature. `@domain/crucible/seal` holds
 * the signing recipe, the verification, and the precise statement of what a seal does and
 * does not prove; this schema is only its shape at rest.
 *
 * The fields are exactly what `sealPayload` signs, plus the base-entity stamps. A
 * compile-time assertion in `@domain/crucible/seal` pins `Seal` to the `SealedAttestation`
 * shape that module verifies, so the record written here and the bytes checked there cannot
 * drift apart.
 */
export const sealSchema = z.object({
  ...caseScopedEntity,
  /** The audit chain head that was signed: 64 lowercase hex characters. */
  chainHead: z.string().regex(/^[a-f0-9]{64}$/),
  /** How many entries that head covers. The seal attests to a prefix of this length. */
  entryCount: z.number().int().positive(),
  /** The signing server's clock at signing time, epoch ms. Never the client's. */
  sealedAt: timestampSchema,
  /** The signature of the previous seal for this case, chaining the seals into a ladder. */
  previousSealSignature: z.string().regex(/^[a-f0-9]{128}$/).nullable().default(null),
  /** The Ed25519 signature over the seal payload: 128 lowercase hex characters. */
  signature: z.string().regex(/^[a-f0-9]{128}$/),
  /** Which published key signed this. An id no verifier holds is a failure, never a pass. */
  keyId: z.string().min(1).max(60),
  algorithm: z.literal('ed25519'),
});
export type Seal = z.infer<typeof sealSchema>;

export const aiSuggestionSchema = z.object({
  ...caseScopedEntity,
  evidenceId: idSchema.nullable().default(null),
  /**
   * What shape of proposal the payload carries.
   *
   * `DISPUTE_SYNTHESIS` was added when the case-level AI pass was wired: a narrative
   * summary of the whole case is none of the four original kinds, and filing it under
   * one of them (a `RELATIONSHIP` with no endpoints, a `DOCUMENT_TYPE` about no
   * document) would put a false label on a record whose entire value is that its label
   * is true. Additive only - existing kinds keep their meaning.
   *
   * The last four were added when the case pass was re-pointed at the work this product
   * exists to do. The model had been asked for a narrative summary of the dispute —
   * readable, plausible, and a restatement of what the user already knew. It was not
   * asked to reconcile the documents against each other, to say which claims the
   * evidence actually supports, to name what is missing, or to check whether the dates
   * can all be true at once. Those four functions were written, tested, and never called
   * from anywhere. They are the kinds below.
   *
   * `DISPUTE_SYNTHESIS` stays in this enum although nothing writes it any more. This
   * enum is a record contract, not a list of current features: a user who ran the old
   * pass has synthesis documents in their case, and removing the value would fail
   * validation on load and make those records unreadable.
   */
  kind: z.enum([
    'FIELD_EXTRACTION',
    'RELATIONSHIP',
    'DOCUMENT_TYPE',
    'EVENT_MATCH',
    'DISPUTE_SYNTHESIS',
    /** Values that disagree across documents, each side quoted from its own source. */
    'CROSS_DOCUMENT_RECONCILIATION',
    /** What a claim would need and the case does not have. */
    'MISSING_INFORMATION',
    /** Whether the documents actually support each claim, graded and cited. */
    'SUPPORT_STRENGTH',
    /** Whether the dates across the documents can all be true together. */
    'TIMELINE_COHERENCE',
  ]),
  status: SuggestionStatusEnum,
  /**
   * The model's own reported confidence, or `null` when it reported none.
   *
   * Nullable on purpose. An earlier version substituted 0.5 for a missing value, which
   * put a number on screen that no model had ever produced — a fabricated measurement in
   * a product whose entire claim is that it does not fabricate. "Not reported" is a real
   * state and is stored as one.
   *
   * Note this is the model's self-assessment, not a measurement of accuracy. The UI shows
   * it as an interpretable band rather than a percentage; see `confidenceBand` in
   * `@services/ai/provenance`.
   */
  confidence: z.number().min(0).max(1).nullable().default(null),
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
  caseAnalyses: CaseAnalysis[];
  seals: Seal[];
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
    caseAnalyses: [],
    seals: [],
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
  // Defaulted, like `caseAnalyses` above it: a workspace stored before seals existed has no
  // such key, and a required field would make every previously saved local case unreadable.
  caseAnalyses: z.array(caseAnalysisSchema).default([]),
  seals: z.array(sealSchema).default([]),
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
  caseAnalyses: 'caseAnalyses',
  seals: 'seals',
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
export { CloudStatusEnum, type CloudStatus, EvidenceKindEnum, type EvidenceKind };
