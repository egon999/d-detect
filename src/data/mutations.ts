import { evaluateCaseClaims } from '../domain/analysis/claim-state';
import type { AuditAction, CaseStatus, EvidenceKind, RelationshipType } from '../domain/enums';
import { CASE_STATUS_LABELS } from '../domain/enums';
import { extractFromText, type ExtractedTextMethod } from '../domain/extraction/deterministic';
import { rekeyConfirmedFields } from '../domain/extraction/rekey';
import { hashText } from '../domain/hashing';
import { newId } from '../domain/ids';
import { evidenceSchema } from '../domain/models';
import type {
  AIExtractionSuggestion,
  AnalysisResult,
  AuditLog,
  Case,
  CaseEvent,
  Claim,
  DateField,
  EntityRef,
  Evidence,
  EvidenceRelationship,
  Extraction,
  Workspace,
} from '../domain/models';
import { normalizeDate } from '../domain/normalize/dates';
import { runAnalysis } from '../domain/rules/engine';
import type { AnalysisRunResult } from '../domain/rules/types';
import { applyChanges, put, type Change } from './repository';

/**
 * Case mutations.
 *
 * Every write in the application is produced here, as a **pure function**: it takes the
 * current workspace and returns the next one together with the list of changes to
 * persist. Nothing in this file touches Firebase, AsyncStorage, React or the clock.
 *
 * Three things fall out of that:
 *
 * - the same code path produces the optimistic UI update and the persisted record, so
 *   they cannot disagree;
 * - the entire write side is unit testable without an emulator; and
 * - the audit trail is written beside the change that caused it, not bolted on by a
 *   caller who might forget.
 */

export interface MutationContext {
  ownerId: string;
  /** Injected so a run is reproducible and so one user action carries one timestamp. */
  now: number;
  /** Injected so tests get stable ids. Defaults to the random generator. */
  nextId?: (prefix: string) => string;
}

export interface Mutation {
  workspace: Workspace;
  changes: Change[];
}

/**
 * Provenance placeholder for a value a person typed rather than one read out of a
 * document. `DateField` requires a source, and claiming a user-entered date came from
 * some evidence item would corrupt the provenance chain that the whole reasoning
 * model depends on.
 */
export const MANUAL_ENTRY_SOURCE = 'manual_entry';

const idFor = (context: MutationContext, prefix: string): string =>
  context.nextId ? context.nextId(prefix) : newId(prefix);

function commit(workspace: Workspace, changes: Change[]): Mutation {
  return { workspace: applyChanges(workspace, changes), changes };
}

function auditEntry(
  context: MutationContext,
  caseId: string,
  action: AuditAction,
  summary: string,
  entityRefs: EntityRef[] = [],
  metadata: Record<string, string> = {},
): AuditLog {
  return {
    id: idFor(context, 'aud'),
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    action,
    actorId: context.ownerId,
    entityRefs,
    // Summaries name records; they never quote document contents. Audit logs are the
    // one collection a user reads in bulk, and leaking evidence text into them would
    // defeat keeping the raw files in protected storage.
    summary: summary.slice(0, 400),
    metadata,
  };
}

/** Trims a title for use inside an audit summary without breaking the length budget. */
const short = (text: string, limit = 60): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

function requireRecord<T>(record: T | undefined, kind: string, id: string): T {
  if (!record) throw new Error(`${kind} ${id} is not in this workspace`);
  return record;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CaseInput {
  title: string;
  description?: string;
  category?: string;
  status?: CaseStatus;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  participants?: Case['participants'];
  tags?: string[];
  incidentDate?: string | null;
}

export function createCase(workspace: Workspace, context: MutationContext, input: CaseInput): Mutation {
  const cleanedParticipants = (input.participants ?? [])
    .filter((p) => p.name && p.name.trim().length > 0)
    .map((p, idx) => ({
      id: p.id && p.id.trim() ? p.id.trim() : idFor(context, `part_${idx + 1}`),
      name: p.name.trim(),
      role: p.role?.trim() || 'Involved Party',
      ...(p.contact?.trim() ? { contact: p.contact.trim() } : {}),
    }));

  const rawTags = input.tags ?? [];
  const cleanedTags = Array.from(
    new Set(rawTags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
  );

  const record: Case = {
    id: idFor(context, 'case'),
    ownerId: context.ownerId,
    createdAt: context.now,
    updatedAt: context.now,
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    status: input.status ?? 'OPEN',
    category: input.category?.trim() ?? '',
    priority: input.priority ?? 'NORMAL',
    participants: cleanedParticipants,
    tags: cleanedTags,
    incidentDate: input.incidentDate ? input.incidentDate.trim() : null,
    lastAnalyzedAt: null,
    deletedAt: null,
  };

  return commit(workspace, [
    put('cases', record),
    put(
      'auditLogs',
      auditEntry(context, record.id, 'CASE_CREATED', `Created case "${short(record.title)}"`),
    ),
  ]);
}

export function updateCase(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  patch: Partial<CaseInput>,
): Mutation {
  const existing = requireRecord(workspace.cases.find((item) => item.id === caseId), 'Case', caseId);
  const next: Case = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.category !== undefined ? { category: patch.category.trim() } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.participants !== undefined ? { participants: patch.participants } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.incidentDate !== undefined ? { incidentDate: patch.incidentDate } : {}),
    updatedAt: context.now,
  };

  // A status change is audited distinctly: it is the transition an examiner or a
  // counterparty is most likely to ask about.
  const statusChanged = patch.status !== undefined && patch.status !== existing.status;
  const audit = statusChanged
    ? auditEntry(
        context,
        caseId,
        'CASE_STATUS_CHANGED',
        `Case status changed from ${CASE_STATUS_LABELS[existing.status]} to ${CASE_STATUS_LABELS[next.status]}`,
        [],
        { from: existing.status, to: next.status },
      )
    : auditEntry(context, caseId, 'CASE_UPDATED', `Updated case "${short(next.title)}"`);

  return commit(workspace, [put('cases', next), put('auditLogs', audit)]);
}

/**
 * Soft-deletes a case. The records stay so the audit history remains meaningful and
 * so a mistaken deletion is recoverable; every read path filters on `deletedAt`.
 */
export function deleteCase(workspace: Workspace, context: MutationContext, caseId: string): Mutation {
  const existing = requireRecord(workspace.cases.find((item) => item.id === caseId), 'Case', caseId);
  return commit(workspace, [
    put('cases', { ...existing, deletedAt: context.now, updatedAt: context.now }),
    put('auditLogs', auditEntry(context, caseId, 'CASE_UPDATED', `Deleted case "${short(existing.title)}"`)),
  ]);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface ClaimInput {
  statement: string;
  detail?: string;
  requiredEventIds?: string[];
}

export function createClaim(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: ClaimInput,
): Mutation {
  const record: Claim = {
    id: idFor(context, 'clm'),
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    statement: input.statement.trim(),
    detail: input.detail?.trim() ?? '',
    requiredEventIds: input.requiredEventIds ?? [],
    // A new claim has nothing linked to it yet. That is a statement about the evidence,
    // not about whether the claim is true.
    state: 'UNSUPPORTED',
    deletedAt: null,
  };

  return commit(workspace, [
    put('claims', record),
    put(
      'auditLogs',
      auditEntry(context, caseId, 'CLAIM_CREATED', `Added claim "${short(record.statement)}"`, [
        { kind: 'claim', id: record.id },
      ]),
    ),
  ]);
}

export function updateClaim(
  workspace: Workspace,
  context: MutationContext,
  claimId: string,
  patch: Partial<ClaimInput>,
): Mutation {
  const existing = requireRecord(workspace.claims.find((item) => item.id === claimId), 'Claim', claimId);
  const next: Claim = {
    ...existing,
    ...(patch.statement !== undefined ? { statement: patch.statement.trim() } : {}),
    ...(patch.detail !== undefined ? { detail: patch.detail.trim() } : {}),
    ...(patch.requiredEventIds !== undefined ? { requiredEventIds: patch.requiredEventIds } : {}),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('claims', next),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'CLAIM_UPDATED', `Edited claim "${short(next.statement)}"`, [
        { kind: 'claim', id: claimId },
      ]),
    ),
  ]);
}

export function deleteClaim(workspace: Workspace, context: MutationContext, claimId: string): Mutation {
  const existing = requireRecord(workspace.claims.find((item) => item.id === claimId), 'Claim', claimId);
  return commit(workspace, [
    put('claims', { ...existing, deletedAt: context.now, updatedAt: context.now }),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'CLAIM_DELETED', `Removed claim "${short(existing.statement)}"`, [
        { kind: 'claim', id: claimId },
      ]),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventInput {
  title: string;
  description?: string;
  /** Free text as the user typed it. Normalized here, with the original preserved. */
  occurredAt?: string | null;
  claimIds?: string[];
}

/**
 * Builds the provenance-carrying date for a user-entered event.
 *
 * The typed text is kept verbatim alongside the parsed value, so an unparseable or
 * ambiguous entry is visible in the UI rather than silently dropped or silently
 * resolved to one reading.
 */
function manualDate(text: string): DateField {
  const normalized = normalizeDate(text);
  return {
    ...normalized,
    evidenceId: MANUAL_ENTRY_SOURCE,
    method: 'MANUAL',
  };
}

export function createEvent(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: EventInput,
): Mutation {
  const record: CaseEvent = {
    id: idFor(context, 'evt'),
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    title: input.title.trim(),
    description: input.description?.trim() ?? '',
    occurredAt: input.occurredAt ? manualDate(input.occurredAt) : null,
    claimIds: input.claimIds ?? [],
    deletedAt: null,
  };

  return commit(workspace, [
    put('events', record),
    put(
      'auditLogs',
      auditEntry(context, caseId, 'EVENT_CREATED', `Added event "${short(record.title)}"`, [
        { kind: 'event', id: record.id },
      ]),
    ),
  ]);
}

export function updateEvent(
  workspace: Workspace,
  context: MutationContext,
  eventId: string,
  patch: Partial<EventInput>,
): Mutation {
  const existing = requireRecord(workspace.events.find((item) => item.id === eventId), 'Event', eventId);
  const next: CaseEvent = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.occurredAt !== undefined
      ? { occurredAt: patch.occurredAt ? manualDate(patch.occurredAt) : null }
      : {}),
    ...(patch.claimIds !== undefined ? { claimIds: patch.claimIds } : {}),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('events', next),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'EVENT_UPDATED', `Edited event "${short(next.title)}"`, [
        { kind: 'event', id: eventId },
      ]),
    ),
  ]);
}

export function deleteEvent(workspace: Workspace, context: MutationContext, eventId: string): Mutation {
  const existing = requireRecord(workspace.events.find((item) => item.id === eventId), 'Event', eventId);
  return commit(workspace, [
    put('events', { ...existing, deletedAt: context.now, updatedAt: context.now }),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'EVENT_DELETED', `Removed event "${short(existing.title)}"`, [
        { kind: 'event', id: eventId },
      ]),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Text pulled out of a file, carried together with the account of how it was pulled out.
 *
 * Two very different things both arrive here as a `string`: the character data a PDF
 * already contained, and a model's best guess at what some pixels spell. The first is
 * exact; the second can turn ₹1,500 into ₹7,500. Binding the two fields into one object
 * makes it impossible to pass the text on while dropping that distinction.
 */
export interface RecoveredText {
  value: string;
  method: ExtractedTextMethod;
}

export interface NoteInput {
  title: string;
  text: string;
}

/**
 * Adds a typed note as evidence.
 *
 * A note has no file, so it gets no hash: it can never be an *exact* duplicate of
 * anything, only a semantically related one. The same deterministic extractor that
 * reads uploaded documents reads the note text, so a note participates in every rule.
 */
export function createNote(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: NoteInput,
): Mutation {
  const id = idFor(context, 'evd');
  const title = input.title.trim();
  const text = input.text.trim();

  const record: Evidence = {
    id,
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    title,
    kind: 'NOTE',
    // Typed text needs no upload or OCR, so it arrives already extracted.
    state: 'EXTRACTED',
    note: text,
    fileName: null,
    mimeType: null,
    sizeBytes: new TextEncoder().encode(text).length,
    storagePath: null,
    sha256: null,
    // DETERMINISTIC, not MANUAL, and the distinction matters.
    //
    // The *characters* are exactly what the person typed — nothing guessed at them, so
    // this is the top of the machine-read hierarchy and nothing here needs confirming.
    // But the *fields* below are still regex matches over that text: the extractor
    // decided that "15/03" is a date and that it plays the "due" role. The person never
    // said either of those things. `MANUAL` means a human vouched for a specific field
    // (see `confirmEvidenceFields`), and stamping it here would silently mark every
    // pattern-match as human-verified, making a parsing mistake unchallengeable.
    extraction: extractFromText({ evidenceId: id, title, text, method: 'DETERMINISTIC' }),
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    deletedAt: null,
  };

  return commit(workspace, [
    put('evidence', record),
    put(
      'auditLogs',
      auditEntry(context, caseId, 'EVIDENCE_UPLOADED', `Added note "${short(title)}"`, [
        { kind: 'evidence', id },
      ], { kind: 'NOTE' }),
    ),
  ]);
}

export interface FileEvidenceInput {
  title: string;
  kind: EvidenceKind;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  /** Where the file now lives in the storage provider. Never a public URL. */
  storagePath: string;
  /** Hex SHA-256 of the bytes. Required: duplicate detection has no other basis. */
  sha256: string;
  /**
   * Text recovered from the file, if any was recoverable at upload time — **inseparable
   * from how it was recovered**.
   *
   * The value and its provenance travel together as one object on purpose. When this was
   * a bare `text?: string` the method was left to a default, so text recognised from
   * pixels was recorded as having been read from the document itself. A caller cannot
   * now supply the text without answering where it came from.
   */
  text?: RecoveredText;
}

/**
 * Creates the intake record for a source, before anything is read.
 *
 * For a file this is the first half of a commit-first flow: the record exists (state
 * UPLOADING, no path, no digest) while its bytes are being written to the store, so an
 * interrupted upload leaves an honest row the evidence screen tells the user about
 * rather than orphaned bytes nothing points at. `recordEvidenceFile` completes the
 * record once the bytes are safely stored, and `requestEvidenceProcessing` — on this
 * device, there is no worker — does the reading.
 *
 * Notes reach this only from records written by older builds; new statements go through
 * `createNote`, which is complete in one commit.
 */
export function queueEvidence(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: {
    id: string; title: string; kind: EvidenceKind; note?: string;
    fileName?: string; mimeType?: string; sizeBytes?: number | null;
    storagePath?: string; sourceLabel?: string; capturedAt?: string;
  },
): Mutation {
  requireRecord(workspace.cases.find((item) => item.id === caseId && item.ownerId === context.ownerId && !item.deletedAt), 'Case', caseId);
  const record = evidenceSchema.parse({
    id: input.id, ownerId: context.ownerId, caseId,
    createdAt: context.now, updatedAt: context.now,
    title: input.title.trim(), kind: input.kind,
    state: input.kind === 'NOTE' ? 'QUEUED' : 'UPLOADING',
    note: input.note ?? '', fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null, sizeBytes: input.sizeBytes ?? null,
    storagePath: input.storagePath ?? null,
    sourceLabel: input.sourceLabel?.trim(), capturedAt: input.capturedAt?.trim(),
  });
  return commit(workspace, [
    put('evidence', record),
    put('auditLogs', auditEntry(context, caseId, 'EVIDENCE_UPLOADED', `Added ${input.kind === 'NOTE' ? 'statement' : 'file'} "${short(record.title)}"`, [{ kind: 'evidence', id: record.id }])),
  ]);
}

/**
 * Records an uploaded file as evidence.
 *
 * Called after the bytes are safely in storage, so an interrupted upload leaves no
 * evidence record pointing at a file that does not exist. If text was recovered the
 * item is EXTRACTED; if not it is REVIEW_REQUIRED, which is an honest state — a
 * scanned image with no OCR result needs a person, and pretending otherwise would put
 * an empty extraction into the reasoning engine.
 */
export function createFileEvidence(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: FileEvidenceInput,
): Mutation {
  const id = idFor(context, 'evd');
  const title = input.title.trim();
  const text = input.text?.value.trim() ?? '';
  // Falls back to OCR rather than DETERMINISTIC when text arrives with no stated method.
  // The type makes that unreachable today; if a future caller ever routes around it, the
  // safe failure is to under-claim provenance, never to over-claim it.
  const method = input.text?.method ?? 'OCR';

  const record: Evidence = {
    id,
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    title,
    kind: input.kind,
    state: text ? 'EXTRACTED' : 'REVIEW_REQUIRED',
    note: '',
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storagePath: input.storagePath,
    sha256: input.sha256,
    extraction: text ? extractFromText({ evidenceId: id, title, text, method }) : null,
    confirmedFields: {},
    confirmedAt: null,
    failureReason: text ? null : 'No text could be read from this file automatically.',
    deletedAt: null,
  };

  const changes: Change[] = [
    put('evidence', record),
    put(
      'auditLogs',
      auditEntry(context, caseId, 'EVIDENCE_UPLOADED', `Uploaded "${short(title)}"`, [
        { kind: 'evidence', id },
      ], { kind: input.kind, sizeBytes: String(input.sizeBytes) }),
    ),
  ];

  return commit(workspace, changes);
}

export interface StoredFileInput {
  /** Logical key from the storage layer. Never a public URL. */
  storagePath: string;
  /** Byte count of what was actually written, not what the picker claimed. */
  sizeBytes: number;
  /** Hex SHA-256 of the stored bytes. Required: duplicate detection has no other basis. */
  sha256: string;
  cloudUrl?: string | null;
  cloudPublicId?: string | null;
  cloudStatus?: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY';
}

/**
 * Records a stored original on an evidence item created by `queueEvidence`.
 *
 * Called only after `uploadEvidenceFile` has succeeded, which is what makes the fields
 * this writes a promise the record can keep: a record carrying a `storagePath` always
 * has its bytes, and `sha256` was computed over exactly those bytes by the same call.
 * The crash window this leaves — bytes written, record not yet completed — shows up as
 * an UPLOADING row with no path, which the evidence screen reports as an incomplete
 * upload and which a retry converges (the same id re-stores to the same path).
 */
export function recordEvidenceFile(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  input: StoredFileInput,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );

  // Both guards exist for the same reason: the digest and the path identify one set of
  // bytes for the lifetime of the record. Duplicate detection and the audit chain rest
  // on the hash never changing meaning, and the viewer resolves the path — a record
  // whose original silently became a different file is evidence tampering by bug.
  if (existing.sha256 !== null && existing.sha256 !== input.sha256) {
    throw new Error(
      `Refusing to re-file "${existing.title}": its stored original was recorded as ${existing.sha256}, ` +
        `and this file is ${input.sha256}. Remove the old source and add the new file separately.`,
    );
  }
  if (existing.storagePath !== null && existing.storagePath !== input.storagePath) {
    throw new Error(`Refusing to re-file "${existing.title}": it already points at a different stored original.`);
  }

  const next: Evidence = {
    ...existing,
    storagePath: input.storagePath,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    cloudUrl: input.cloudUrl ?? existing.cloudUrl ?? null,
    cloudPublicId: input.cloudPublicId ?? existing.cloudPublicId ?? null,
    cloudStatus: input.cloudStatus ?? existing.cloudStatus ?? 'LOCAL_ONLY',
    cloudSyncedAt: input.cloudStatus === 'SYNCED' ? context.now : (existing.cloudSyncedAt ?? null),
    // UPLOADING says "the bytes are on their way". Once they are safely stored the item
    // is queued for reading.
    //
    // A `FAILED` row with no path is the same situation wearing a different label: the
    // upload was abandoned and `failEvidenceUpload` said so, and the bytes have now
    // arrived after all. Leaving it `FAILED` would keep a record that has its original
    // marked unreadable, with no way back — which is the dead end this whole edge exists
    // to avoid. Any other state — a retry after processing already ran — is left exactly
    // as it was.
    ...(existing.state === 'UPLOADING' || (existing.state === 'FAILED' && existing.storagePath === null)
      ? { state: 'QUEUED' as const, failureReason: null }
      : { state: existing.state }),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_UPLOADED',
        `Stored the original of "${short(existing.title)}"`,
        [{ kind: 'evidence', id: evidenceId }],
        { kind: existing.kind, sizeBytes: String(input.sizeBytes) },
      ),
    ),
  ]);
}

/**
 * Updates cloud mirror synchronization state and remote asset locator on an evidence record.
 */
export function updateEvidenceCloudSync(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  sync: {
    cloudUrl?: string | null;
    cloudPublicId?: string | null;
    cloudStatus: 'SYNCED' | 'PENDING' | 'FAILED' | 'LOCAL_ONLY';
  },
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );
  const next: Evidence = {
    ...existing,
    cloudUrl: sync.cloudUrl ?? existing.cloudUrl ?? null,
    cloudPublicId: sync.cloudPublicId ?? existing.cloudPublicId ?? null,
    cloudStatus: sync.cloudStatus,
    cloudSyncedAt: sync.cloudStatus === 'SYNCED' ? context.now : (existing.cloudSyncedAt ?? null),
    updatedAt: context.now,
  };
  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_CLOUD_SYNCED',
        `Updated cloud backup status for "${short(existing.title)}" to ${sync.cloudStatus}`,
        [{ kind: 'evidence', id: evidenceId }],
        { cloudStatus: sync.cloudStatus, cloudUrl: sync.cloudUrl ?? '' },
      ),
    ),
  ]);
}

/** What the user is told about an upload that did not survive a restart. */
export const INTERRUPTED_UPLOAD_REASON =
  'The app closed before this file finished uploading, so no original was saved. Add the file again to read it.';

/**
 * Records that an upload never finished, so the row stops claiming that it is still running.
 *
 * ## The dead end this closes
 *
 * `queueEvidence` commits an `UPLOADING` row before the bytes exist, which is right — the
 * user can see the file they picked, and a crash leaves a record of the attempt rather than
 * nothing. `recordEvidenceFile` is the only edge out of `UPLOADING`, and it requires the
 * bytes to have landed. So a cancelled, crashed or failed upload left a row that:
 *
 * - showed a spinner, because `isProcessingInFlight` reads `UPLOADING` as work in progress,
 *   and there is no background worker, so that work was running nowhere;
 * - could not be retried, because the Process button is disabled while `storagePath` is null;
 * - was invisible to the worklist, which deliberately skips in-flight states;
 * - and could not be replaced, because re-picking the file on the upload screen mints a new
 *   `evd_*` id, so the original stayed in the case forever.
 *
 * `FAILED` is the state the enum documents for exactly this: "a recoverable side state, not a
 * terminal error". It carries a reason, it appears in the worklist, and the record can be
 * removed or re-supplied.
 *
 * Refuses when the bytes did land. A row with a `storagePath` has its original and is not an
 * upload failure — it is an unprocessed document, and calling it failed would tell the user
 * their file was lost when it is sitting on the device.
 */
export function failEvidenceUpload(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  reason: string,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );

  if (existing.storagePath !== null) {
    throw new Error(
      `Refusing to mark "${existing.title}" as a failed upload: its original is already stored. ` +
        `Process it instead.`,
    );
  }

  const next: Evidence = {
    ...existing,
    state: 'FAILED',
    // Bounded like every other stored reason, and phrased for the person who will read it
    // on the evidence card rather than for a log.
    failureReason: reason.slice(0, 400),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_PROCESSED',
        `Upload of "${short(existing.title)}" did not complete`,
        [{ kind: 'evidence', id: evidenceId }],
        { kind: existing.kind },
      ),
    ),
  ]);
}

/**
 * Marks an evidence item whose original file is stored but whose extraction processing
 * failed or was interrupted as FAILED.
 */
export function failEvidenceProcessing(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  reason: string,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );

  const next: Evidence = {
    ...existing,
    state: 'FAILED',
    failureReason: reason.slice(0, 400),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_PROCESSED',
        `Processing of "${short(existing.title)}" did not complete`,
        [{ kind: 'evidence', id: evidenceId }],
        { kind: existing.kind },
      ),
    ),
  ]);
}

/**
 * Moves records that claim to be mid-flight but are not.
 *
 * ## Why this is needed at all
 *
 * Nothing in this app processes evidence in the background. `requestEvidenceProcessing` runs
 * inline, in the screen that started it, in that screen's event loop. So the moment the
 * process is gone — killed, crashed, backgrounded out — any row still claiming to be running
 * is describing work that will never resume, and nothing anywhere noticed. A user reopening
 * the app saw a spinner that would spin until they deleted the case.
 *
 * ## What it does, and what it deliberately does not
 *
 * - `UPLOADING` with no stored original → `FAILED`. The bytes never arrived and now never
 *   will; see {@link failEvidenceUpload}. This is the common case: it is the state
 *   `queueEvidence` writes, and the only edge out of it needs the bytes to have landed.
 * - `PROCESSING` → `QUEUED`. The original is present, the reading is not, and `QUEUED` is
 *   the state that says so. This also un-sticks the Process button, which treats `PROCESSING`
 *   as "already running" and disables itself with no timeout — the one state that could
 *   permanently lock a record out of being read.
 *
 *   Defensive rather than routine: `case-analysis.ts` deliberately never persists
 *   `PROCESSING` for exactly this reason, so in a device-only build this branch fires only
 *   for records written by the `functions/` server path or by an older build. It stays
 *   because a state that cannot be recovered from is worse than a branch that rarely runs.
 * - `QUEUED` is left alone, and this is where an interrupted extraction actually lands. Its
 *   bytes are stored and its record is honest: it is a document waiting to be read, which is
 *   what `QUEUED` means, and the Process button already works on it. Rewriting it to `FAILED`
 *   would report a failure that did not happen. Making it *findable* is `attention.ts`'s job,
 *   not this one's.
 *
 * Returns `null` when there is nothing to move, so a caller can skip the commit entirely
 * rather than writing an empty batch and an audit entry about nothing.
 *
 * Call this once per process, on a cold start, before the user can act. Calling it while an
 * upload is genuinely in flight in this same process would abort that upload's row — the
 * check this makes is "is the work running", and it answers by knowing that nothing survives
 * a restart, not by looking at a clock.
 */
export function reconcileInterruptedEvidence(
  workspace: Workspace,
  context: MutationContext,
): Mutation | null {
  const stranded = workspace.evidence.filter(
    (item) =>
      !item.deletedAt &&
      ((item.state === 'UPLOADING' && item.storagePath === null) || item.state === 'PROCESSING'),
  );
  if (stranded.length === 0) return null;

  const changes: Change[] = [];
  const affectedCases = new Set<string>();

  for (const item of stranded) {
    affectedCases.add(item.caseId);
    changes.push(
      put('evidence', {
        ...item,
        ...(item.state === 'PROCESSING'
          ? { state: 'QUEUED' as const }
          : { state: 'FAILED' as const, failureReason: INTERRUPTED_UPLOAD_REASON }),
        updatedAt: context.now,
      }),
    );
  }

  // One entry per case, not per record: the event is "the app was interrupted", and a
  // launch that recovered eleven rows should not push eleven near-identical lines into the
  // one collection the user reads in bulk.
  for (const caseId of affectedCases) {
    const count = stranded.filter((item) => item.caseId === caseId).length;
    changes.push(
      put(
        'auditLogs',
        auditEntry(
          context,
          caseId,
          'EVIDENCE_PROCESSED',
          count === 1
            ? 'One item was interrupted before it finished and has been reset'
            : `${count} items were interrupted before they finished and have been reset`,
          stranded.filter((item) => item.caseId === caseId).map((item) => ({ kind: 'evidence' as const, id: item.id })),
          { reason: 'interrupted' },
        ),
      ),
    );
  }

  return commit(workspace, changes);
}

export interface ExtractionOutcomeInput {
  /** The machine extraction, or null when nothing could be read. */
  extraction: Extraction | null;
  /** The state the item lands in after this attempt. */
  state: 'EXTRACTED' | 'REVIEW_REQUIRED' | 'FAILED';
  /**
   * Why the item was not extracted. Required for REVIEW_REQUIRED and FAILED: a reason is
   * the only thing that makes those states actionable rather than a dead end.
   */
  failureReason: string | null;
  /** Digest of the bytes that were read; recorded when the stored record has none. */
  sha256?: string;
  /** Byte count of the stored original; recorded when the stored record has none. */
  sizeBytes?: number;
}

/**
 * Persists the result of processing one evidence item on this device.
 *
 * The caller (`requestEvidenceProcessing`) decides what happened; this mutation decides
 * what may be written about it. Four rules are enforced here rather than trusted
 * upstream, because each one is an invariant a later reader depends on:
 *
 * - A non-extracted state carries a reason, and an extracted state carries an extraction
 *   with passages. A REVIEW_REQUIRED with nothing to review, or an EXTRACTED with no
 *   extraction, is a record that lies about itself.
 * - The recorded digest never changes once set (see `recordEvidenceFile` for why).
 * - `confirmedAt` is never touched, and neither is the CONFIRMED state: a person's
 *   corrections layer over the extraction at read time (`effectiveExtraction`) and must
 *   survive every reprocess, because they still apply to the fresh extraction.
 * - No correction is dropped, and none is left pointing at a value it was not made for.
 *   Every value in `confirmedFields` survives; its *key* is re-derived against the new
 *   extraction, because a key is a position in the old one. `rekeyConfirmedFields` carries
 *   the reasoning, and the audit entry below reports what moved.
 */
export function persistEvidenceExtraction(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  input: ExtractionOutcomeInput,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId && !item.deletedAt),
    'Evidence',
    evidenceId,
  );

  const reason = input.failureReason?.trim() ?? null;
  if (input.state !== 'EXTRACTED' && !reason) {
    throw new Error(`A ${input.state} evidence item must say why it could not be read.`);
  }
  if (input.state === 'EXTRACTED' && (!input.extraction || input.extraction.segments.length === 0)) {
    throw new Error('An EXTRACTED evidence item must carry an extraction with passages.');
  }
  if (existing.sha256 !== null && input.sha256 !== undefined && input.sha256 !== existing.sha256) {
    throw new Error(
      `Refusing to re-file "${existing.title}": its recorded original is ${existing.sha256} ` +
        `and the bytes just read hash to ${input.sha256}.`,
    );
  }

  const corrections = rekeyConfirmedFields(
    existing.extraction,
    input.extraction,
    existing.confirmedFields,
  );

  const next: Evidence = {
    ...existing,
    extraction: input.extraction,
    /*
      The corrections are carried across, and their keys are re-pointed at the reading each one
      was about.

      This used to be a plain carry, and the comment above this function said `confirmedFields`
      was never touched. Half of that was right: the *values* are a person's own words about
      their own evidence and are never dropped, re-typed or overridden here. The keys are a
      different thing — `phones.3` is a pointer into whatever the extraction in this record
      happened to hold, so replacing the extraction and leaving the pointer is how a correction
      came to sit on a value nobody typed it for. See `rekeyConfirmedFields` for the full
      account, including why a stranded correction is kept rather than dropped.

      `confirmedAt` stays exactly as it was, and deliberately: re-keying is this function's
      bookkeeping, not a review. Stamping it with `context.now` would have the record claim the
      person confirmed something at the moment a machine re-read the file.
    */
    confirmedFields: corrections.confirmedFields,
    // A confirmed item that is re-read stays confirmed: the corrections still apply.
    state: input.state === 'EXTRACTED' && existing.state === 'CONFIRMED' ? 'CONFIRMED' : input.state,
    failureReason: input.state === 'EXTRACTED' ? null : (reason ?? '').slice(0, 600),
    ...(existing.sha256 === null && input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    updatedAt: context.now,
  };

  /*
    What happened to the corrections is reported, not just done.

    A re-key is the app moving something a person entered, and the audit trail is where this
    product says what it did. Counts only, and no field values: the values came off the document
    and `confirmEvidenceFields` already holds the line that audit entries name fields rather
    than quoting them. Both numbers are omitted when they are zero, so an ordinary reprocess
    writes the entry it always wrote.
  */
  const rekeyNote =
    corrections.moved || corrections.stranded
      ? ` ${describeRekey(corrections.moved, corrections.stranded)}`
      : '';

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_PROCESSED',
        `Processed "${short(existing.title)}".${rekeyNote}`,
        [{ kind: 'evidence', id: evidenceId }],
        // The outcome and the extractor version, never document contents.
        {
          state: next.state,
          extractor: input.extraction?.extractorVersion ?? 'none',
          ...(corrections.moved ? { correctionsMoved: String(corrections.moved) } : {}),
          ...(corrections.stranded ? { correctionsStranded: String(corrections.stranded) } : {}),
        },
      ),
    ),
  ]);
}

/**
 * The one sentence a person reads about a re-key, in the audit trail.
 *
 * Says what happened to their corrections and nothing about what the document contains. Kept
 * out of the mutation body because it is prose with two plural forms and a pair of independent
 * clauses, and inlining it made the write harder to read than the write deserved.
 */
function describeRekey(moved: number, stranded: number): string {
  const parts: string[] = [];
  if (moved) {
    parts.push(
      moved === 1
        ? 'One correction now points at the same value in its new place'
        : `${moved} corrections now point at the same values in their new places`,
    );
  }
  if (stranded) {
    parts.push(
      stranded === 1
        ? 'one correction has no matching reading in this pass and is kept as your own entry'
        : `${stranded} corrections have no matching reading in this pass and are kept as your own entries`,
    );
  }
  const sentence = parts.join(', and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** Convenience for callers that already hold the text: hashes it the same way the seed does. */
export function hashForText(text: string): string {
  return hashText(text);
}

/**
 * Records a person's correction to an extracted field.
 *
 * Corrections live in `confirmedFields`, separate from `extraction`, so reprocessing a
 * document can refresh every machine-read value without ever discarding what someone
 * checked by hand. `effectiveExtraction` layers the two at read time.
 *
 * ## Why the state moves only out of REVIEW_REQUIRED
 *
 * This used to set `state: 'CONFIRMED'` unconditionally, and the one screen that calls it
 * undid that in the same breath — mapping over the returned changes to write the previous
 * state back (`app/case/[caseId]/evidence/[evidenceId].tsx`). Two pieces of code disagreeing
 * about the same field, with the decision expressed as an unnamed one-liner in a UI handler.
 *
 * Both halves had a point, and the resolution is that they are about different states:
 *
 * - On a `REVIEW_REQUIRED` record, `CONFIRMED` is correct and the revert was a bug the user
 *   could see. `REVIEW_REQUIRED` means "a person has to look at this"; correcting the field
 *   *is* a person looking at it. Reverting left the record flagged for review forever, with
 *   the amber chip on the card and the row still in the worklist, after the user had already
 *   done the thing being asked of them.
 * - On an `EXTRACTED` record, the revert was right. A document has many extracted values, and
 *   fixing one of them is not a declaration that the other nineteen were read correctly.
 *   `CONFIRMED` carries a green tone and a `check-decagram` glyph; spending that on one edit
 *   would be the badge claiming more than the user did.
 *
 * `confirmedAt` is stamped either way — the correction happened, and that is what that field
 * records.
 */
export function confirmEvidenceFields(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  fields: Record<string, string>,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId),
    'Evidence',
    evidenceId,
  );

  const next: Evidence = {
    ...existing,
    confirmedFields: { ...existing.confirmedFields, ...fields },
    confirmedAt: context.now,
    state: existing.state === 'REVIEW_REQUIRED' ? 'CONFIRMED' : existing.state,
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_CONFIRMED',
        `Confirmed details on "${short(existing.title)}"`,
        [{ kind: 'evidence', id: evidenceId }],
        // Field *names* are recorded, never the corrected values: those come from the
        // document.
        { fields: Object.keys(fields).join(', ').slice(0, 79) },
      ),
    ),
  ]);
}

export function updateEvidence(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
  patch: { title?: string; note?: string },
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId),
    'Evidence',
    evidenceId,
  );

  const next: Evidence = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('evidence', next),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'EVIDENCE_CONFIRMED', `Edited "${short(next.title)}"`, [
        { kind: 'evidence', id: evidenceId },
      ]),
    ),
  ]);
}

/**
 * Tombstones an evidence item.
 *
 * Relationships pointing at it are deliberately left in place: the rule engine already
 * drops links whose endpoint is gone, so a deleted document stops supporting claims
 * immediately, while the audit trail still shows that it once did. Destroying the
 * links instead would erase the record of what the case looked like before.
 */
export function deleteEvidence(
  workspace: Workspace,
  context: MutationContext,
  evidenceId: string,
): Mutation {
  const existing = requireRecord(
    workspace.evidence.find((item) => item.id === evidenceId),
    'Evidence',
    evidenceId,
  );

  return commit(workspace, [
    put('evidence', { ...existing, deletedAt: context.now, updatedAt: context.now }),
    put(
      'auditLogs',
      auditEntry(context, existing.caseId, 'EVIDENCE_DELETED', `Deleted "${short(existing.title)}"`, [
        { kind: 'evidence', id: evidenceId },
      ]),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export interface LinkInput {
  from: EntityRef;
  to: EntityRef;
  type: RelationshipType;
  note?: string;
  /** Only meaningful for CONTRADICTS: whether it is strong enough to flip a claim. */
  material?: boolean;
  /**
   * Who asserted this link. Defaults to `USER`, because the overwhelming majority of
   * calls are a person tapping "link" — but it must be overridable, or accepting a model's
   * suggestion would be recorded as a human assertion. That distinction is the difference
   * between "I claim these documents contradict" and "software suggested they might", and
   * the whole provenance model depends on not losing it.
   */
  origin?: EvidenceRelationship['origin'];
}

/**
 * Whether an `EntityRef` points at a record that actually exists in this workspace.
 *
 * Needed because a relationship target can come from a language model, which can return a
 * plausibly-shaped id for a record that was never in the case. Writing that unchecked
 * produces a dangling edge: the graph renders a node with no source, and the audit trail
 * cites a document nobody can open.
 */
function refExists(workspace: Workspace, ref: EntityRef): boolean {
  switch (ref.kind) {
    case 'claim':
      return workspace.claims.some((item) => item.id === ref.id);
    case 'event':
      return workspace.events.some((item) => item.id === ref.id);
    case 'entity': {
      const pId = ref.id.replace(/^entity:/, '');
      return workspace.cases.some((c) => (c.participants ?? []).some((p) => p.id === pId));
    }
    case 'conflict': {
      const cId = ref.id.replace(/^conflict:/, '');
      return workspace.analysisResults.some((r) => r.id === cId);
    }
    default:
      return workspace.evidence.some((item) => item.id === ref.id);
  }
}

const describeRef = (workspace: Workspace, ref: EntityRef): string => {
  if (ref.kind === 'claim') {
    return short(workspace.claims.find((item) => item.id === ref.id)?.statement ?? ref.id, 40);
  }
  if (ref.kind === 'event') {
    return short(workspace.events.find((item) => item.id === ref.id)?.title ?? ref.id, 40);
  }
  if (ref.kind === 'entity') {
    const pId = ref.id.replace(/^entity:/, '');
    for (const c of workspace.cases) {
      const p = c.participants?.find((part) => part.id === pId);
      if (p) return short(p.name, 40);
    }
    return short(ref.id, 40);
  }
  if (ref.kind === 'conflict') {
    const cId = ref.id.replace(/^conflict:/, '');
    const finding = workspace.analysisResults.find((r) => r.id === cId);
    return short(finding?.title ?? ref.id, 40);
  }
  return short(workspace.evidence.find((item) => item.id === ref.id)?.title ?? ref.id, 40);
};

export function linkEntities(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
  input: LinkInput,
): Mutation {
  // Both endpoints are checked before anything is written. A dangling relationship is
  // worse than a refused one: it corrupts the graph and the audit trail silently, whereas
  // a thrown error names the bad id at the point it was introduced.
  if (!refExists(workspace, input.from)) {
    throw new Error(`Cannot link: no ${input.from.kind} with id ${input.from.id} in this case.`);
  }
  if (!refExists(workspace, input.to)) {
    throw new Error(`Cannot link: no ${input.to.kind} with id ${input.to.id} in this case.`);
  }

  const origin = input.origin ?? 'USER';

  const record: EvidenceRelationship = {
    id: idFor(context, 'rel'),
    ownerId: context.ownerId,
    caseId,
    createdAt: context.now,
    updatedAt: context.now,
    from: input.from,
    to: input.to,
    type: input.type,
    origin,
    material: input.material ?? false,
    note: input.note?.trim() ?? '',
    createdByRuleId: null,
  };

  return commit(workspace, [
    put('relationships', record),
    put(
      'auditLogs',
      auditEntry(
        context,
        caseId,
        // An accepted model suggestion is logged as such. Reading the history later, it
        // must be possible to tell which links a person originated and which they merely
        // approved.
        origin === 'AI' ? 'SUGGESTION_ACCEPTED' : 'EVIDENCE_LINKED',
        `Linked ${describeRef(workspace, input.from)} → ${describeRef(workspace, input.to)}`,
        [input.from, input.to],
        { relationship: input.type, material: String(record.material), origin },
      ),
    ),
  ]);
}

/**
 * Removes a link. Relationships are hard-deleted rather than tombstoned because they
 * are assertions, not sources: an assertion a user retracts should stop existing, and
 * the audit entry is what preserves the fact that it was once made.
 */
export function unlinkEntities(
  workspace: Workspace,
  context: MutationContext,
  relationshipId: string,
): Mutation {
  const existing = requireRecord(
    workspace.relationships.find((item) => item.id === relationshipId),
    'Relationship',
    relationshipId,
  );

  return commit(workspace, [
    { op: 'delete', collection: 'relationships', id: relationshipId },
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        'EVIDENCE_UNLINKED',
        `Removed link ${describeRef(workspace, existing.from)} → ${describeRef(workspace, existing.to)}`,
        [existing.from, existing.to],
        { relationship: existing.type },
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Findings and analysis
// ---------------------------------------------------------------------------

/**
 * Records a human's judgement on a finding.
 *
 * The finding itself is never edited or deleted — reviewing is a separate fact layered
 * on top of the machine's output, so the analysis history stays intact and a later run
 * can still recognise the same finding by its derived id.
 */
export function reviewFinding(
  workspace: Workspace,
  context: MutationContext,
  findingId: string,
  status: 'REVIEWED' | 'DISMISSED',
  note = '',
): Mutation {
  const existing = requireRecord(
    workspace.analysisResults.find((item) => item.id === findingId),
    'Finding',
    findingId,
  );

  const next: AnalysisResult = {
    ...existing,
    status,
    reviewNote: note.trim().slice(0, 1000),
    reviewedAt: context.now,
    updatedAt: context.now,
  };

  return commit(workspace, [
    put('analysisResults', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        status === 'DISMISSED' ? 'FINDING_DISMISSED' : 'FINDING_REVIEWED',
        `${status === 'DISMISSED' ? 'Dismissed' : 'Reviewed'} finding "${short(existing.title)}"`,
        [],
        { resultType: existing.resultType, severity: existing.severity },
      ),
    ),
  ]);
}
/**
 * Records a person's decision on an AI suggestion: ACCEPTED or REJECTED.
 *
 * Mirrors `reviewFinding` deliberately. The decision is review state plus an audit
 * entry, and nothing else: accepting a suggestion does **not** write `confirmedFields`,
 * create a relationship, or touch the deterministic extraction in any way. A suggested
 * field value becomes real only through `confirmEvidenceFields` - the existing
 * correction UI - and a suggested link only through `linkEntities`, so every value in
 * the case still carries the provenance of the path that produced it.
 *
 * The proposal itself is never edited, so a suggestion cannot be rewritten into saying
 * something the model did not; the audit entry preserves who decided, when, and which
 * proposal (by kind and model) they were looking at.
 */
export function reviewAiSuggestion(
  workspace: Workspace,
  context: MutationContext,
  suggestionId: string,
  status: 'ACCEPTED' | 'REJECTED',
): Mutation {
  const existing = requireRecord(
    workspace.aiSuggestions.find((item) => item.id === suggestionId),
    'Suggestion',
    suggestionId,
  );

  const next: AIExtractionSuggestion = {
    ...existing,
    status,
    reviewedAt: context.now,
    updatedAt: context.now,
  };

  const changes: Change[] = [
    put('aiSuggestions', next),
    put(
      'auditLogs',
      auditEntry(
        context,
        existing.caseId,
        status === 'REJECTED' ? 'SUGGESTION_REJECTED' : 'SUGGESTION_ACCEPTED',
        `${status === 'REJECTED' ? 'Dismissed' : 'Accepted'} AI suggestion "${short(existing.summary)}"`,
        existing.evidenceId ? [{ kind: 'evidence', id: existing.evidenceId }] : [],
        { kind: existing.kind, model: existing.model },
      ),
    ),
  ];

  if (status === 'ACCEPTED') {
    const payload = (existing.payload ?? {}) as Record<string, unknown>;

    // 1. For RELATIONSHIP suggestions, establish the concrete link
    if (existing.kind === 'RELATIONSHIP') {
      const targetKind =
        (payload.targetKind as 'claim' | 'event' | undefined) ??
        (payload.to && typeof payload.to === 'object' ? (payload.to as EntityRef).kind : undefined);
      const targetId =
        (payload.targetId as string | undefined) ??
        (payload.to && typeof payload.to === 'object' ? (payload.to as EntityRef).id : undefined);
      const fromEvidenceId =
        existing.evidenceId ??
        existing.sourceEvidenceIds[0] ??
        (payload.from && typeof payload.from === 'object' ? (payload.from as EntityRef).id : undefined);

      if (targetKind && targetId && fromEvidenceId) {
        const from: EntityRef = { kind: 'evidence', id: fromEvidenceId };
        const to: EntityRef = { kind: targetKind as EntityRef['kind'], id: targetId };

        if (refExists(workspace, from) && refExists(workspace, to)) {
          const relationshipType = ((payload.relationshipType ?? payload.type ?? 'RELATED_TO') as RelationshipType);
          const alreadyLinked = workspace.relationships.some(
            (r) =>
              r.caseId === existing.caseId &&
              r.from.kind === from.kind &&
              r.from.id === from.id &&
              r.to.kind === to.kind &&
              r.to.id === to.id &&
              r.type === relationshipType,
          );
          if (!alreadyLinked) {
            const relRecord: EvidenceRelationship = {
              id: idFor(context, 'rel'),
              ownerId: context.ownerId,
              caseId: existing.caseId,
              createdAt: context.now,
              updatedAt: context.now,
              from,
              to,
              type: relationshipType,
              origin: 'AI',
              material: Boolean(payload.material),
              note: typeof payload.note === 'string' ? payload.note.trim() : existing.summary,
              createdByRuleId: null,
            };
            changes.push(put('relationships', relRecord));
          }
        }
      }
    }

    // 2. For FIELD_EXTRACTION suggestions, apply confirmed fields to evidence
    if (existing.kind === 'FIELD_EXTRACTION' && existing.evidenceId) {
      const ev = workspace.evidence.find((item) => item.id === existing.evidenceId && !item.deletedAt);
      if (ev) {
        const confirmed: Record<string, string> = {};
        if (typeof payload.documentType === 'string' && payload.documentType.trim()) {
          confirmed.documentType = payload.documentType.trim();
        }
        if (typeof payload.refinedTitle === 'string' && payload.refinedTitle.trim()) {
          confirmed.title = payload.refinedTitle.trim();
        } else if (typeof payload.title === 'string' && payload.title.trim()) {
          confirmed.title = payload.title.trim();
        }
        if (typeof payload.modelSummary === 'string' && payload.modelSummary.trim()) {
          confirmed.summary = payload.modelSummary.trim();
        } else if (typeof payload.summary === 'string' && payload.summary.trim()) {
          confirmed.summary = payload.summary.trim();
        }
        if (payload.confirmedFields && typeof payload.confirmedFields === 'object') {
          for (const [k, v] of Object.entries(payload.confirmedFields)) {
            if (typeof v === 'string') confirmed[k] = v;
          }
        }
        if (payload.fields && typeof payload.fields === 'object') {
          for (const [k, v] of Object.entries(payload.fields)) {
            if (typeof v === 'string') confirmed[k] = v;
          }
        }

        if (Object.keys(confirmed).length > 0) {
          const updatedEvidence: Evidence = {
            ...ev,
            confirmedFields: { ...ev.confirmedFields, ...confirmed },
            confirmedAt: context.now,
            state: ev.state === 'REVIEW_REQUIRED' ? 'CONFIRMED' : ev.state,
            updatedAt: context.now,
          };
          changes.push(put('evidence', updatedEvidence));
        }
      }
    }
  }

  return commit(workspace, changes);
}

/**
 * Runs the rule engine over a case and persists everything it implies.
 *
 * One mutation covers the findings, the findings that no longer hold, the refreshed
 * claim states and the case's `lastAnalyzedAt`, because a half-applied analysis would
 * show a case whose claim states disagree with its own findings. Only records that
 * actually changed are written.
 *
 * The run itself is returned alongside the mutation. `runDirectCaseAnalysis` needs the
 * findings to build its report and used to get them by calling `runAnalysis` a second
 * time and persisting the results by hand — which is how it came to persist `results`
 * and silently drop `resolved`. Handing the run back is what lets one caller both
 * persist correctly and read what was persisted.
 */
export function runCaseAnalysis(
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
): Mutation & { findingCount: number; resolvedCount: number; run: AnalysisRunResult } {
  const run = runAnalysis(workspace, caseId, context.now);

  const changes: Change[] = [];
  const existingById = new Map(workspace.analysisResults.map((item) => [item.id, item]));

  for (const result of [...run.results, ...run.resolved]) {
    const previous = existingById.get(result.id);
    // `updatedAt` moves on every run, so comparing whole records would rewrite
    // everything each time. Compare what a reader would notice instead.
    if (previous && isSameFinding(previous, result)) continue;
    changes.push(put('analysisResults', result));
  }

  // Claim states are derived from the relationships, but they are cached on the claim
  // so that a list screen does not have to evaluate the whole case to render a chip.
  const analysedWorkspace = applyChanges(workspace, changes);
  const evaluations = evaluateCaseClaims(analysedWorkspace, caseId);
  for (const claim of analysedWorkspace.claims) {
    if (claim.caseId !== caseId || claim.deletedAt) continue;
    const state = evaluations.get(claim.id)?.state;
    if (!state || state === claim.state) continue;
    changes.push(put('claims', { ...claim, state, updatedAt: context.now }));
  }

  const parentCase = workspace.cases.find((item) => item.id === caseId);
  if (parentCase) {
    changes.push(
      put('cases', { ...parentCase, lastAnalyzedAt: run.runAt, updatedAt: context.now }),
    );
  }

  changes.push(
    put(
      'auditLogs',
      auditEntry(
        context,
        caseId,
        'ANALYSIS_RUN',
        `Analysis run produced ${run.results.length} finding${run.results.length === 1 ? '' : 's'}`,
        [],
        {
          rules: String(run.evaluatedRuleIds.length),
          findings: String(run.results.length),
          resolved: String(run.resolved.length),
        },
      ),
    ),
  );

  return {
    ...commit(workspace, changes),
    findingCount: run.results.length,
    resolvedCount: run.resolved.length,
    run,
  };
}

/** Whether two versions of a finding say the same thing, ignoring the run timestamp. */
function isSameFinding(a: AnalysisResult, b: AnalysisResult): boolean {
  return (
    a.severity === b.severity &&
    a.status === b.status &&
    a.title === b.title &&
    a.explanation === b.explanation &&
    // The caveat is a reader-visible field with its own control on the card, so a run that
    // changes only the hedge — the quarantine naming a different unconfirmed read after a
    // re-extraction, say — still has to be written back. Leaving it out of this comparison
    // would freeze the first caveat a finding was ever given onto every later version of it.
    a.caveat === b.caveat &&
    a.confidence === b.confidence &&
    // Provisional-ness is what a reader notices most: confirming an OCR value flips a
    // finding from a hedged question to a plain statement (or clears it), and that
    // transition must be written back or the card would keep asking to confirm a value
    // already confirmed.
    a.provisional === b.provisional &&
    JSON.stringify(a.inputs) === JSON.stringify(b.inputs) &&
    JSON.stringify(a.supportingEvidenceIds) === JSON.stringify(b.supportingEvidenceIds) &&
    JSON.stringify(a.relatedClaimIds) === JSON.stringify(b.relatedClaimIds) &&
    JSON.stringify(a.relatedEventIds) === JSON.stringify(b.relatedEventIds) &&
    JSON.stringify(a.unconfirmedReads) === JSON.stringify(b.unconfirmedReads)
  );
}
