import { z } from 'zod';

export const CaseStatus = z.enum(['OPEN', 'REVIEW', 'CLOSED']);
export const EvidenceType = z.enum(['PDF', 'IMAGE', 'TEXT', 'EMAIL', 'NOTE']);
export const ProcessingState = z.enum(['UPLOADING', 'QUEUED', 'PROCESSING', 'EXTRACTED', 'ANALYZED', 'REVIEW_REQUIRED', 'FAILED', 'CONFIRMED']);
export const RelationshipType = z.enum(['SUPPORTS', 'CONTRADICTS', 'RELATED_TO', 'DERIVED_FROM', 'DUPLICATE_OF', 'ATTACHED_TO_EVENT', 'RELEVANT_TO_CLAIM']);
export const AnalysisType = z.enum(['POSSIBLE_CONFLICT', 'UNSUPPORTED_CLAIM', 'CORROBORATED_CLAIM', 'CORROBORATED_EVENT', 'DUPLICATE_EVIDENCE', 'MISSING_EVIDENCE', 'AMOUNT_MISMATCH', 'RELATED_EVIDENCE']);
export const Severity = z.enum(['HIGH', 'MEDIUM', 'LOW', 'INFO']);
export const SuggestionStatus = z.enum(['SUGGESTED', 'ACCEPTED', 'REJECTED']);
export const AuditAction = z.enum(['CASE_CREATED', 'CASE_STATUS_CHANGED', 'CLAIM_CREATED', 'CLAIM_EDITED', 'EVENT_CREATED', 'EVENT_MODIFIED', 'EVIDENCE_UPLOADED', 'EVIDENCE_PROCESSED', 'EVIDENCE_CONFIRMED', 'EVIDENCE_DELETED', 'EVIDENCE_LINKED', 'EVIDENCE_UNLINKED', 'ANALYSIS_RUN', 'ANALYSIS_REVIEWED', 'SUGGESTION_ACCEPTED', 'SUGGESTION_REJECTED', 'PROCESSING_RETRIED']);
export const EntityKind = z.enum(['claim', 'event', 'evidence']);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const base = { id: idSchema, ownerId: idSchema, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() };
const scoped = { ...base, caseId: idSchema };
export const DateValueSchema = z.object({ original: z.string(), iso: z.string().nullable(), precision: z.enum(['DAY', 'MONTH', 'UNKNOWN']) });
export const FieldSchema = z.object({ original: z.string(), value: z.string(), evidenceId: idSchema, method: z.enum(['DETERMINISTIC', 'MANUAL', 'AI']) });
export const ExtractionSchema = z.object({
  documentType: z.string(), title: z.string(), dates: z.array(DateValueSchema.extend({ evidenceId: idSchema, method: z.enum(['DETERMINISTIC', 'MANUAL', 'AI']) })),
  amounts: z.array(z.object({ original: z.string(), minorUnits: z.number().int().safe(), currency: z.string().length(3), evidenceId: idSchema, method: z.enum(['DETERMINISTIC', 'MANUAL', 'AI']) })),
  people: z.array(FieldSchema), organizations: z.array(FieldSchema), emails: z.array(FieldSchema), phones: z.array(FieldSchema), invoiceNumbers: z.array(FieldSchema), orderNumbers: z.array(FieldSchema), transactionIds: z.array(FieldSchema), addresses: z.array(FieldSchema), keywords: z.array(FieldSchema), sourceText: z.string().max(30000), version: z.string(),
});
export const UserProfileSchema = z.object({ ...base, email: z.string().email(), displayName: z.string() });
export const CaseSchema = z.object({ ...base, title: z.string().min(1).max(160), description: z.string().max(4000), status: CaseStatus });
export const ClaimSchema = z.object({ ...scoped, statement: z.string().min(1).max(2000), requiredEventIds: z.array(idSchema) });
export const EventSchema = z.object({ ...scoped, title: z.string().min(1).max(160), description: z.string().max(4000), date: DateValueSchema, claimIds: z.array(idSchema) });
export const EvidenceSchema = z.object({ ...scoped, title: z.string().min(1).max(160), type: EvidenceType, state: ProcessingState, mimeType: z.string(), size: z.number().nonnegative(), storagePath: z.string().nullable(), hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), extraction: ExtractionSchema.nullable(), confirmedExtraction: ExtractionSchema.nullable(), deletedAt: z.number().nullable(), error: z.string().nullable() });
export const EndpointSchema = z.object({ kind: EntityKind, id: idSchema });
export const RelationshipSchema = z.object({ ...scoped, from: EndpointSchema, to: EndpointSchema, type: RelationshipType, origin: z.enum(['USER', 'RULE']), material: z.boolean(), explanation: z.string().max(2000) });
export const AnalysisSchema = z.object({ ...scoped, resultType: AnalysisType, severity: Severity, title: z.string(), explanation: z.string(), supportingEvidenceIds: z.array(idSchema), relatedClaimIds: z.array(idSchema), relatedEventIds: z.array(idSchema), triggeredRuleIds: z.array(z.string()), aiSuggestionIds: z.array(idSchema), inputs: z.record(z.string(), z.string()), confidence: z.enum(['Exact Match', 'Strong Match', 'Suggested Match', 'Needs Review']), status: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']) });
export const ConflictSchema = z.object({ ...scoped, analysisResultId: idSchema, status: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']) });
export const AuditSchema = z.object({ ...scoped, action: AuditAction, entityIds: z.array(idSchema), summary: z.string() });
export const JobSchema = z.object({ ...scoped, evidenceId: idSchema, state: ProcessingState, attempts: z.number().int().nonnegative(), fingerprint: z.string().nullable(), leaseUntil: z.number(), error: z.string().nullable() });
export const AISuggestionSchema = z.object({ ...scoped, evidenceId: idSchema, sourceEvidenceIds: z.array(idSchema), extractionVersion: z.string(), model: z.string(), status: SuggestionStatus, confidence: z.number().min(0).max(1), summary: z.string(), fields: z.array(z.object({ name: z.string(), value: z.string(), sourceQuote: z.string() })) });
export const RuleDefinitionSchema = z.object({ id: z.string(), description: z.string(), condition: z.string(), priority: z.number(), enabled: z.boolean(), actionType: AnalysisType });
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type Case = z.infer<typeof CaseSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Event = z.infer<typeof EventSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceRelationship = z.infer<typeof RelationshipSchema>;
export type AnalysisResult = z.infer<typeof AnalysisSchema>;
export type Conflict = z.infer<typeof ConflictSchema>;
export type AuditLog = z.infer<typeof AuditSchema>;
export type ProcessingJob = z.infer<typeof JobSchema>;
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type AIExtractionSuggestion = z.infer<typeof AISuggestionSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type ClaimState = 'SUPPORTED' | 'CONTRADICTED' | 'UNSUPPORTED' | 'MIXED_REVIEW';
export const schemas = { cases: CaseSchema, claims: ClaimSchema, events: EventSchema, evidence: EvidenceSchema, relationships: RelationshipSchema, analysisResults: AnalysisSchema, conflicts: ConflictSchema, auditLogs: AuditSchema, processingJobs: JobSchema, aiSuggestions: AISuggestionSchema };
export type CollectionName = keyof typeof schemas;
export interface Workspace { cases: Case[]; claims: Claim[]; events: Event[]; evidence: Evidence[]; relationships: EvidenceRelationship[]; analysisResults: AnalysisResult[]; conflicts: Conflict[]; auditLogs: AuditLog[]; processingJobs: ProcessingJob[]; aiSuggestions: AIExtractionSuggestion[] }
export const emptyWorkspace = (): Workspace => ({ cases: [], claims: [], events: [], evidence: [], relationships: [], analysisResults: [], conflicts: [], auditLogs: [], processingJobs: [], aiSuggestions: [] });
export function parseWorkspace(input: unknown): Workspace { return z.object({ cases: z.array(CaseSchema), claims: z.array(ClaimSchema), events: z.array(EventSchema), evidence: z.array(EvidenceSchema), relationships: z.array(RelationshipSchema), analysisResults: z.array(AnalysisSchema), conflicts: z.array(ConflictSchema), auditLogs: z.array(AuditSchema), processingJobs: z.array(JobSchema), aiSuggestions: z.array(AISuggestionSchema) }).parse(input); }
