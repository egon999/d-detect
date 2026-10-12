import { z } from 'zod';

import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from './client';
import { appendUpload, uploadBytes, type UploadFile } from './files';

export type CaseSide = 'mine' | 'theirs';
export type CaseStatus = 'open' | 'resolved';
export type CaseStanding =
  | 'your_account_is_better_supported'
  | 'their_account_is_better_supported'
  | 'evenly_matched'
  | 'not_enough_evidence';
export type CaseConfidence = 'high' | 'medium' | 'low';

export type CaseItemStatus = 'pending' | 'reading' | 'ready' | 'needs_context' | 'unreadable' | 'failed';

const FactsSchema = z.object({

  amounts: z.array(
    z.object({
      raw: z.string(),
      label: z.string(),
      minor: z.number(),
      currency: z.string(),
      role: z.enum(['total', 'line']),
    }),
  ),
  dates: z.array(z.object({ raw: z.string(), at: z.number(), precision: z.enum(['minute', 'day']) })),

  references: z.array(z.object({ value: z.string(), labelled: z.boolean() })),
  statuses: z.array(z.string()),

  partial: z.array(z.enum(['amounts', 'dates', 'references', 'statuses'])).optional(),
});

const SignalSchema = z.object({
  kind: z.string(),
  strength: z.enum(['strong', 'moderate', 'weak']),
  headline: z.string(),
  detail: z.string(),
  itemIds: z.array(z.string()),
});

const CaseItemSchema = z.object({
  id: z.string(),
  side: z.enum(['mine', 'theirs']),
  kind: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'reading', 'ready', 'needs_context', 'unreadable', 'failed']),
  fileId: z.string().nullable(),

  readBy: z.string().nullable(),
  readNote: z.string().nullable(),

  question: z.string().nullable(),
  excerpt: z.string(),

  hasMoreText: z.boolean(),

  fileHadMoreText: z.boolean(),
  facts: FactsSchema,
  createdAt: z.number(),
});

const CaseItemDetailSchema = CaseItemSchema.extend({
  text: z.string(),
  mime: z.string().nullable(),
  fileName: z.string().nullable(),
});

const CitedIds = z.array(z.string()).default([]);

const VerdictSchema = z.object({
  headline: z.string(),

  yourAccount: z.string().default(''),
  theirAccount: z.string().default(''),
  standing: z.enum([
    'your_account_is_better_supported',
    'their_account_is_better_supported',
    'evenly_matched',
    'not_enough_evidence',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  evidence: z
    .array(z.object({ itemId: z.string(), strength: z.enum(['strong', 'moderate', 'weak']), reason: z.string() }))
    .default([]),
  conflicts: z
    .array(
      z.object({
        point: z.string(),

        about: z.enum(['amount', 'date', 'reference', 'status', 'what_happened']).default('what_happened'),
        yourSide: z.string().default(''),

        yourValue: z.string().default(''),
        yourSources: CitedIds,
        theirSide: z.string().default(''),
        theirValue: z.string().default(''),
        theirSources: CitedIds,
        reading: z.string(),
      }),
    )
    .default([]),
  supported: z.array(z.object({ point: z.string(), sources: CitedIds })).default([]),
  notSupported: z.array(z.object({ point: z.string(), sources: CitedIds })).default([]),

  missing: z.array(z.object({ point: z.string(), wouldShow: z.string().default('') })).default([]),
  nextStep: z.string(),
});

const CoverageSchema = z.object({
  complete: z.boolean(),
  itemsInCase: z.number(),
  itemsAnalysed: z.number(),

  omitted: z.array(z.string()),

  shortened: z.array(z.string()),

  partlySaved: z.array(z.string()).default([]),

  notWeighed: z.array(z.string()),
  note: z.string().nullable(),
});

const SourceRefSchema = z.object({
  id: z.string(),
  label: z.string(),
  side: z.enum(['mine', 'theirs']),
  kind: z.enum(['file', 'statement', 'account']),
});

const CaseAnalysisSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  verdict: VerdictSchema,
  signals: z.array(SignalSchema),
  itemCount: z.number(),
  coverage: CoverageSchema.nullish().default(null),

  sources: z.array(SourceRefSchema).default([]),
});

const CaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  question: z.string(),
  myClaim: z.string(),
  theirClaim: z.string(),
  status: z.enum(['open', 'resolved']),
  counts: z.object({ mine: z.number(), theirs: z.number(), pending: z.number() }),
  hasAnalysis: z.boolean(),

  analysisStale: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const CaseDetailSchema = CaseSummarySchema.extend({
  items: z.array(CaseItemSchema),

  signals: z.array(SignalSchema),

  sources: z.array(SourceRefSchema).default([]),

  analysis: CaseAnalysisSchema.nullable().catch(null),
});

const CaseReportSchema = z.object({
  title: z.string(),
  question: z.string(),
  myClaim: z.string(),
  theirClaim: z.string(),
  preparedAt: z.number(),
  items: z.array(CaseItemSchema.extend({ text: z.string() })),
  signals: z.array(SignalSchema),
  analysis: VerdictSchema.nullable(),

  sources: z.array(SourceRefSchema).default([]),
  standingText: z.string().nullable(),

  confidenceText: z.string().nullable(),
  coverage: CoverageSchema.nullable(),
  text: z.string(),
});

export type Facts = z.infer<typeof FactsSchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type SignalStrength = Signal['strength'];
export type CaseItem = z.infer<typeof CaseItemSchema>;
export type CaseItemDetail = z.infer<typeof CaseItemDetailSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type VerdictConflict = Verdict['conflicts'][number];
export type VerdictFinding = Verdict['evidence'][number];
export type VerdictPoint = Verdict['supported'][number];
export type VerdictGap = Verdict['missing'][number];
export type Coverage = z.infer<typeof CoverageSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type CaseAnalysis = z.infer<typeof CaseAnalysisSchema>;
export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CaseDetail = z.infer<typeof CaseDetailSchema>;
export type CaseReport = z.infer<typeof CaseReportSchema>;

const CaseListResponse = z.object({ cases: z.array(CaseSummarySchema) });
const CaseResponse = z.object({ case: CaseDetailSchema });
const FromRecordResponse = z.object({ case: CaseDetailSchema, existing: z.boolean().default(false) });
const ItemResponse = z.object({ item: CaseItemSchema });
const UploadResponse = z.object({ item: CaseItemSchema, duplicate: z.boolean().default(false) });
const ItemDetailResponse = z.object({ item: CaseItemDetailSchema });
const ItemPatchResponse = z.object({ item: CaseItemSchema, analysisCleared: z.boolean().default(false) });
const AnalyzeResponse = z.object({ analysis: CaseAnalysisSchema.nullable(), reused: z.boolean() });
const ClearedResponse = z.object({ cleared: z.boolean(), case: CaseDetailSchema });
const ReportResponse = z.object({ report: CaseReportSchema });
const DeletedResponse = z.object({ deleted: z.literal(true) });

export type NewCaseInput = { title: string; question?: string; myClaim?: string; theirClaim?: string };
export type CasePatch = Partial<{
  title: string;
  question: string;
  myClaim: string;
  theirClaim: string;
  status: CaseStatus;
}>;

export type CaseItemPatch = { label?: string; side?: CaseSide };

export async function listCases(): Promise<CaseSummary[]> {
  return CaseListResponse.parse(await apiGet<unknown>('/api/cases')).cases;
}

export async function getCase(id: string): Promise<CaseDetail> {
  return CaseResponse.parse(await apiGet<unknown>(`/api/cases/${encodeURIComponent(id)}`)).case;
}

export async function createCase(input: NewCaseInput): Promise<CaseDetail> {
  return CaseResponse.parse(await apiPost<unknown>('/api/cases', input)).case;
}

export async function createCaseFromRecord(recordId: string): Promise<{ case: CaseDetail; existing: boolean }> {
  const data = FromRecordResponse.parse(
    await apiPost<unknown>(`/api/cases/from-record/${encodeURIComponent(recordId)}`, {}),
  );
  return { case: data.case, existing: data.existing };
}

export async function updateCase(id: string, patch: CasePatch): Promise<CaseDetail> {
  return CaseResponse.parse(await apiPatch<unknown>(`/api/cases/${encodeURIComponent(id)}`, patch)).case;
}

export async function deleteCase(id: string): Promise<{ deleted: true }> {
  return DeletedResponse.parse(await apiDelete<unknown>(`/api/cases/${encodeURIComponent(id)}`));
}

export async function addCaseFile(
  id: string,
  file: UploadFile,
  options: { side: CaseSide; label?: string },
): Promise<{ item: CaseItem; duplicate: boolean }> {
  const form = new FormData();
  appendUpload(form, 'file', file);
  form.append('side', options.side);
  if (options.label) form.append('label', options.label);
  return UploadResponse.parse(
    await apiUpload<unknown>(`/api/cases/${encodeURIComponent(id)}/items`, form, undefined, uploadBytes(file)),
  );
}

export async function addCaseStatement(
  id: string,
  input: { side: CaseSide; label: string; text: string },
): Promise<CaseItem> {
  return ItemResponse.parse(await apiPost<unknown>(`/api/cases/${encodeURIComponent(id)}/items`, input)).item;
}

export async function deleteCaseItem(id: string, itemId: string): Promise<{ deleted: true }> {
  return DeletedResponse.parse(
    await apiDelete<unknown>(`/api/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`),
  );
}

export async function updateCaseItem(
  id: string,
  itemId: string,
  patch: CaseItemPatch,
): Promise<{ item: CaseItem; analysisCleared: boolean }> {
  const data = await apiPatch<unknown>(
    `/api/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
    patch,
  );
  return ItemPatchResponse.parse(data);
}

export async function getCaseItem(id: string, itemId: string, signal?: AbortSignal): Promise<CaseItemDetail> {
  const data = await apiGet<unknown>(
    `/api/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
    undefined,
    signal,
  );
  return ItemDetailResponse.parse(data).item;
}

export async function retryCaseItem(id: string, itemId: string): Promise<CaseItem> {
  const data = await apiPost<unknown>(
    `/api/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/retry`,
  );
  return ItemResponse.parse(data).item;
}

export async function describeCaseItem(id: string, itemId: string, text: string): Promise<CaseItem> {
  const data = await apiPost<unknown>(
    `/api/cases/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/describe`,
    { text },
  );
  return ItemResponse.parse(data).item;
}

export async function analyzeCase(
  id: string,
  force = false,
): Promise<{ analysis: CaseAnalysis | null; reused: boolean }> {
  const data = await apiPost<unknown>(
    `/api/cases/${encodeURIComponent(id)}/analyze`,
    undefined,
    force ? { force: 1 } : undefined,
  );
  return AnalyzeResponse.parse(data);
}

export async function clearCaseAnalysis(id: string): Promise<{ cleared: boolean; case: CaseDetail }> {
  const data = await apiDelete<unknown>(`/api/cases/${encodeURIComponent(id)}/analysis`);
  return ClearedResponse.parse(data);
}

export async function getCaseReport(id: string): Promise<CaseReport> {
  return ReportResponse.parse(await apiGet<unknown>(`/api/cases/${encodeURIComponent(id)}/report`)).report;
}
