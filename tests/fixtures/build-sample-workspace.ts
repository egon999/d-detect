import { evaluateCaseClaims } from '@domain/analysis/claim-state';
import { EXTRACTOR_VERSION, extractFromText } from '@domain/extraction/deterministic';
import { RELATIONSHIP_LABELS } from '@domain/enums';
import { hashText, processingFingerprint } from '@domain/hashing';
import type {
  AuditLog,
  Case,
  CaseEvent,
  Claim,
  Evidence,
  EvidenceRelationship,
  ProcessingJob,
  Workspace,
} from '@domain/models';
import { normalizeDate } from '@domain/normalize/dates';
import { applyAnalysisRun, runAnalysis } from '@domain/rules/engine';
import { RULES } from '@domain/rules/registry';
import type { Repository } from '@data/repository';

import { SAMPLE_DOCUMENTS } from './sample-documents';

/**
 * Builds a complete case out of the sample corpus, for tests only.
 *
 * ## Not a fixture of findings
 *
 * This deliberately does not hold pre-written conflicts. It creates the same entities a
 * user creates by hand — evidence, claims, events, links — and then runs the real
 * extractor and the real rule engine over them. Every finding the assertions check is a
 * genuine output of production code, reached by the production code path, which is what
 * makes the tests worth anything: hard-coding the expected findings would test that a
 * literal equals itself.
 *
 * ## Why it is under `tests/`
 *
 * See the header of `./sample-documents.ts`. Nothing in the shipped app builds a case for
 * the user; a first launch is empty by design. Keeping the builder out of `src/` makes that
 * unreachable from the bundle rather than merely unused by it.
 *
 * Ids are fixed strings so a repeated build overwrites rather than duplicating, and so an
 * assertion can name the record it is about.
 */

export const SAMPLE_CASE_ID = 'case_sample_payment_dispute';

/** Anchors the corpus to a stable point in time so no assertion depends on today's date. */
const SAMPLE_EPOCH = Date.parse('2024-04-05T09:00:00.000Z');

const ids = {
  claimDelivered: 'clm_sample_delivered',
  claimBalance: 'clm_sample_balance',
  claimTerms: 'clm_sample_terms',
  eventAgreement: 'evt_sample_agreement',
  eventDelivery: 'evt_sample_delivery',
  eventDue: 'evt_sample_due',
  eventPartPayment: 'evt_sample_part_payment',
} as const;

const evidenceId = (key: string) => `evd_sample_${key.replace(/-/g, '_')}`;

/**
 * How far apart the corpus spaces its uploads.
 *
 * These stamps are ordering, not history: the workspace is built in one call, so there is no
 * real capture time to record. Six minutes apart reads as one sitting of someone working
 * through a folder of documents, and it gives the "recent evidence" ordering and the audit
 * trail something stable and meaningful to sort by.
 */
const UPLOAD_INTERVAL_MS = 6 * 60 * 1000;

/** The same logical key shape `evidenceStoragePath()` produces, so records look real. */
const storagePathFor = (ownerId: string, id: string, fileName: string) =>
  `users/${ownerId}/cases/${SAMPLE_CASE_ID}/${id}/original.${
    /\.([a-z0-9]{1,12})$/i.exec(fileName)?.[1]?.toLowerCase() ?? 'bin'
  }`;

function buildEvidence(ownerId: string, now: number): Evidence[] {
  return SAMPLE_DOCUMENTS.map((document, index) => {
    const id = evidenceId(document.key);
    const text = document.text;
    const at = now + index * UPLOAD_INTERVAL_MS;

    // The file whose contents could not be read. `text: null` is the honest representation,
    // and everything downstream of it is empty rather than invented: no hash of nothing, no
    // fabricated extraction, and the REVIEW_REQUIRED state the pipeline really assigns.
    if (text === null) {
      return {
        id,
        ownerId,
        caseId: SAMPLE_CASE_ID,
        createdAt: at,
        updatedAt: at,
        title: document.title,
        kind: document.kind,
        state: 'REVIEW_REQUIRED' as const,
        note: '',
        fileName: document.fileName,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes ?? 0,
        storagePath: document.fileName ? storagePathFor(ownerId, id, document.fileName) : null,
        // The file exists and has bytes, so it has a fingerprint. Hashing the filename keeps
        // it stable across rebuilds without pretending to have hashed contents the corpus
        // does not carry.
        sha256: document.fileName ? hashText(`sample-binary:${document.fileName}`) : null,
        // An extraction over the empty string: real shape, real extractor version, and
        // genuinely zero fields, because zero fields is what was read.
        extraction: extractFromText({ evidenceId: id, title: document.title, text: '', method: 'DETERMINISTIC' }),
        confirmedFields: {},
        confirmedAt: null,
        failureReason:
          'No text could be read from this file. Type in what it shows, or replace it with a ' +
          'clearer copy, before it can be analysed.',
        deletedAt: null,
      };
    }

    return {
      id,
      ownerId,
      caseId: SAMPLE_CASE_ID,
      // Spread creation times so the "recent evidence" list has a meaningful order.
      createdAt: at,
      updatedAt: at,
      title: document.title,
      kind: document.kind,
      // Processed and human-confirmed: the state a user reaches after reviewing an upload,
      // and the one most of the analysis assertions need their inputs to be in.
      state: 'CONFIRMED' as const,
      note: document.kind === 'NOTE' ? text.trim() : '',
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: new TextEncoder().encode(text).length,
      // Notes have no file, so they have no hash and can never be an "exact duplicate".
      storagePath: document.fileName ? storagePathFor(ownerId, id, document.fileName) : null,
      sha256: document.fileName ? hashText(text) : null,
      // The corpus is literal text, not pixels, so its provenance really is deterministic.
      extraction: extractFromText({ evidenceId: id, title: document.title, text, method: 'DETERMINISTIC' }),
      confirmedFields: {},
      confirmedAt: at,
      failureReason: null,
      deletedAt: null,
    };
  });
}

function buildClaims(ownerId: string, now: number): Claim[] {
  const base = { ownerId, caseId: SAMPLE_CASE_ID, createdAt: now, updatedAt: now, deletedAt: null };
  return [
    {
      ...base,
      id: ids.claimDelivered,
      statement: 'The completed website was delivered and handed over on 12 March 2024.',
      detail:
        'The handover date decides when the 14-day payment window started. The client disputes it.',
      requiredEventIds: [ids.eventDelivery],
      state: 'UNSUPPORTED' as const,
    },
    {
      ...base,
      id: ids.claimBalance,
      statement: 'Harbour Retail still owes INR 45,000 of the agreed INR 85,000 project fee.',
      detail: 'Agreed value INR 85,000, of which INR 40,000 has been received.',
      requiredEventIds: [ids.eventDue],
      state: 'UNSUPPORTED' as const,
    },
    {
      ...base,
      id: ids.claimTerms,
      statement: 'The client verbally agreed to release the balance after an internal approval.',
      detail: 'Stated on a phone call. Nothing in writing confirms it.',
      requiredEventIds: [],
      state: 'UNSUPPORTED' as const,
    },
  ];
}

function buildEvents(ownerId: string, now: number): CaseEvent[] {
  const base = { ownerId, caseId: SAMPLE_CASE_ID, createdAt: now, updatedAt: now, deletedAt: null };
  const dated = (iso: string, evidence: string) => ({
    ...normalizeDate(iso),
    evidenceId: evidence,
    method: 'MANUAL' as const,
  });

  return [
    {
      ...base,
      id: ids.eventAgreement,
      title: 'Service agreement signed',
      description: 'Both parties signed the agreement covering three milestones for INR 85,000.',
      occurredAt: dated('2024-01-20', evidenceId('agreement')),
      claimIds: [ids.claimBalance],
    },
    {
      ...base,
      id: ids.eventDelivery,
      title: 'Website delivered and handed over',
      description: 'Final handover package shared. The two parties give different dates for this.',
      occurredAt: dated('2024-03-12', evidenceId('delivery-email')),
      claimIds: [ids.claimDelivered],
    },
    {
      ...base,
      id: ids.eventDue,
      title: 'Balance payment due',
      description: 'Net 14 days from delivery. Nothing evidences what happened on this date.',
      occurredAt: dated('2024-03-26', evidenceId('invoice')),
      claimIds: [ids.claimBalance],
    },
    {
      ...base,
      id: ids.eventPartPayment,
      title: 'Part payment of INR 40,000 received',
      description: 'NEFT transfer received against invoice INV-2024-018.',
      occurredAt: dated('2024-03-28', evidenceId('payment-receipt')),
      claimIds: [ids.claimBalance],
    },
  ];
}

function buildRelationships(ownerId: string, now: number): EvidenceRelationship[] {
  const base = { ownerId, caseId: SAMPLE_CASE_ID, createdAt: now, updatedAt: now, createdByRuleId: null };

  const link = (
    key: string,
    from: EvidenceRelationship['from'],
    to: EvidenceRelationship['to'],
    type: EvidenceRelationship['type'],
    note: string,
    material = false,
  ): EvidenceRelationship => ({
    ...base,
    id: `rel_sample_${key}`,
    from,
    to,
    type,
    origin: 'USER',
    material,
    note,
  });

  const evidenceRef = (key: string) => ({ kind: 'evidence' as const, id: evidenceId(key) });
  const claimRef = (id: string) => ({ kind: 'claim' as const, id });
  const eventRef = (id: string) => ({ kind: 'event' as const, id });

  return [
    link('agreement_event', evidenceRef('agreement'), eventRef(ids.eventAgreement), 'ATTACHED_TO_EVENT',
      'The signed agreement is the record of this event.'),
    link('agreement_balance', evidenceRef('agreement'), claimRef(ids.claimBalance), 'SUPPORTS',
      'Establishes the agreed total of INR 85,000.'),

    link('invoice_balance', evidenceRef('invoice'), claimRef(ids.claimBalance), 'SUPPORTS',
      'Invoice for the full amount claimed.'),
    // Deliberately no link to the "balance payment due" event. Nothing in this case
    // records what happened on that date, which is what the missing-evidence rule exists
    // to notice.

    link('delivery_event', evidenceRef('delivery-email'), eventRef(ids.eventDelivery), 'SUPPORTS',
      'Handover email sent on the day of delivery.'),
    link('delivery_claim', evidenceRef('delivery-email'), claimRef(ids.claimDelivered), 'SUPPORTS',
      'States that handover completed on 12 March.'),

    link('reply_event', evidenceRef('client-reply'), eventRef(ids.eventDelivery), 'SUPPORTS',
      'The client also describes this handover, but dates it differently.'),
    link('reply_claim', evidenceRef('client-reply'), claimRef(ids.claimDelivered), 'CONTRADICTS',
      'A written reply from the counterparty giving a different handover date.',
      // Material: a dated written statement from the other party, not an offhand remark.
      true),

    link('receipt_event', evidenceRef('payment-receipt'), eventRef(ids.eventPartPayment), 'SUPPORTS',
      'Bank confirmation of the part payment.'),
    link('receipt_balance', evidenceRef('payment-receipt'), claimRef(ids.claimBalance), 'SUPPORTS',
      'Shows INR 40,000 received against the invoice.'),

    // The screenshot the app could not read, linked by hand.
    //
    // This is the point of including an unreadable document at all. The extractor got
    // nothing from it, so no rule can reach it on its own — but a person knows what it
    // shows, and RELATED_TO is how they say so. It is deliberately not SUPPORTS: the app
    // has read nothing from this file, so it cannot be treated as evidence *for* anything
    // until someone types out what it says.
    link('screenshot_event', evidenceRef('unreadable-screenshot'), eventRef(ids.eventPartPayment), 'RELATED_TO',
      'Screenshot of the same payment. No text could be read from it, so it is recorded as ' +
        'related rather than supporting.'),

    link('duplicate_invoice', evidenceRef('invoice-duplicate'), evidenceRef('invoice'), 'DUPLICATE_OF',
      'Re-uploaded copy of the same invoice file.'),
  ];
}

/**
 * The audit trail, derived from the records it describes.
 *
 * Every entry below is generated *from* an entity that exists in the workspace — the case,
 * each evidence item, each user-asserted relationship, and the analysis run whose real
 * result is passed in. Nothing is authored: add a document to `SAMPLE_DOCUMENTS` and its
 * upload entry appears; change a relationship and the linking entry follows it.
 *
 * The `ANALYSIS_RUN` entry in particular takes the run's actual finding count and its
 * actual `runAt`, which is why this function is called *after* `runAnalysis` rather than
 * before it. An earlier version wrote "Ran deterministic analysis across the case" ahead of
 * the run itself, recording an event that had not happened yet — precisely the class of
 * thing an audit trail exists to prevent.
 *
 * Timestamps interleave with the records: an upload is logged when the document was
 * uploaded, not at an arbitrary offset from case creation.
 */
function buildAuditTrail(
  ownerId: string,
  now: number,
  evidence: Evidence[],
  relationships: EvidenceRelationship[],
  run: { runAt: number; findingCount: number },
): AuditLog[] {
  const base = { ownerId, caseId: SAMPLE_CASE_ID, actorId: ownerId, metadata: {} };
  const entries: Array<Omit<AuditLog, 'id' | 'updatedAt'>> = [
    {
      ...base,
      createdAt: now,
      action: 'CASE_CREATED',
      entityRefs: [{ kind: 'claim', id: ids.claimBalance }],
      summary: 'Created case "Website project — unpaid balance"',
    },

    ...evidence.map((item) => ({
      ...base,
      createdAt: item.createdAt,
      action: 'EVIDENCE_UPLOADED' as const,
      entityRefs: [{ kind: 'evidence' as const, id: item.id }],
      summary: `Uploaded "${item.title}"`,
      // Metadata stays to identifiers, sizes and outcomes. Document contents are never
      // audited — that rule is what keeps this log safe to export.
      metadata: {
        kind: item.kind,
        sizeBytes: String(item.sizeBytes ?? 0),
        // Whether the file could be read at all is exactly the sort of thing a reviewer
        // needs from a history, and it is derived rather than asserted.
        textRead: item.extraction && item.extraction.sourceText.length > 0 ? 'yes' : 'no',
      },
    })),

    // An entry per relationship a *person* asserted. Rule-created and AI-suggested links
    // are excluded: they are recomputed on every run, so logging them would fill the
    // history with machine noise and bury the handful of human decisions in it.
    ...relationships
      .filter((relationship) => relationship.origin === 'USER')
      .map((relationship) => ({
        ...base,
        createdAt: relationship.createdAt,
        action: 'EVIDENCE_LINKED' as const,
        entityRefs: [relationship.from, relationship.to],
        summary: `Linked ${relationship.from.kind} to ${relationship.to.kind} as ${RELATIONSHIP_LABELS[
          relationship.type
        ].toLowerCase()}`,
        metadata: {
          relationship: relationship.type,
          material: String(relationship.material),
        },
      })),

    {
      ...base,
      createdAt: run.runAt,
      action: 'ANALYSIS_RUN',
      entityRefs: [],
      summary: `Ran the rule engine across the case: ${run.findingCount} finding${
        run.findingCount === 1 ? '' : 's'
      } recorded`,
      metadata: { rules: String(RULES.length), findings: String(run.findingCount) },
    },
  ];

  // Chronological, then stably indexed. Fixed ids mean a rebuild overwrites the previous
  // history rather than appending a second copy of it.
  return entries
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry, index) => ({
      ...entry,
      id: `aud_sample_${String(index).padStart(3, '0')}`,
      updatedAt: entry.createdAt,
    }));
}

/**
 * A completed processing job per evidence item.
 *
 * `processingJobs` is one of the nine collections in the workspace model, and leaving it
 * empty would mean the retry and failure paths that read it were never exercised against a
 * realistic record. Every document here really has been through extraction, so the jobs that
 * did it belong in an accurate picture of the case.
 *
 * The fingerprint is the genuine article: `processingFingerprint` over the same inputs the
 * live pipeline hashes, which is what makes a retry with unchanged inputs a no-op.
 */
function buildProcessingJobs(ownerId: string, evidence: Evidence[]): ProcessingJob[] {
  const ruleVersions = RULES.map((rule) => rule.id);

  return evidence.map((item) => {
    const read = item.extraction !== null && item.extraction.sourceText.length > 0;
    // Extraction is fast but not instant; a few hundred milliseconds after the upload is
    // both plausible and, more importantly, always after `startedAt`.
    const startedAt = item.createdAt;
    const finishedAt = startedAt + 400;

    return {
      id: `job_sample_${item.id.replace('evd_sample_', '')}`,
      ownerId,
      caseId: SAMPLE_CASE_ID,
      createdAt: startedAt,
      updatedAt: finishedAt,
      // Every job here reads one file, so they are all EVIDENCE jobs. The CASE variant is
      // for whole-case work (the written summary), which this fixture does not run.
      type: 'EVIDENCE' as const,
      evidenceId: item.id,
      // Nothing is written to Cloudinary for a fixture, so there is no result artifact.
      resultPath: null,
      // The job's state mirrors the evidence it produced rather than being set separately,
      // so the two can never disagree on screen.
      state: item.state,
      attempts: 1,
      fingerprint: processingFingerprint({
        evidenceId: item.id,
        sha256: item.sha256,
        extractorVersion: item.extraction?.extractorVersion ?? EXTRACTOR_VERSION,
        ruleVersions,
      }),
      startedAt,
      finishedAt,
      lastError: item.failureReason,
      completedSteps: read ? ['hash', 'read-text', 'extract'] : ['hash', 'read-text'],
      deletedAt: null,
    };
  });
}

/**
 * Assembles the workspace and runs analysis over it.
 *
 * `ownerId` is threaded through every record, so the corpus obeys the same ownership rules as
 * any real case and the ownership filters get exercised rather than bypassed.
 *
 * Ordering matters here. The engine runs over the entities, and only then is the history
 * built — because the history describes what the engine actually did, including how many
 * findings it produced. Building it first would mean writing down the outcome of a run
 * that had not happened.
 */
export function buildSampleWorkspace(ownerId: string, now: number = SAMPLE_EPOCH): Workspace {
  const evidence = buildEvidence(ownerId, now);
  const claims = buildClaims(ownerId, now);
  const events = buildEvents(ownerId, now);
  const relationships = buildRelationships(ownerId, now);

  const sampleCase: Case = {
    id: SAMPLE_CASE_ID,
    ownerId,
    createdAt: now,
    updatedAt: now,
    title: 'Website project — unpaid balance',
    description:
      'A freelance studio delivered a website and was paid part of the agreed fee. The two ' +
      'sides disagree about the handover date, which decides when payment became due.',
    status: 'IN_REVIEW',
    category: 'Payment dispute',
    priority: 'HIGH',
    // Named exactly as the documents name them. A participant list that disagreed with the
    // corpus would quietly weaken every entity-matching assertion built on top of it.
    participants: [
      { id: 'part_client', name: 'Harbour Retail Pvt Ltd', role: 'Client' },
      { id: 'part_contractor', name: 'Pixelwave Studio', role: 'Freelance studio' },
    ],
    tags: ['invoice', 'contract', 'web-dev'],
    incidentDate: '2024-03-12',
    // Set by `applyAnalysisRun` below, from the run's real timestamp. Left null here so
    // that a case which somehow skipped analysis reports honestly as never analysed.
    lastAnalyzedAt: null,
    deletedAt: null,
  };

  const workspace: Workspace = {
    cases: [sampleCase],
    claims,
    events,
    evidence,
    relationships,
    analysisResults: [],
    auditLogs: [],
    processingJobs: buildProcessingJobs(ownerId, evidence),
    aiSuggestions: [],
    // No AI summary is generated for a fixture: it would mean calling out to a model from a
    // pure function, and a stored one would be a fabricated model output.
    caseAnalyses: [],
    // For the same reason, unsealed. A seal is a signature by a key this process does not
    // hold, so a fixture could only ever carry one that fails to verify — a sample case that
    // reports as tampered with is worse than one that honestly reports as never sealed.
    seals: [],
  };

  // Run the real engine, then cache the claim states it implies.
  const run = runAnalysis(workspace, SAMPLE_CASE_ID, now);
  const analysed = applyAnalysisRun(workspace, run, SAMPLE_CASE_ID);
  const evaluations = evaluateCaseClaims(analysed, SAMPLE_CASE_ID);

  return {
    ...analysed,
    claims: analysed.claims.map((claim) => ({
      ...claim,
      state: evaluations.get(claim.id)?.state ?? claim.state,
    })),
    auditLogs: buildAuditTrail(ownerId, now, evidence, relationships, {
      runAt: run.runAt,
      findingCount: run.results.length,
    }),
  };
}

/**
 * Commits the whole workspace to a repository, for repository tests.
 *
 * This exists so the persistence layer can be exercised against a realistically large,
 * cross-referenced write — nine collections in one `commit`, with relationships pointing at
 * records in the same batch — rather than a single hand-made row. It is test infrastructure;
 * no shipped code path writes a prepared case into a user's account.
 *
 * Returns the stored Case, or null when the account already holds cases and `force` is unset,
 * so a test cannot silently write over data it did not create.
 */
export async function seedSampleWorkspace(
  repository: Repository,
  ownerId: string,
  nowOrOptions?: number | { now?: number; force?: boolean },
): Promise<Case | null> {
  const now = typeof nowOrOptions === 'number' ? nowOrOptions : (nowOrOptions?.now ?? Date.now());
  const force = typeof nowOrOptions === 'object' ? Boolean(nowOrOptions.force) : false;

  const existing = await repository.listCases(ownerId);
  if (existing.length > 0 && !force) return null;

  const workspace = buildSampleWorkspace(ownerId, now);
  const target = workspace.cases[0];
  if (!target) return null;

  const changes = [
    ...workspace.cases.map((record) => ({ op: 'put' as const, collection: 'cases' as const, record })),
    ...workspace.claims.map((record) => ({ op: 'put' as const, collection: 'claims' as const, record })),
    ...workspace.events.map((record) => ({ op: 'put' as const, collection: 'events' as const, record })),
    ...workspace.evidence.map((record) => ({ op: 'put' as const, collection: 'evidence' as const, record })),
    ...workspace.relationships.map((record) => ({
      op: 'put' as const,
      collection: 'relationships' as const,
      record,
    })),
    ...workspace.analysisResults.map((record) => ({
      op: 'put' as const,
      collection: 'analysisResults' as const,
      record,
    })),
    ...workspace.auditLogs.map((record) => ({
      op: 'put' as const,
      collection: 'auditLogs' as const,
      record,
    })),
    ...workspace.processingJobs.map((record) => ({
      op: 'put' as const,
      collection: 'processingJobs' as const,
      record,
    })),
    ...workspace.aiSuggestions.map((record) => ({
      op: 'put' as const,
      collection: 'aiSuggestions' as const,
      record,
    })),
  ];

  await repository.commit(ownerId, changes);
  return target;
}

