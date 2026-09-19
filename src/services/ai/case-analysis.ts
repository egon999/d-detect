/**
 * Running a case analysis, on the device.
 *
 * ## Why there is no backend call in this file
 *
 * There used to be two: a POST to `/api/cases/{id}/analysis` on a platform API, and a
 * `httpsCallable(functions, 'requestCaseAnalysis')` on Cloud Functions. Neither can answer.
 * The project runs on the Firebase Spark plan, where Cloud Functions cannot be deployed at
 * all, and there is no host for the platform API. Both paths existed as the *primary* route,
 * with `runDirectCaseAnalysis` reachable only from a `catch` block — so the ordinary case was
 * a request to a URL that does not exist, a 404 or a `functions/not-found`, and a user waiting
 * on a spinner for a service that was never deployed. The last `httpsCallable` attempts were
 * removed once that was undeniable; this file now makes no network request of its own.
 * That is still true of the processing and analysis paths. The one network call this
 * file makes today is the optional AI suggestion pass (see "The AI suggestion passes"
 * below), which runs under the user's own provider key, after the deterministic result
 * is safely committed, and can neither block it nor change it.
 *
 * Deleting them is not a downgrade. The deterministic extractor (`@domain/extraction/
 * deterministic`) and the rule engine (`@domain/rules/engine`) are the source of truth for
 * this product, they are pure functions, and they were always going to run here. A server
 * would add a queue and a retry story; it would not add an answer. What the server *did* add
 * was a `ProcessingJob` record, which several screens read — so this file now writes those
 * records itself rather than leaving the collection permanently empty.
 *
 * ## What reads a file, and what still cannot
 *
 * `requestEvidenceProcessing` reads a stored original through the evidence store
 * (`@services/storage/evidence-storage`) and turns it into text with `@services/ingestion`
 * — ML Kit OCR for images, a PDF's own text layer, the CSV/EML/text parsers, and Groq's
 * hosted Whisper for speech, under the user's own key. So a file *whose bytes are on this
 * device* is read here, at processing time, whatever device added it.
 *
 * What it still cannot do, and says so rather than pretending:
 *
 * - **Read bytes that are not on this device.** The store is per-device. A record synced
 *   from another device names a path with nothing behind it here; the item fails with the
 *   store's own sentence about the missing original, and a file whose upload never
 *   completed has no path at all. In a case analysis such an item is *excluded* and named
 *   in `coverage.excludedEvidenceIds` — not extracted from its filename, which is what an
 *   earlier version did, producing an "extraction" whose entire content was `receipt.pdf`
 *   and then citing it as a source.
 * - **Transcribe speech without the user's Groq key.** A recording without a key is still
 *   stored and hashed, and lands in REVIEW_REQUIRED with the reason — never a fabricated
 *   transcript and never a silent skip.
 * - **It is not a background worker.** Every deterministic result is finished before the
 *   function that produced it returns, and the `ProcessingJob` it writes is therefore
 *   always in a terminal state; a persisted `QUEUED` or `PROCESSING` would claim that
 *   something is running elsewhere, and `case-analysis-panel.tsx` reads exactly that to
 *   disable its button — so a run interrupted by the app being killed would leave the case
 *   permanently un-analysable. The fire-and-forget AI passes are the deliberate exception,
 *   and they never write a job record: nothing about a case's processing state may depend
 *   on an optional model call.
 * - **It does not judge anything.** The rule engine reports agreements, conflicts and
 *   coverage. `INSUFFICIENT_EVIDENCE` is the resting state of a claim, and it stays there
 *   unless a rule — not a word overlap — has something to say.
 */

import { CONFLICT_ANALYSIS_TYPES, isConflictFinding, ProcessingStateEnum } from '@domain/enums';
import { idSchema } from '@domain/models';
import { z } from 'zod';

import type { ExtractionOutcomeInput } from '@data/mutations';
import type { ExtractedTextMethod } from '@domain/extraction/deterministic';
import type { IngestResult } from '@services/ingestion/types';
import type { PrivateEvidenceFile } from '../storage/evidence-storage';
import type { ChatProvider } from './groq-client';
import type { AIFailureReason, AIResult } from './groq-client';
import { clearAiRunFailure, recordAiRunFailure } from './run-outcome';
import type { CitationAudit } from './semantic-assistant';
import type { Change, Repository } from '@data/repository';
import type {
  AIExtractionSuggestion,
  AmountField,
  CaseAnalysis,
  CaseCitation,
  ClaimAssessment,
  Claim,
  DateField,
  Evidence,
  Extraction,
  ProcessingJob,
  TextField,
} from '@domain/models';

/**
 * Type-only, so importing it does not pull `./semantic-assistant` into the module graph.
 * The whole point of the dynamic imports below is that a device with AI switched off never
 * loads the assistant, its prompts or its schemas at all.
 */
type AISuggestionKind = AIExtractionSuggestion['kind'];

/**
 * What a caller gets back.
 *
 * Kept, and still validated, even though the receipt is now built locally. `jobId` is
 * interpolated into a Firestore document path by the adapters, so `idSchema` is a real
 * invariant rather than a formality inherited from the network era.
 */
const receiptSchema = z.object({
  jobId: idSchema,
  state: ProcessingStateEnum,
  /**
   * Why a non-terminal outcome ended where it did, in one of this file's own fixed
   * sentences. The job record carries the same text as `lastError`; putting it on the
   * receipt lets the upload screen show the honest reason per file without waiting for a
   * workspace reload.
   */
  failureReason: z.string().max(600).nullable().default(null),
});
export type ProcessingReceipt = z.infer<typeof receiptSchema>;

export class ProcessingRequestError extends Error {
  constructor(public readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProcessingRequestError';
  }
}

/**
 * Where the work should be done and whose data it is.
 *
 * Optional on every entry point, and every screen that calls one already holds both values
 * from `useRepository()` and `useSession()`. Passing them is strictly better than the
 * fallback below — it uses the *same* adapter instance the screen reads through, so a
 * `watchWorkspace` listener fires and the UI updates without an explicit reload.
 */
export interface ProcessingContext {
  repository: Repository;
  ownerId: string;
}

/** Translate a bounded error code, never provider messages, evidence text, or credentials. */
export function processingError(error: unknown): ProcessingRequestError {
  if (error instanceof ProcessingRequestError) return error;
  // `PlatformApiError` still reaches this function: `RemoteRepository` speaks to the platform
  // API for workspace reads and writes, so a `loadWorkspace` or `commit` failure arrives here
  // even though nothing in this file makes an HTTP request of its own.
  if (error instanceof Error && error.name === 'PlatformApiError' && 'code' in error) {
    return new ProcessingRequestError(String(error.code), error.message);
  }
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'unknown';
  const normalized = code.replace(/^functions\//, '');
  const messages: Record<string, string> = {
    unauthenticated: 'Sign in again to process this case.',
    'permission-denied': 'You do not have access to this case.',
    'not-found': 'Processing is not available for this case. Refresh and try again.',
    'failed-precondition': 'Evidence is not ready for analysis yet. Check the processing status and try again.',
    'resource-exhausted': 'Processing capacity is busy. Your evidence is safe; try again shortly.',
    unavailable: 'The processing service could not be reached. Check your connection and try again.',
    'deadline-exceeded': 'The request took too long. Refresh the case before retrying; a job may already be queued.',
    'invalid-argument': 'The processing request was invalid. Refresh the case and try again.',
  };
  return new ProcessingRequestError(
    normalized,
    messages[normalized] ?? 'Processing could not be started. Your evidence has not been changed.',
    // The user-facing sentence is deliberately bounded, but throwing away what actually
    // failed leaves nobody — user, support or developer — able to say why. `cause` keeps
    // the original for logs and tests without putting it on screen.
    { cause: error },
  );
}

/**
 * Resolves a repository and an owner when the caller did not supply one.
 *
 * Mirrors the precedence in `repository-provider.tsx`, which is duplication and is worth
 * naming as such: a plain async function cannot reach React context, and the alternative —
 * a module-level singleton written by the provider — would be a second source of truth for
 * which adapter is live. The duplication is bounded (three lines of precedence) and the
 * fallback disappears entirely once the call sites pass a `ProcessingContext`.
 *
 * The owner comes from Firebase auth and there is no device-mode fallback, deliberately. In
 * local mode the identity lives in AsyncStorage under a key owned by `session-provider.tsx`,
 * and reading it from here would copy that key into a second file — so local mode passes an
 * explicit context instead (`upload.tsx` and the evidence screen hold both the repository
 * and the owner from their own hooks), and this fallback exists for the screens that do not.
 * An unauthenticated call without a context is still a bug in a caller, and is reported as one.
 */
async function resolveContext(context?: ProcessingContext): Promise<ProcessingContext> {
  if (context) return context;

  const { firebaseAuth } = await import('@data/firebase/auth');
  const auth = await firebaseAuth();
  const uid = auth?.currentUser?.uid;
  if (!uid) throw new ProcessingRequestError('unauthenticated', 'Sign in to upload and process evidence.');

  const { apiBaseUrl } = await import('../api-client');
  if (apiBaseUrl()) {
    const { RemoteRepository } = await import('@data/remote/remote-repository');
    return { repository: new RemoteRepository(), ownerId: uid };
  }

  const { isFirebaseConfigured } = await import('@data/firebase/config');
  if (isFirebaseConfigured()) {
    const { createFirebaseRepository } = await import('@data/firebase/firebase-repository');
    return { repository: await createFirebaseRepository(), ownerId: uid };
  }

  const { LocalRepository } = await import('@data/local/local-repository');
  const { createAsyncStorageStore } = await import('@data/local/async-storage-store');
  return { repository: new LocalRepository(createAsyncStorageStore()), ownerId: uid };
}

/** Fresh job identifiers, and the surrounding boilerplate every persisted job carries. */
async function jobRecord(input: {
  ownerId: string;
  caseId: string;
  type: ProcessingJob['type'];
  evidenceId: string | null;
  state: ProcessingJob['state'];
  startedAt: number;
  lastError: string | null;
  resultPath: string | null;
  completedSteps: readonly string[];
}): Promise<ProcessingJob> {
  const { newId } = await import('@domain/ids');
  const finishedAt = Date.now();
  return {
    id: newId('job'),
    ownerId: input.ownerId,
    caseId: input.caseId,
    type: input.type,
    evidenceId: input.evidenceId,
    resultPath: input.resultPath,
    state: input.state,
    attempts: 1,
    // No fingerprint. It exists so a retry with identical inputs can be skipped, and that is
    // a decision for a queue that might run the same job twice. Nothing here runs unasked.
    fingerprint: null,
    startedAt: input.startedAt,
    finishedAt,
    lastError: input.lastError,
    completedSteps: [...input.completedSteps],
    createdAt: input.startedAt,
    updatedAt: finishedAt,
  };
}

/**
 * A failure message that is safe to persist.
 *
 * A job record is shown to the user by `case-analysis-panel.tsx` and stored in their
 * workspace, so it must not carry a stack, a provider string or anything drawn from the
 * evidence. `processingError` already reduces everything to one of its fixed sentences.
 */
function safeFailureMessage(error: unknown): string {
  return processingError(error).message.slice(0, 600);
}
// ---------------------------------------------------------------------------
// The AI suggestion passes (optional, configured by the user)
// ---------------------------------------------------------------------------

/**
 * Most documents the case-level relationship pass will read, per analysis run.
 *
 * `suggestCaseRelationshipsWithAI` prices one request per document, and nothing bounds
 * the size of a case, so the pass states its own budget: the first documents in the
 * workspace's stable id order. Per-request size limits are enforced inside
 * `./semantic-assistant` and are not repeated here.
 */
const MAX_AI_RELATIONSHIP_DOCUMENTS = 8;

/** Most documents a cross-document payload carries. One request per pass per analysis run. */
const MAX_AI_SYNTHESIS_DOCUMENTS = 20;

/**
 * Wall-clock ceiling on one case's suggestion run.
 *
 * The passes below are fire-and-forget, and until this existed nothing bounded how long they
 * could run for. The arithmetic: `requestGroqJson` walks a three-model chain twice per model
 * and gives each attempt its own 45-second timeout, so a single request can spend about 270
 * seconds before it concludes that nothing is answering. A full run issues up to
 * `MAX_AI_RELATIONSHIP_DOCUMENTS` relationship requests and four synthesis requests, in
 * sequence — close to an hour of a device holding the radio open against a provider that
 * stopped answering in the first minute, with no handle anywhere in the app to stop it.
 *
 * Six minutes, chosen against the healthy case rather than the broken one. A run where every
 * request is answered on its first attempt costs a few seconds per relationship document and
 * some tens of seconds per synthesis pass — three minutes for a large case — so this leaves
 * the working path roughly double the room it needs while cutting the pathological path by an
 * order of magnitude.
 *
 * Reaching it does not discard work. The deadline arrives as a cancelled request, `filePass`
 * reads that the way it reads any other dead radio, and everything filed up to that point is
 * committed on the way out. A case that ran out of budget has fewer suggestions than it might
 * have had; it does not have none.
 */
export const CASE_AI_BUDGET_MS = 6 * 60_000;

/**
 * What a user is told when the deadline above is what stopped their run.
 *
 * Written here rather than taken from the transport, because the transport cannot tell the
 * budget apart from a user walking away and says *"Cancelled."* for both. A reading that
 * came back short for a reason of the app's own making says so, and says what it means for
 * the suggestions underneath it.
 */
const RAN_OUT_OF_TIME =
  'The reading had not finished when its time ran out, so it covers fewer documents than it would have. Run it again to continue further.';

/**
 * The controller for each case's in-flight suggestion run.
 *
 * Keyed by case rather than held per call because whatever wants to stop a run is never the
 * caller that started one: `requestCaseAnalysis` fires this with `void` and returns, so the
 * promise is unreachable by the time a user has walked away from the screen. The case id is
 * the one handle both sides have.
 *
 * Superseding rather than racing is a fix as much as a precaution. Two runs on one case both
 * reach the commit at the end and each files its own suggestion records, so tapping analyse
 * twice used to fill the panel with every finding in it twice.
 */
const inFlightSuggestions = new Map<string, AbortController>();

/**
 * Stops the suggestion run for a case, if one is going.
 *
 * Does nothing for a case with no run, which is the ordinary state and the reason it reports
 * nothing back: a caller on an unmount path should not have to know whether there was
 * anything to stop before it is allowed to ask.
 */
export function cancelCaseAiSuggestions(caseId: string): void {
  inFlightSuggestions.get(caseId)?.abort();
}

/**
 * The provider the AI passes send to, or `null` when AI is off.
 *
 * Chosen from what the user actually stored a key for, in the registry's own order
 * (Groq before xAI), and passed explicitly on every request. The transport's
 * `'groq'` default exists for legacy callers; a consumer that let it stand would route
 * an xAI user's requests to a provider whose key they never entered.
 */
async function preferredChatProvider(): Promise<ChatProvider | null> {
  const { configuredProviders } = await import('./credentials');
  const configured = (await configuredProviders()).filter(
    (provider): provider is ChatProvider => provider !== 'gemini',
  );
  return configured.length > 0 ? (configured[0] ?? null) : null;
}

/**
 * The optional AI reading of one freshly extracted document, persisted for review.
 *
 * Runs after the extraction and its job record are safely committed, fire-and-forget:
 * the processing receipt does not wait for it, and a document is no less processed for
 * its absence. Nothing here can reject - every failure, from no key configured to a
 * refused request to a commit that bounces, leaves the case exactly as the
 * deterministic path left it. The suggestion documents surface through the workspace
 * watchers when they land; this pass never touches the UI.
 *
 * What is stored is verified before it is stored. `toSuggestedFields` in
 * `./provenance` re-derives every ISO date and minor-unit amount with the deterministic
 * normalizers and drops any value whose span is not present in the source text, so a
 * suggestion carries only candidates a person could find in the document themselves.
 */
async function runEvidenceAiSuggestions(context: ProcessingContext, evidence: Evidence): Promise<void> {
  try {
    const provider = await preferredChatProvider();
    if (!provider) return; // AI is off. An off state, not an error: no record is written.

    const { analyzeEvidenceWithAI } = await import('./semantic-assistant');
    const result = await analyzeEvidenceWithAI(evidence, { provider });
    if (!result.ok) return;

    const { toSuggestedFields, aiSuggestionRecord } = await import('./provenance');
    const sourceText = evidence.extraction?.sourceText;
    const fields = toSuggestedFields(result.data, {
      evidenceId: evidence.id,
      model: result.model,
      promptVersion: result.promptVersion,
      ...(sourceText !== undefined ? { sourceText } : {}),
    });

    const record = aiSuggestionRecord({
      ownerId: context.ownerId,
      caseId: evidence.caseId,
      evidenceId: evidence.id,
      kind: 'FIELD_EXTRACTION',
      model: result.model,
      promptVersion: result.promptVersion,
      summary:
        `AI reading of "${evidence.title.slice(0, 80)}": ${result.data.documentType}. ` +
        `Verified against the text: ${fields.dates.length} date(s), ${fields.amounts.length} amount(s), ` +
        `${fields.identifiers.length} reference(s), ${fields.people.length + fields.organizations.length} name(s)` +
        (fields.discarded > 0
          ? `. ${fields.discarded} candidate value(s) were not found in the text and were discarded.`
          : '.'),
      payload: {
        documentType: result.data.documentType,
        refinedTitle: result.data.refinedTitle ?? null,
        modelSummary: result.data.summary,
        disputeRisk: result.data.disputeRisk,
        riskExplanation: result.data.riskExplanation,
        dates: fields.dates,
        amounts: fields.amounts,
        identifiers: fields.identifiers,
        people: fields.people,
        organizations: fields.organizations,
        discarded: fields.discarded,
      },
      sourceEvidenceIds: [evidence.id],
      now: Date.now(),
    });

    const { put } = await import('@data/repository');
    await context.repository.commit(context.ownerId, [put('aiSuggestions', record)]);
  } catch {
    // An optional pass must never take anything down with it. No job record and no error
    // surface: the honest outcome of a failed AI pass is that no suggestion appears.
  }
}

/**
 * The case-level AI pass: the four questions the rule engine cannot answer.
 *
 * Starts only after the deterministic report and its job record are committed, so
 * nothing about the assessment a user reads depends on it. Same discipline as the
 * evidence pass: it never rejects, and its entire output is reviewable suggestion
 * records.
 *
 * ## What this pass used to do, and why it changed
 *
 * It asked the model for a narrative summary of the dispute — an executive summary, a
 * readable account of the case. That output was plausible, fluent, and worth nothing: it
 * restated to the user what the user had just typed in, beside a deterministic report
 * that had actually examined the documents. Meanwhile
 * `reconcileDocumentsWithAI`, `analyzeMissingInformationWithAI`,
 * `assessSupportStrengthWithAI` and `assessTimelineCoherenceWithAI` — the four functions
 * that do the work this product exists for — were fully written, individually tested, and
 * called from nowhere in the codebase.
 *
 * So the pass now runs those four, and the synthesis is gone. The questions they answer
 * are the ones a person with a folder of documents actually has:
 *
 * - **Reconciliation** — where do these documents disagree, and what does each one say?
 * - **Support strength** — which of my claims do the documents actually carry, and on what?
 * - **Missing information** — what would I need that I do not have?
 * - **Timeline coherence** — can all these dates be true at the same time?
 *
 * None of them is a summary and none of them is a verdict. Every assertion each one
 * returns has already been put through `verifyCitations` inside `./semantic-assistant`:
 * a quote that is not present in the cited document at the offsets claimed is dropped,
 * an assertion left with no verifiable citation is dropped with it, and a graded state
 * its own surviving citations cannot carry is weakened. What reaches this function is
 * therefore only what could be quoted back to the user from their own documents, which
 * is the entire basis on which it is allowed on screen.
 *
 * Relationship proposals are still checked against the ids actually present in the case
 * before they are stored — a model can return a plausible id for a claim that was never
 * there, and persisting it would create a suggestion nobody can act on.
 */
/**
 * Exported for tests, which is the only reason it is not private.
 *
 * The production call site below is `void runCaseAiSuggestions(...)` — fire-and-forget, so
 * the deterministic assessment returns the moment it is saved rather than waiting on a
 * model. That also means a test has no promise to await and no deterministic point at
 * which to assert, so the four passes below were never covered by anything. Awaiting the
 * function directly is the honest way to test it; racing the floating promise is not.
 */
export async function runCaseAiSuggestions(
  context: ProcessingContext,
  caseId: string,
  options?: {
    /** Caller cancellation, combined with the budget below rather than replacing it. */
    signal?: AbortSignal;
    /** Overrides `CASE_AI_BUDGET_MS`. Tests set it low; nothing in the app passes it. */
    budgetMs?: number;
  },
): Promise<void> {
  // Supersede whatever was already running for this case. See `inFlightSuggestions`.
  inFlightSuggestions.get(caseId)?.abort();
  const controller = new AbortController();
  inFlightSuggestions.set(caseId, controller);

  // A new attempt invalidates the last one's ending before this one's is known, rather than
  // after it succeeds: an old failure left standing over a run in flight is the same false
  // statement `./run-outcome` exists to remove, only pointing the other way.
  clearAiRunFailure(caseId);

  /**
   * Set by the deadline and read by `noteStop`, because an abort is the one thing the
   * transport cannot describe.
   *
   * `groq-client` reports every aborted signal as a `network` failure whose message reads
   * *"Cancelled."* — so without this flag the run that ran out of time and the run the user
   * abandoned are the same event, and this file would have to either report both or neither.
   */
  let budgetExpired = false;
  const deadline = setTimeout(() => {
    budgetExpired = true;
    controller.abort();
  }, options?.budgetMs ?? CASE_AI_BUDGET_MS);
  const onCallerAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onCallerAbort);
  // Every model call below reads this one signal, so the three reasons a run can end — the
  // budget, the caller, a newer run for the same case — are indistinguishable downstream.
  // They should be: each of them means the same thing to a request in flight.
  const { signal } = controller;

  /**
   * Files the reason a run is stopping, when there is still anyone to tell.
   *
   * Two guards, and each closes a way this could lie. The first is `isCurrentRun`: a
   * superseded run outlives the run that replaced it — its request only rejects once the
   * abort lands — and without the check it would write its own ending over a live attempt's.
   * The second is the abort: a caller who left the screen made a decision, not a fault, and
   * a notice about it would be raised on a screen nobody is on. A budget that expired is
   * reported, and is the reason the two are told apart at all.
   */
  const noteStop = (reason: AIFailureReason, message: string): void => {
    if (inFlightSuggestions.get(caseId) !== controller) return;
    if (signal.aborted && !budgetExpired) return;
    recordAiRunFailure(
      caseId,
      budgetExpired ? 'timed-out' : reason,
      budgetExpired ? RAN_OUT_OF_TIME : message,
    );
  };

  try {
    const provider = await preferredChatProvider();

    const workspace = await context.repository.loadWorkspace(context.ownerId, caseId);
    const caseRecord = workspace.cases.find((item) => item.id === caseId && !item.deletedAt);
    if (!caseRecord) return;

    const claims = workspace.claims.filter((item) => item.caseId === caseId && !item.deletedAt);
    const events = workspace.events.filter((item) => item.caseId === caseId && !item.deletedAt);
    const readable = workspace.evidence.filter(
      (item) => item.caseId === caseId && !item.deletedAt && (item.extraction?.segments.length ?? 0) > 0,
    );
    // Two documents are enough on their own: reconciliation asks what they say about each
    // other and needs nothing typed in. One document is only worth a request if there is a
    // claim or an event to assess it against. The old guard demanded a claim or an event in
    // every case, which turned away the most ordinary situation this product has — someone
    // who has photographed two receipts and not yet written a word.
    const enoughToAsk = readable.length >= 2 || (readable.length >= 1 && (claims.length > 0 || events.length > 0));
    if (!enoughToAsk) return;

    const { put } = await import('@data/repository');
    const {
      suggestCaseRelationshipsWithAI,
      reconcileDocumentsWithAI,
      analyzeMissingInformationWithAI,
      assessSupportStrengthWithAI,
      assessTimelineCoherenceWithAI,
      buildDeterministicReconciliation,
      buildDeterministicTimelineCoherence,
    } = await import('./semantic-assistant');
    const { aiSuggestionRecord, decidedSuggestionIds, ON_DEVICE_ENGINE, ON_DEVICE_ENGINE_VERSION } = await import('./provenance');
    const changes: Change[] = [];

    const claimStatements = new Map(claims.map((claim) => [claim.id, claim.statement]));
    const eventTitles = new Map(events.map((event) => [event.id, event.title]));

    /**
     * Documents to propose relationships for.
     *
     * Empty when no model is connected: deciding that a receipt *supports* a particular claim
     * is a judgement about what both of them mean, and nothing on the device can make it. The
     * two cross-document passes further down are different — comparing two amounts in the same
     * currency is arithmetic — so those still run. See `ON_DEVICE_ENGINE`.
     */
    const relationshipCorpus = provider ? readable.slice(0, MAX_AI_RELATIONSHIP_DOCUMENTS) : [];

    for (const item of relationshipCorpus) {
      // Unreachable — the list above is empty without a provider — but it is what narrows
      // `provider` to non-null for the call below, and it costs one comparison per document.
      if (!provider) break;
      const result = await suggestCaseRelationshipsWithAI(item, claims, events, { provider, signal });
      if (!result.ok) {
        // A failure about the account or the connection will not heal between documents;
        // stop rather than spend the user's quota hammering a dead radio. A
        // document-scoped failure (a reply that failed its schema) says nothing about
        // the next document, so the pass continues.
        if (result.reason === 'unavailable' || result.reason === 'rate_limited' || result.reason === 'network') {
          noteStop(result.reason, result.error);
          break;
        }
        continue;
      }

      for (const suggestion of result.data.suggestions) {
        const target =
          suggestion.targetKind === 'claim'
            ? claimStatements.get(suggestion.targetId)
            : suggestion.targetKind === 'event'
              ? eventTitles.get(suggestion.targetId)
              : undefined;
        // An id that resolves to nothing in this case is a dangling reference, not a
        // proposal; a suggestion attached to it could never be reviewed.
        if (target === undefined) continue;

        changes.push(
          put(
            'aiSuggestions',
            aiSuggestionRecord({
              ownerId: context.ownerId,
              caseId,
              evidenceId: item.id,
              kind: 'RELATIONSHIP',
              model: result.model,
              promptVersion: result.promptVersion,
              summary: `Connect "${item.title.slice(0, 60)}" to ${
                suggestion.targetKind === 'claim' ? 'claim' : 'event'
              } "${target.slice(0, 80)}" as ${suggestion.relationshipType}.`,
              payload: { ...suggestion },
              sourceEvidenceIds: [item.id],
              confidence: suggestion.confidence,
              // The proposal, not the wording of it: this document, that claim or event,
              // that relationship type. A second run proposing the same connection writes
              // the same row rather than a second copy of it.
              identity: [
                caseId,
                item.id,
                suggestion.targetKind,
                suggestion.targetId,
                suggestion.relationshipType,
              ],
              now: Date.now(),
            }),
          ),
        );
      }
    }

    const corpus = readable.slice(0, MAX_AI_SYNTHESIS_DOCUMENTS);

    /**
     * Files one pass's output, and reports whether the rest are still worth attempting.
     *
     * The four passes are independent questions, so a reply that failed its schema on one
     * says nothing about the next and the pass continues. A failure about the account or
     * the radio will not heal between requests, and three more attempts would spend the
     * user's quota to print the same error three more times — so those stop the sequence.
     *
     * `describe` returns null when the pass succeeded but found nothing worth a record.
     * That is a real and common outcome — a two-document case where everything agrees has
     * no reconciliation to report — and storing an empty suggestion for it would train the
     * user to scroll past the panel that matters.
     */
    const filePass = async <T>(
      kind: AISuggestionKind,
      run: () => Promise<AIResult<T>>,
      describe: (data: T) => { summary: string; payload: Record<string, unknown> } | null,
    ): Promise<'continue' | 'stop'> => {
      const result = await run();
      if (!result.ok) {
        if (result.reason === 'unavailable' || result.reason === 'rate_limited' || result.reason === 'network') {
          noteStop(result.reason, result.error);
          return 'stop';
        }
        return 'continue';
      }

      const described = describe(result.data);
      if (!described) return 'continue';

      changes.push(
        put(
          'aiSuggestions',
          aiSuggestionRecord({
            ownerId: context.ownerId,
            caseId,
            evidenceId: null,
            kind,
            model: result.model,
            promptVersion: result.promptVersion,
            // Bounded here as well as by the schema: a `summary` is a line in a list, and
            // one that runs to a paragraph pushes the next finding off the screen.
            summary: described.summary.slice(0, 600),
            payload: described.payload,
            sourceEvidenceIds: corpus.map((item) => item.id),
            // One answer per question per case. "Where do these documents disagree" has a
            // single current answer, and a re-run after the user fixes a misread should
            // replace it rather than stack a second reconciliation above the first.
            //
            // The corpus is deliberately not part of the key. Adding a document changes what
            // the answer says, not which question it answers, and keying on the document set
            // would leave the pre-upload answer behind as a second card that still claims to
            // describe the case.
            identity: [caseId, kind],
            now: Date.now(),
          }),
        ),
      );
      return 'continue';
    };

    /**
     * How many citations a pass could not stand behind, phrased for a person.
     *
     * Appended to every summary that has one, because a panel that shows only what
     * survived verification and never mentions what did not is quietly claiming a
     * precision it does not have.
     */
    const dropped = (audit: CitationAudit): string =>
      audit.droppedAssertions > 0
        ? ` ${audit.droppedAssertions} further statement${audit.droppedAssertions === 1 ? '' : 's'} ` +
          `could not be traced back to a document and ${audit.droppedAssertions === 1 ? 'was' : 'were'} discarded.`
        : '';

    /**
     * Wraps an on-device result in the shape `filePass` files.
     *
     * `durationMs: 0` because nothing was waited on. The provenance fields are the point: the
     * stored record says the device produced this, and the panel reads that to show the
     * on-device reading mark rather than the violet AI stamp.
     */
    const onDevice = <T,>(data: T): AIResult<T> => ({
      ok: true,
      data,
      model: ON_DEVICE_ENGINE,
      promptVersion: ON_DEVICE_ENGINE_VERSION,
      durationMs: 0,
    });

    // Reconciliation first: what the documents say about each other is the ground the
    // other three stand on, and it needs no claims — a user who has uploaded two receipts
    // and typed nothing still gets an answer. With no key connected it still runs, on the
    // device: shared identifiers are string equality and amounts in one currency are
    // arithmetic, so the comparison is available whether or not a model is.
    let outcome = await filePass(
      'CROSS_DOCUMENT_RECONCILIATION',
      () =>
        provider
          ? reconcileDocumentsWithAI(corpus, { provider, signal })
          : Promise.resolve(onDevice(buildDeterministicReconciliation(corpus))),
      (data) => {
        if (data.facts.length === 0 && data.unreconciled.length === 0) return null;

        /*
          The disagreement lives in `facts`, never in `unreconciled`.

          This line read `const disagreements = data.unreconciled.length`, and that field is
          the opposite of a disagreement under both producers: the prompt defines it as
          "something this document records that no other document touches at all", and
          `buildDeterministicReconciliation` fills it with documents that carry no amount,
          date or reference to compare. So the one sentence a user ever reads about their
          documents conflicting was wrong in both directions — an unreadable photograph was
          announced as "1 value does not match", and a case where every fact came back
          `DISAGREE` fell through to "the readings agree", which is this product reporting
          the conflict it exists to find as its absence.

          `NOTATION_ONLY` is deliberately not counted: "₹1,50,000" against "1.5 lakh" is the
          same value written twice, and the prompt requires it to be reported instead of a
          disagreement.
        */
        const disagreeing = data.facts.filter(
          (fact) => fact.agreement === 'DISAGREE' || fact.agreement === 'PARTIAL',
        );
        const corroborated = data.facts.filter((fact) => fact.agreement === 'ALL_AGREE');

        /*
          Said separately, and never as agreement. A fact only one document records is
          `SINGLE_SOURCE`, and counting it under "the readings agree" is the false
          corroboration `reconcileDocumentsWithAI` collapses a fact to avoid — undone here
          if this sentence claimed a cross-check that never happened.
        */
        const unmatched = data.unreconciled.length;
        const alone =
          unmatched > 0
            ? ` ${unmatched} further observation${unmatched === 1 ? '' : 's'} could not be matched ` +
              `to anything in the other documents.`
            : '';

        const headline =
          disagreeing.length > 0
            ? `${disagreeing.length} value${disagreeing.length === 1 ? '' : 's'} ` +
              `${disagreeing.length === 1 ? 'does' : 'do'} not match across your documents, with each ` +
              `reading quoted from its own source.`
            : corroborated.length > 0
              ? `Cross-checked ${corroborated.length} value${corroborated.length === 1 ? '' : 's'} across ` +
                `${corpus.length} documents; the readings agree.`
              : `Nothing in these ${corpus.length} documents could be checked against another document: ` +
                `${data.facts.length} value${data.facts.length === 1 ? ' is' : 's are'} recorded, each by ` +
                `one source only.`;

        return { summary: headline + alone + dropped(data.audit), payload: { ...data } };
      },
    );

    if (outcome === 'continue' && claims.length > 0 && provider) {
      outcome = await filePass(
        'SUPPORT_STRENGTH',
        () => assessSupportStrengthWithAI(claims, corpus, { provider, signal }),
        (data) => {
          if (data.assessments.length === 0) return null;
          const reason = data.overallReason.trim();
          return {
            summary:
              `How well the documents carry your ${data.assessments.length} claim` +
              `${data.assessments.length === 1 ? '' : 's'}` +
              // `overallReason` carries `.default('')` in the schema, so a model that omits
              // the field left this line ending in a bare colon with nothing after it. Saying
              // that the model said nothing is the same move the panel already makes for one
              // that reports no confidence.
              (reason ? `: ${reason}` : '. It returned no overall reason.') +
              dropped(data.audit),
            payload: { ...data },
          };
        },
      );
    }

    // Both of these read what a claim *means* against what a document says, which is the one
    // thing the device cannot do. Skipped rather than approximated when no model is connected.
    if (outcome === 'continue' && claims.length > 0 && provider) {
      outcome = await filePass(
        'MISSING_INFORMATION',
        () => analyzeMissingInformationWithAI(claims, corpus, { provider, signal }),
        (data) =>
          data.gaps.length === 0
            ? null
            : {
                summary:
                  `${data.gaps.length} specific thing${data.gaps.length === 1 ? '' : 's'} your case does not ` +
                  `have yet.` +
                  (data.discardedAsGeneric > 0
                    ? ` ${data.discardedAsGeneric} vaguer suggestion${data.discardedAsGeneric === 1 ? '' : 's'} ` +
                      `${data.discardedAsGeneric === 1 ? 'was' : 'were'} dropped for being unactionable.`
                    : '') +
                  dropped(data.audit),
                payload: { ...data },
              },
      );
    }

    if (outcome === 'continue') {
      await filePass(
        'TIMELINE_COHERENCE',
        () =>
          provider
            ? assessTimelineCoherenceWithAI(corpus, events, { provider, signal })
            : Promise.resolve(onDevice(buildDeterministicTimelineCoherence(corpus))),
        (data) => {
          /*
            A problem is a finding whether or not anything survived into the sequence.

            The guard was `data.sequence.length === 0`, which threw away the whole pass when
            the sequence was empty — and the two ways that happens are both cases the reader
            most needs to hear about. On the device, documents that carry no resolvable date
            produce `UNDATED_FACT` problems and no sequence at all, so a case whose dates are
            entirely unreadable was told nothing. Through a model, an `IMPOSSIBLE_ORDER` can
            outlive the sequence entries when those entries lose their citations, and
            discarding a verified contradiction because the list it sat above came back empty
            is exactly the wrong way round.
          */
          if (data.sequence.length === 0 && data.problems.length === 0) return null;

          const dated = data.sequence.filter((entry) => entry.dateIso !== null).length;
          const reason = data.coherenceReason.trim();
          const headline =
            data.problems.length > 0
              ? `${data.problems.length} problem${data.problems.length === 1 ? '' : 's'} in the order of ` +
                // `coherenceReason` carries `.default('')` like `overallReason` does, so a
                // model that omits it left this ending in a bare colon. The deterministic
                // builder always writes one, so this only ever bites on the model path.
                `events${reason ? `: ${reason}` : '. It did not say which dates.'}`
              : dated > 0
                ? `Checked ${dated} dated fact${dated === 1 ? '' : 's'} against each other; the sequence holds.`
                : // An entry the normalizer refused has no position, so a sequence made only of
                  // those establishes no order at all. "The sequence holds" over nothing dated
                  // would be the app reporting a check it never performed.
                  `No date in these ${corpus.length} documents could be resolved, so the order of ` +
                  `events could not be checked.`;

          return { summary: headline + dropped(data.audit), payload: { ...data } };
        },
      );
    }

    /*
      A decision a person already made survives the run that would have undone it.

      Every record above now carries a deterministic id, so a second analysis of the same case
      reaches the same id for the same proposal instead of minting a new one — which is what
      stops `aiSuggestions` growing by a full set on every run. The cost of that, unguarded, is
      that a plain `put` overwrites: a proposal the user accepted comes back as `SUGGESTED`
      with its acceptance gone, and one they rejected is pushed back to the top of the panel
      after every single analysis, where the sort puts open proposals first. The user would
      have to dismiss the same suggestion forever.

      Filtered here rather than at each `put` because the reason is one reason, and because
      `decidedSuggestionIds` is the same guard `runDirectCaseAnalysis` applies to its own pass.
    */
    const decided = decidedSuggestionIds(workspace.aiSuggestions);
    const writable = changes.filter(
      (change) =>
        !(change.op === 'put' && change.collection === 'aiSuggestions' && decided.has(change.record.id)),
    );

    if (writable.length > 0) await context.repository.commit(context.ownerId, writable);
  } catch (error) {
    // The deterministic assessment above is already complete and saved, so this still fails
    // towards silence in the only sense that matters — nothing that was written is
    // withdrawn. What it must not do is fail *invisibly*. An unclassified throw here used to
    // leave the panel showing "Nothing here yet" over a run that had died, with nothing
    // anywhere saying that it had.
    //
    // An abort is excluded. It reaches the passes as a classified network failure, which has
    // already filed the real reason, and filing it again here as a crash would report a
    // decision this function made as a defect.
    if (!signal.aborted) recordAiRunFailure(caseId, 'unexpected', safeFailureMessage(error));
  } finally {
    clearTimeout(deadline);
    options?.signal?.removeEventListener('abort', onCallerAbort);
    // Only if the entry is still this run's. A newer run has already replaced it, and
    // deleting it here would leave that one uncancellable for the rest of its life.
    if (inFlightSuggestions.get(caseId) === controller) inFlightSuggestions.delete(caseId);
  }
}

/**
 * Analyses a case and records the job.
 *
 * The second parameter is optional, so the existing one-argument call sites keep working
 * unchanged. It is not a network request and never was able to be one; the name is kept
 * because five screens import it. Passing a context is better than omitting it — the
 * repository in it is the one the caller's subscriptions watch, so the report a run writes
 * shows up on screen without an explicit reload.
 */
export async function requestCaseAnalysis(
  caseId: string,
  context?: ProcessingContext,
): Promise<ProcessingReceipt> {
  idSchema.parse(caseId);
  const startedAt = Date.now();

  try {
    const resolved = await resolveContext(context);
    const { put } = await import('@data/repository');

    let report: CaseAnalysis;
    try {
      report = await runDirectCaseAnalysis(resolved.repository, resolved.ownerId, caseId);
    } catch (error) {
      // The failure is persisted before it is rethrown. `case-analysis-panel.tsx` renders
      // `latestJob.lastError` for a FAILED job, which until now nothing ever wrote, so a
      // user who left the screen mid-run had no record that anything had been attempted.
      const failed = await jobRecord({
        ownerId: resolved.ownerId,
        caseId,
        type: 'CASE',
        evidenceId: null,
        state: 'FAILED',
        startedAt,
        lastError: safeFailureMessage(error),
        resultPath: null,
        completedSteps: [],
      });
      await resolved.repository.commit(resolved.ownerId, [put('processingJobs', failed)]);
      throw error;
    }

    const job = await jobRecord({
      ownerId: resolved.ownerId,
      caseId,
      type: 'CASE',
      evidenceId: null,
      state: 'ANALYZED',
      startedAt,
      lastError: null,
      // Where the result is, so the job names something a reader can open rather than
      // asserting that work happened.
      resultPath: `caseAnalyses/${report.id}`,
      completedSteps: ['extract', 'rules', 'report'],
    });
    await resolved.repository.commit(resolved.ownerId, [put('processingJobs', job)]);

    // The optional AI pass starts only once the deterministic report is saved, and the
    // receipt below reports the deterministic outcome alone. `void` because the pass
    // catches everything itself: nothing awaiting it can be told anything by its failure.
    void runCaseAiSuggestions(resolved, caseId);

    return receiptSchema.parse({ jobId: job.id, state: job.state, failureReason: job.lastError });
  } catch (error) {
    throw processingError(error);
  }
}

/**
 * Reads one evidence item's contents on this device and records the result.
 *
 * Reached from the upload screen and from the Process/Reprocess button on an evidence
 * page. What happens depends on what the item is:
 *
 * - A typed note → extracted from its own text, by the same deterministic extractor the
 *   ingestion path uses.
 * - A file with a stored original → the original is opened from the evidence store and
 *   read by `@services/ingestion`: OCR for images, the PDF text layer, the CSV/EML/text
 *   parsers, transcription for audio and video (which needs the user's own Groq key —
 *   without one the item is stored, flagged for review with the reason, and never faked).
 *   The bytes are re-hashed on the way past and checked against the digest recorded at
 *   store time, so an analysis of a substituted or corrupted file is refused, not run.
 * - A file with no stored original → `FAILED`, saying so. This is the honest outcome for
 *   a record whose upload never completed or that was written by a build before files
 *   were stored at all.
 *
 * Reprocessing an already-extracted item re-reads the original and replaces the machine
 * extraction. `confirmedFields` survive untouched — they layer over whatever extraction
 * is present at read time (`effectiveExtraction`), which is the separation the model was
 * built around — and a CONFIRMED item stays confirmed, because the corrections still
 * apply to the fresh extraction.
 */
export async function requestEvidenceProcessing(
  caseId: string,
  evidenceId: string,
  context?: ProcessingContext,
): Promise<ProcessingReceipt> {
  idSchema.parse(caseId);
  idSchema.parse(evidenceId);
  const startedAt = Date.now();

  try {
    const resolved = await resolveContext(context);
    const { put } = await import('@data/repository');
    const { persistEvidenceExtraction } = await import('@data/mutations');
    const workspace = await resolved.repository.loadWorkspace(resolved.ownerId, caseId);
    const item = workspace.evidence.find((e) => e.id === evidenceId && e.caseId === caseId && !e.deletedAt);
    if (!item) throw new ProcessingRequestError('not-found', 'That evidence item is no longer in this case.');

    const outcome = await processEvidenceItem(item, resolved.ownerId);
    const mutation = persistEvidenceExtraction(
      workspace,
      { ownerId: resolved.ownerId, now: Date.now() },
      evidenceId,
      outcome.input,
    );

    // The job reports the record as the mutation left it, because the same commit writes
    // both: the job can never claim a state the evidence does not have.
    const updated = mutation.workspace.evidence.find((e) => e.id === evidenceId);
    const job = await jobRecord({
      ownerId: resolved.ownerId,
      caseId,
      type: 'EVIDENCE',
      evidenceId,
      state: updated?.state ?? outcome.input.state,
      startedAt,
      lastError: updated?.failureReason ?? null,
      resultPath: null,
      completedSteps: [...outcome.completedSteps],
    });
    await resolved.repository.commit(resolved.ownerId, [...mutation.changes, put('processingJobs', job)]);

    // The optional AI reading of what was just extracted rides along behind the commit:
    // fire-and-forget, so a slow or absent model never delays the upload flow's receipt,
    // and discarded entirely on any failure. Only an item that actually has readable
    // passages is worth a model's attention - the same bar the case analysis applies.
    if (updated?.extraction && updated.extraction.segments.length > 0) {
      void runEvidenceAiSuggestions(resolved, updated);
    }

    return receiptSchema.parse({ jobId: job.id, state: job.state, failureReason: job.lastError });
  } catch (error) {
    throw processingError(error);
  }
}

/**
 * Said once, in one place, because the report limitations and the evidence screen both
 * report it. What it states is narrower than it used to be: files *are* read on this
 * device now, and a source still ends up here only when its bytes are absent or its
 * content is genuinely unreadable — never because processing was never attempted.
 */
const EXCLUDED_NO_TEXT =
  'It has no readable text on this device — a scanned or unsupported file, a recording that was not transcribed, ' +
  'or an original that never finished uploading — so nothing in it could be compared. Open the source from the ' +
  'evidence list to see exactly why and what can be done.';

/** Fixed sentences for the outcomes that are about the file, not the extraction. */
const NEVER_STORED =
  'The original file for this source was never stored, so there is nothing to read. Add the file to the case again.';

/** What a hash mismatch means, and the only action that fixes it. */
const HASH_MISMATCH =
  'The stored file does not match the fingerprint recorded when it was saved, so it may have been changed on this ' +
  'device since it was added. Remove this source and add the original file again.';

/**
 * What one processing attempt did to one evidence item.
 *
 * `input` is the `persistEvidenceExtraction` payload — the honest outcome, whatever it
 * was — and `completedSteps` names the work a job record can claim actually ran.
 */
interface EvidenceProcessingOutcome {
  input: ExtractionOutcomeInput;
  completedSteps: readonly string[];
}

/**
 * Reads the item's contents, or reports precisely why it could not be read.
 *
 * Never throws: every failure is returned as an outcome the mutation layer can persist,
 * because a file that cannot be read is still evidence, and "we could not read it, here
 * is why" is a fact about the case worth keeping.
 */
async function processEvidenceItem(item: Evidence, ownerId: string): Promise<EvidenceProcessingOutcome> {
  // A typed statement's content is the note itself; there is no file to open.
  if (item.kind === 'NOTE') {
    const extracted = await extractLocally(item);
    return extracted
      ? { input: { extraction: extracted, state: 'EXTRACTED', failureReason: null }, completedSteps: ['extract'] }
      : {
          input: { extraction: null, state: 'REVIEW_REQUIRED', failureReason: 'This statement has no text to read.' },
          completedSteps: [],
        };
  }

  if (!item.storagePath) {
    return { input: { extraction: null, state: 'FAILED', failureReason: NEVER_STORED }, completedSteps: [] };
  }

  const { readStoredEvidenceFile, isEvidenceFileError } = await import('../storage/evidence-storage');
  let stored: PrivateEvidenceFile;
  try {
    stored = await readStoredEvidenceFile(ownerId, item.storagePath);
  } catch (error) {
    // The read layer's own messages are this app's fixed sentences — a missing original, a
    // path that does not belong to this account — and they say exactly what happened, so they
    // are worth keeping in preference to anything `safeFailureMessage` would substitute.
    //
    // Only the ones it tagged, though. This used to persist `error.message` from whatever came
    // back, and three things reach here that were never written for a reader: IndexedDB's
    // `DOMException` on web, an `expo-file-system` error quoting the absolute file URI, and a
    // `ZodError` from the path validator carrying the rejected id in a JSON blob. `failureReason`
    // is stored on the evidence row and rendered on the analysis panel, so each of those was an
    // identifier on screen. Anything untagged now takes the generic sentence instead.
    return {
      input: {
        extraction: null,
        state: 'FAILED',
        failureReason: isEvidenceFileError(error)
          ? error.message.slice(0, 600)
          : 'The original file could not be read.',
      },
      completedSteps: [],
    };
  }

  try {
    const { ingestFile } = await import('@services/ingestion/ingest');
    const result = await ingestFile({
      uri: stored.uri,
      // `fileName` carries the extension ingestion routes on; `title` is a poorer key but
      // the only fallback for a record that never had a file name.
      name: item.fileName ?? item.title,
      mimeType: item.mimeType,
      size: item.sizeBytes,
    });

    // Ingestion re-hashes the bytes it read, for free, on the way past. Checking them
    // against the digest recorded at store time is what makes "the analysis is of the
    // file that was saved" a claim this app can actually make.
    if (item.sha256 !== null && result.sha256 !== '' && result.sha256 !== item.sha256) {
      return { input: { extraction: null, state: 'FAILED', failureReason: HASH_MISMATCH }, completedSteps: ['read'] };
    }

    if (result.text.trim().length === 0) {
      // The honest "a person needs to look at this": the bytes are stored and hashed, and
      // `result.note` says precisely why nothing could be read — a scanned PDF, a file
      // type this build cannot parse, a recording with no transcription key configured.
      return {
        input: { extraction: null, state: 'REVIEW_REQUIRED', failureReason: result.note.slice(0, 600) },
        completedSteps: ['read'],
      };
    }

    const { extractFromText } = await import('@domain/extraction/deterministic');
    const extraction = extractFromText({
      evidenceId: item.id,
      title: item.title,
      text: result.text,
      method: extractionMethodFor(result.method),
      // The clock positions a transcription produced, so an audio or video citation can
      // name a moment in the recording instead of an offset into text nobody reads.
      // Absent for every source with no clock, per the handoff contract on
      // `IngestResult.timedSegments`.
      ...(result.timedSegments ? { timedSegments: result.timedSegments } : {}),
    });
    return {
      input: {
        // The ingestion note travels with the extraction as a limitation: it is the
        // account of how this text was obtained ("read from pixels — check any figure
        // against the image"), and the evidence screen shows it beside the passages.
        extraction: { ...extraction, limitations: [...extraction.limitations, result.note] },
        state: 'EXTRACTED',
        failureReason: null,
        sha256: result.sha256 || undefined,
        sizeBytes: result.bytes,
      },
      completedSteps: ['read', 'extract'],
    };
  } catch (error) {
    // `ingestFile` reports its own failures in its result rather than throwing, so a
    // throw here is a bug — recorded honestly, without a stack or provider detail.
    return {
      input: { extraction: null, state: 'FAILED', failureReason: safeFailureMessage(error) },
      completedSteps: ['read'],
    };
  } finally {
    await stored.release();
  }
}

/**
 * Translates the ingestion layer's account of how it obtained text into the provenance
 * method the extraction schema carries, so a value's provenance survives the trip.
 *
 * - Characters read exactly out of the file — a PDF's text layer, plain text, a flattened
 *   CSV, a parsed email, an Office document's XML — are `DETERMINISTIC`: the characters
 *   are the document's own.
 * - Text recognised from pixels is `OCR`: a reading of the picture, provisional by nature.
 *   This includes `pdf-page-ocr`, the pass over the page images of a *scanned* PDF. That
 *   one matters more than it looks: the source is a PDF, and a mapping that keyed off the
 *   file type rather than the reading would file a machine's guess at a blurry digit
 *   under the same provenance as characters lifted from the file. The quarantine in
 *   `@domain/rules/provenance` would then never fire for it, and a misread `₹1,500` as
 *   `₹7,500` would raise a confident, fabricated conflict — the single worst failure this
 *   product can have.
 * - A machine transcription of speech is `AI`: inferred from audio by a model, ranked
 *   below both of the above in the provenance precedence, exactly as it should be.
 *
 * Every member is listed explicitly and the default is `OCR`, not `DETERMINISTIC`. The
 * default is the one line here that is a safety decision rather than a translation: a
 * future reading method added to `IngestResult['method']` and forgotten here now fails
 * towards "provisional, ask a human", which costs a confirmation prompt, instead of
 * towards "trusted as the document's own characters", which costs a fabricated accusation.
 *
 * `none` never reaches here — no text, no extraction — but it is listed so the switch is
 * exhaustive over the union rather than relying on the caller's guard.
 */
function extractionMethodFor(method: IngestResult['method']): ExtractedTextMethod {
  switch (method) {
    case 'pdf-text-layer':
    case 'plain-text':
    case 'csv-flatten':
    case 'eml-parse':
    case 'office-xml':
    case 'none':
      return 'DETERMINISTIC';
    case 'audio-transcript':
    case 'video-transcript':
      return 'AI';
    case 'ocr':
    case 'pdf-page-ocr':
      return 'OCR';
    default:
      return 'OCR';
  }
}

/**
 * The text a typed statement carries, or `null`.
 *
 * `note` only — this is the NOTE path of processing. A file's text comes from
 * `processEvidenceItem` reading the stored original, never from here. Falling back to
 * `fileName` or `title` — which an earlier version did — turns "receipt.pdf" into a
 * document body, and then a claim gets cited to it.
 */
async function extractLocally(item: Evidence): Promise<Extraction | null> {
  const text = item.note?.trim() ?? '';
  if (text.length === 0) return null;
  const { extractFromText } = await import('@domain/extraction/deterministic');
  return extractFromText({
    evidenceId: item.id,
    title: item.title,
    text,
    // A typed note was read verbatim from what the user wrote; nothing recognised it from
    // pixels. `MANUAL` is not one of the extractor's methods — it describes a *confirmed*
    // field, not a text source — so `DETERMINISTIC` is the accurate one here.
    method: 'DETERMINISTIC',
  });
}

/** Tokens long enough that their presence in a document is worth reporting at all. */
const MIN_TOKEN_LENGTH = 5;

/** Words that would otherwise make every claim look related to every document. */
const CLAIM_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between', 'could',
  'never', 'other', 'should', 'their', 'there', 'these', 'those', 'through', 'until',
  'where', 'which', 'while', 'would', 'claim', 'claims', 'stated', 'states',
]);

/** Content tokens of a claim statement, lowercased and deduplicated. */
function claimTokens(statement: string): string[] {
  const tokens = statement.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return [...new Set(tokens.filter((t) => t.length >= MIN_TOKEN_LENGTH && !CLAIM_STOPWORDS.has(t)))];
}

/**
 * The first segment whose own text contains `needle`, or `null`.
 *
 * The point of looking rather than taking `segments[0]`: a citation exists so a person can
 * check it. Quoting the first line of a chat export while claiming it evidences something
 * said forty lines later is a citation that fails on inspection, which is worse than no
 * citation because it looks like one.
 */
function segmentContaining(evidence: Evidence, needle: string): Extraction['segments'][number] | null {
  const lowered = needle.toLowerCase();
  for (const segment of evidence.extraction?.segments ?? []) {
    if (segment.text.length > 0 && segment.text.toLowerCase().includes(lowered)) return segment;
  }
  return null;
}

/** A segment to cite when a rule named this document but no single line carries the point. */
function firstSegment(evidence: Evidence): Extraction['segments'][number] | null {
  for (const segment of evidence.extraction?.segments ?? []) {
    if (segment.text.trim().length > 0) return segment;
  }
  return null;
}

/**
 * Builds a citation whose offsets bound the quoted characters.
 *
 * `caseCitationSchema` refuses `endOffset <= startOffset`, and the offsets are what the
 * evidence viewer highlights, so a quote that has been truncated must narrow its span to
 * match rather than keep the whole segment's.
 */
function cite(
  evidence: Evidence,
  segment: Extraction['segments'][number],
  stance: CaseCitation['stance'],
  maxChars: number,
): CaseCitation | null {
  const quote = segment.text.slice(0, Math.min(maxChars, segment.text.length)).trim();
  if (quote.length === 0) return null;
  return {
    evidenceId: evidence.id,
    segmentId: segment.id,
    quote,
    startOffset: segment.startOffset,
    endOffset: segment.startOffset + quote.length,
    stance,
  };
}

/** Surface forms a document carries, used to say precisely what is absent. */
function surfaceForms(fields: readonly (TextField | DateField | AmountField)[]): string[] {
  return fields.map((field) => field.original.trim()).filter((value) => value.length > 0);
}

/**
 * Names what is missing, in the terms of the claim itself.
 *
 * Runs the deterministic extractor over the claim statement so that "what is missing" can be
 * a specific value — the ₹50,000 the claim asserts, the date it gives, the UTR it quotes —
 * checked against the surface forms every document in the case actually carries. The
 * alternative, and what was here before, was one fixed sentence about providing "a bank
 * statement, payment receipt, or original communication", which is true of every unproven
 * claim ever made and therefore tells the user nothing about theirs.
 *
 * The provenance the extractor stamps on the claim's own values is discarded; only the
 * surface forms are read. A claim is not evidence and nothing derived from it is stored.
 */
async function missingInformationFor(
  claim: Claim,
  evidenceList: readonly Evidence[],
): Promise<string[]> {
  const { extractFromText } = await import('@domain/extraction/deterministic');
  const asserted = extractFromText({
    evidenceId: claim.id,
    title: 'claim',
    text: claim.statement + (claim.detail ? `\n${claim.detail}` : ''),
    method: 'DETERMINISTIC',
  });

  const documented = new Set<string>();
  for (const item of evidenceList) {
    const extraction = item.extraction;
    if (!extraction) continue;
    for (const value of [
      ...surfaceForms(extraction.amounts),
      ...surfaceForms(extraction.dates),
      ...surfaceForms(extraction.transactionIds),
      ...surfaceForms(extraction.invoiceNumbers),
      ...surfaceForms(extraction.orderNumbers),
    ]) {
      documented.add(value.toLowerCase());
    }
  }

  const gaps: string[] = [];
  const absent = (value: string) => !documented.has(value.trim().toLowerCase());

  for (const amount of asserted.amounts) {
    if (absent(amount.original)) {
      gaps.push(`A record showing ${amount.original}. No source in this case carries that figure, so the amount in this claim cannot be checked against anything.`);
    }
  }
  for (const date of asserted.dates) {
    if (absent(date.original)) {
      gaps.push(`A dated line for ${date.original} — a statement entry, a message timestamp or a receipt from that day. No source in this case is dated ${date.original}.`);
    }
  }
  for (const reference of [...asserted.transactionIds, ...asserted.invoiceNumbers, ...asserted.orderNumbers]) {
    if (absent(reference.original)) {
      gaps.push(`The document that carries reference ${reference.original}. The claim quotes it; no source in this case does.`);
    }
  }

  if (gaps.length === 0) {
    // Still specific, and still actionable: it names the property the claim lacks rather
    // than asking for "more evidence".
    gaps.push('A figure, a date or a reference number this claim depends on. As written it states none, so there is no value a document could be matched against.');
  }
  return gaps.slice(0, 40);
}

/**
 * Extracts what can be extracted, evaluates the rules, and saves a cited report.
 *
 * The whole analysis, in one pass, on the device. Kept with its original three-argument
 * signature because `graph.tsx` and `case-analysis-panel.tsx` call it directly.
 */
export async function runDirectCaseAnalysis(
  repository: Repository,
  ownerId: string,
  caseId: string,
): Promise<CaseAnalysis> {
  const { put } = await import('@data/repository');
  const { persistEvidenceExtraction, runCaseAnalysis } = await import('@data/mutations');
  const { newId } = await import('@domain/ids');
  const { caseAnalysisSchema } = await import('@domain/models');

  const workspace = await repository.loadWorkspace(ownerId, caseId);
  const caseRecord = workspace.cases.find((c) => c.id === caseId && !c.deletedAt);
  if (!caseRecord) throw new ProcessingRequestError('not-found', 'Case was not found in your workspace.');

  const claims = workspace.claims.filter((c) => c.caseId === caseId && !c.deletedAt);
  const sources = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);

  /*
    A claim is not required to run this.

    It used to be: this threw unless the case already held one, and a claim is optional at
    case creation — so for the ordinary path (make a case, add three documents, open it)
    the entire deterministic engine was unreachable and the app produced nothing. Most of
    the rules never needed a claim in the first place: a payment-status conflict, a
    mismatched amount, a date that contradicts another date are all properties of the
    *documents*, found by comparing them to each other.

    What is genuinely required is something to read. A case with neither a claim nor a
    source has no input at all, and that is the only state this refuses.
  */
  if (!claims.length && !sources.length) {
    throw new ProcessingRequestError(
      'failed-precondition',
      'Add a document or a written statement to this case before running an analysis.',
    );
  }

  const now = Date.now();
  const changes: Change[] = [];
  const readable: Evidence[] = [];
  const excludedEvidenceIds: string[] = [];

  for (const item of sources) {
    if (item.extraction && item.extraction.segments.length > 0) {
      readable.push(item);
      continue;
    }
    const extraction = await extractLocally(item);
    if (!extraction || extraction.segments.length === 0) {
      // Excluded, not invented. The report says so in `coverage` and in `limitations`, so a
      // reader can see that the case was analysed over four of six documents rather than
      // being told six were examined.
      //
      // An extraction with no passages counts as nothing read: there is no text to cite,
      // and filing it as EXTRACTED would put a record in the analysis that every citation
      // lookup then fails to resolve.
      excludedEvidenceIds.push(item.id);
      continue;
    }
    // Through the mutation, not around it.
    //
    // This used to write `{ ...item, extraction, state: 'EXTRACTED' }` directly, which
    // skipped every invariant `persistEvidenceExtraction` holds: it dragged a CONFIRMED
    // record back to EXTRACTED and lost the person's confirmation, it left a stale
    // `failureReason` on a record that had just been read successfully, and it changed a
    // record's state with no audit entry at all — invisible in the case history, and so
    // outside the chain the seal signs.
    const mutation = persistEvidenceExtraction(workspace, { ownerId, now }, item.id, {
      extraction,
      state: 'EXTRACTED',
      failureReason: null,
    });
    const updated = mutation.workspace.evidence.find((record) => record.id === item.id)!;
    readable.push(updated);
    changes.push(...mutation.changes);
  }

  // `requiredEventIds` is optional on older records and the engine indexes it directly.
  const safeClaims = claims.map((c) => ({ ...c, requiredEventIds: c.requiredEventIds ?? [] }));

  /*
    Through the mutation, for the same reason the extraction loop above goes through one.

    This used to call `runAnalysis` directly and then `changes.push(put('analysisResults', r))`
    over `ruleRun.results` alone. `runAnalysis` returns two lists, and the second one —
    `resolved`, the findings that were open and that no rule produced this time — was never
    written. So a conflict could be raised but never lowered: a user who corrects the OCR
    misread behind an amount mismatch, or deletes the document that disagreed, re-runs the
    analysis and the stored finding keeps `status: 'OPEN'` forever. The freshly built report
    below says there is no conflict while the `analysisResults` collection the case screen
    reads still says there is one, and nothing in the app can reconcile them, because the only
    code that clears a finding is the branch that never ran.

    Two more things came with it, both absent from the hand-rolled version and both written by
    `runCaseAnalysis`: claim states are re-evaluated against the findings (they were left
    cached at whatever a previous run decided), and an `ANALYSIS_RUN` audit entry is recorded.
    That second one matters beyond tidiness — `ANALYSIS_RUN` exists in the enum, the audit
    screen has an icon for it, and no production path had ever written one, so the audit trail
    the seal signs was silent about the single most consequential thing the app does.

    `runCaseAnalysis` is handed the same narrowed workspace the engine was given before —
    only this case's claims, only the sources with text. Its returned `workspace` is
    discarded: the repository commit below is the write, and that workspace is narrowed.
  */
  const analysis = runCaseAnalysis(
    { ...workspace, claims: safeClaims, evidence: readable },
    { ownerId, now },
    caseId,
  );
  changes.push(...analysis.changes);
  const findings = analysis.run.results;

  const claimAssessments: ClaimAssessment[] = [];
  for (const claim of claims) {
    const forClaim = findings.filter((f) => f.relatedClaimIds.includes(claim.id));
    const conflicts = forClaim.filter((f) => isConflictFinding(f.resultType));
    const harassment = forClaim.filter((f) => f.resultType === 'HARASSMENT_INDICATOR');
    const corroborations = forClaim.filter((f) => f.resultType === 'CORROBORATED_CLAIM');

    const citations: CaseCitation[] = [];
    let status: ClaimAssessment['status'] = 'INSUFFICIENT_EVIDENCE';

    // A rule that named specific documents gets those documents cited, and only those.
    for (const finding of [...conflicts, ...harassment, ...corroborations]) {
      const stance: CaseCitation['stance'] = conflicts.includes(finding) ? 'CONTRADICTS' : 'SUPPORTS';
      for (const evidenceId of finding.supportingEvidenceIds) {
        const item = readable.find((e) => e.id === evidenceId);
        if (!item) continue;
        const segment = firstSegment(item);
        if (!segment) continue;
        const citation = cite(item, segment, stance, 160);
        if (!citation) continue;
        if (citations.some((c) => c.evidenceId === citation.evidenceId && c.segmentId === citation.segmentId && c.stance === citation.stance)) continue;
        citations.push(citation);
      }
    }

    if (conflicts.length > 0 && (corroborations.length > 0 || harassment.length > 0)) {
      status = 'DISPUTED';
    } else if (conflicts.length > 0) {
      status = 'CONTRADICTED';
    } else if (harassment.length > 0 || corroborations.length > 0) {
      status = 'SUPPORTED';
    }

    // Word overlap between a claim and a document is *context*, not support, and it never
    // moves the status. The previous version treated a single shared five-letter word as
    // corroboration, so "Payment completed" came out SUPPORTED against a receipt that said
    // "payment failed" — the exact contradiction this product exists to surface, reported
    // as agreement.
    if (status === 'INSUFFICIENT_EVIDENCE') {
      const tokens = claimTokens(claim.statement);
      for (const item of readable) {
        const hit = tokens.map((token) => segmentContaining(item, token)).find((segment) => segment !== null);
        if (!hit) continue;
        const citation = cite(item, hit, 'CONTEXT', 160);
        if (citation && !citations.some((c) => c.evidenceId === citation.evidenceId && c.segmentId === citation.segmentId)) {
          citations.push(citation);
        }
      }
    }

    const explanation =
      status === 'DISPUTED'
        ? 'The evidence is disputed: both supporting records and contradictory records exist for this claim. Review the conflicting passages below to judge which is reliable.'
        : status === 'CONTRADICTED'
          ? conflicts[0]?.explanation || 'The submitted records conflict with this claim. The cited passages are the ones that disagree.'
          : status === 'SUPPORTED'
            ? corroborations[0]?.explanation || harassment[0]?.explanation || 'A rule matched this claim against the cited passages.'
            : citations.length > 0
              ? 'No rule matched this claim against a source. The cited passages mention the same terms, which locates the claim in the documents but does not support it.'
              : 'No source in this case addresses this claim, in either direction.';

    claimAssessments.push({
      claimId: claim.id,
      statement: claim.statement,
      status,
      explanation,
      citations: citations.slice(0, 100),
      missingInformation:
        status === 'INSUFFICIENT_EVIDENCE' ? await missingInformationFor(claim, readable) : [],
      limitations: [
        `Compared against the text of ${readable.length} ${readable.length === 1 ? 'source' : 'sources'} held in this case. Nothing here establishes that any of them is genuine.`,
      ],
    });
  }

  const citedFindings = (types: readonly string[], stance: CaseCitation['stance'], maxChars: number) =>
    findings
      .filter((f) => types.includes(f.resultType))
      .map((finding) => {
        const cited: CaseCitation[] = [];
        for (const evidenceId of finding.supportingEvidenceIds) {
          const item = readable.find((e) => e.id === evidenceId);
          const segment = item ? firstSegment(item) : null;
          if (!item || !segment) continue;
          const citation = cite(item, segment, stance, maxChars);
          if (citation) cited.push(citation);
        }
        // `citedStatementSchema` requires at least one citation, and that requirement is the
        // right one: a finding nobody can check should not appear in a report at all.
        if (cited.length === 0) return null;
        return { statement: stance === 'SUPPORTS' ? finding.title : finding.explanation || finding.title, citations: cited };
      })
      .filter((item): item is { statement: string; citations: CaseCitation[] } => item !== null);

  const agreements = citedFindings(['CORROBORATED_CLAIM', 'CORROBORATED_EVENT'], 'SUPPORTS', 120);
  // `CONFLICT_ANALYSIS_TYPE_LIST`'s members, not a hand-written copy. This list read
  // `[... 'HARASSMENT_INDICATOR', 'EVENT_DATE_CONFLICT']` — and `EVENT_DATE_CONFLICT` has never
  // been an `AnalysisType`, so the entry matched nothing. The rule in
  // `definitions/event-date-conflict.ts` reports `POSSIBLE_CONFLICT`, which this list then
  // omitted: every date conflict in the case was missing from the contradictions it cites.
  const contradictions = citedFindings([...CONFLICT_ANALYSIS_TYPES], 'CONTRADICTS', 120);

  // Only events a document actually mentions. An event the user typed and no source
  // corroborates is not evidence of itself, and citing an unrelated document for it — which
  // is what taking `updatedEvidence[0]` did — attributes the user's own account to their
  // bank statement.
  const manualTimeline = workspace.events
    .filter((e) => e.caseId === caseId && !e.deletedAt)
    .map((event) => {
      for (const item of readable) {
        const needle = event.occurredAt?.original ?? event.title;
        const segment = segmentContaining(item, needle);
        if (!segment) continue;
        const citation = cite(item, segment, 'CONTEXT', 120);
        if (!citation) continue;
        return {
          description: event.title + (event.description ? `: ${event.description}` : ''),
          occurredAt: event.occurredAt?.original || event.occurredAt?.iso || null,
          citations: [citation],
        };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const { reconstructTimelineFromEvidence, resolveEntitiesFromEvidence, discoverCandidateAssertions } =
    await import('@domain/analysis/evidence-intelligence');
  const { analyzeEvidenceIndependence } = await import('@domain/analysis/independence');
  const { buildRuleContext } = await import('@domain/rules/engine');

  const evidenceTimeline = reconstructTimelineFromEvidence(readable).map((evt) => ({
    description: `${evt.title}: ${evt.description}`,
    occurredAt: evt.occurredAt,
    citations: evt.citations.slice(0, 5),
  }));

  const timeline = manualTimeline.length > 0 ? manualTimeline : evidenceTimeline.slice(0, 40);

  const resolvedEntities = resolveEntitiesFromEvidence(readable, caseRecord.participants ?? []);
  const entities = resolvedEntities.slice(0, 40).map((ent) => ({
    name: ent.name,
    type: ent.type,
    citations: ent.citations.slice(0, 10),
  }));

  const totalEvidence = readable.length + excludedEvidenceIds.length;
  const sourceCount = `${readable.length} of ${totalEvidence} ${totalEvidence === 1 ? 'source' : 'sources'}`;
  const unaddressed = claimAssessments.filter((c) => c.status === 'INSUFFICIENT_EVIDENCE').length;

  const opening = claims.length
    ? `Checked ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'} in "${caseRecord.title}" against ${sourceCount}. `
    : `Compared ${sourceCount} in "${caseRecord.title}" against each other. `;

  const found =
    contradictions.length > 0
      ? `${contradictions.length} ${contradictions.length === 1 ? 'point' : 'points'} where the sources disagree, each with the passages behind it. `
      : agreements.length > 0
        ? `${agreements.length} ${agreements.length === 1 ? 'point' : 'points'} where the sources agree, and no conflict between them. `
        : 'No rule found either agreement or conflict between these sources. ';

  // With no claim written there is nothing to report as unaddressed, and "0 claims have
  // nothing that speaks to them" is noise. The closing sentence names the one thing the
  // reader can do to get more out of the documents they have already added.
  const closing = claims.length
    ? `${unaddressed} ${unaddressed === 1 ? 'claim has' : 'claims have'} nothing in the evidence that speaks to ${unaddressed === 1 ? 'it' : 'them'}.`
    : 'Write a claim in this case to have it weighed for and against these same sources.';

  const summary = opening + found + closing;

  // Whether any source was read only in part. The deterministic extractor clamps source
  // text at `MAX_SOURCE_TEXT` and records that on the extraction, so this is the extractor's
  // own account of what it kept rather than a guess made here. It was previously hardcoded
  // `false`, which told every reader that coverage was complete even when a long contract had
  // been cut — and `export-report.ts` renders exactly this flag as "Coverage is incomplete".
  const truncated = readable.some((item) => item.extraction?.sourceTextTruncated === true);

  const limitations = [
    'This compares what the submitted records say. It does not establish that any of them is genuine, complete, or unaltered.',
    'Findings come from deterministic rules over extracted text. A rule that has no pattern for something will not report it, and silence here is not evidence of absence.',
  ];
  if (excludedEvidenceIds.length > 0) {
    limitations.push(
      `${excludedEvidenceIds.length} ${excludedEvidenceIds.length === 1 ? 'source was' : 'sources were'} left out of this analysis. ${EXCLUDED_NO_TEXT}`,
    );
  }
  if (truncated) {
    limitations.push(
      'At least one source was longer than the text this app retains, so only the retained part was compared. A value in the part that was not retained will not appear in these findings.',
    );
  }

  const ruleContext = buildRuleContext({ ...workspace, claims: safeClaims, evidence: readable }, caseId);
  const independence = analyzeEvidenceIndependence(ruleContext, readable);
  for (const warning of independence.warnings) {
    limitations.push(warning);
  }

  if (claims.length === 0) {
    const { aiSuggestionRecord, ON_DEVICE_ENGINE } = await import('./provenance');
    const discovered = discoverCandidateAssertions(readable);
    for (const assertion of discovered.slice(0, 8)) {
      /*
        The same three words the live rendering of this pass already uses.

        `discoverCandidateAssertions` reaches the reader twice: once as a `DiscoveredAssertion`
        rendered directly by `case-analysis-panel`, which labels it "Corroborated across
        sources" / "Contradicted by status" / "Single source", and once as the stored record
        written here. The stored copy carried its corroboration nowhere except in a confidence
        number, so the two renderings of one deterministic fact disagreed about what it was.
        Reusing the wording rather than inventing a second vocabulary is the point: a reader
        who scrolls from one card to the other is looking at the same finding.
      */
      const standing =
        assertion.corroboration === 'CORROBORATED'
          ? 'Corroborated across sources.'
          : assertion.corroboration === 'CONTRADICTED'
            ? 'Contradicted by status.'
            : 'Single source.';

      changes.push(
        put(
          'aiSuggestions',
          aiSuggestionRecord({
            ownerId,
            caseId,
            evidenceId: assertion.sourceEvidenceIds[0] ?? null,
            kind: 'FIELD_EXTRACTION',
            /*
              This pass is a deterministic read of extracted text — `evidence-intelligence`
              matches transaction ids and invoice numbers across documents by string equality
              and reads a status field. No model is asked anything.

              It used to store `model: 'evidence-intelligence'`, which is not the value
              `isOnDeviceSuggestion` looks for, so every record it wrote came out of the panel
              wearing the violet `ai` chip and the AI reading stamp. The panel's own comment
              says why that is not a cosmetic slip: violet means a model wrote this, and a
              reader who has learnt that mark is entitled to rely on it.
            */
            model: ON_DEVICE_ENGINE,
            // Kept distinct from `ON_DEVICE_ENGINE_VERSION`: this names which on-device pass
            // produced the record, and the reconciliation builders are a different one.
            promptVersion: 'intelligence-v1',
            summary: `${assertion.statement} ${standing}`,
            payload: {
              kind: assertion.kind,
              statement: assertion.statement,
              detail: assertion.detail,
              citations: assertion.citations,
              groundingFact: assertion.groundingFact,
              corroboration: assertion.corroboration,
            },
            sourceEvidenceIds: assertion.sourceEvidenceIds,
            // `groundingFact` is what the assertion rests on — "Transaction ID 40382881",
            // "Invoice INV-9", "Status: FAILED" — and is the only part of an assertion that
            // names the thing rather than describing it. This pass is deterministic, so the
            // same documents produce the same grounding facts on every run, and keying on
            // them is what stops each analysis adding another eight copies.
            identity: [caseId, 'assertion', assertion.kind, assertion.groundingFact],
            /*
              No `confidence`, which `aiSuggestionRecord` stores as `null`.

              It was `corroboration === 'CORROBORATED' ? 0.9 : 0.7` — two numbers no part of
              this pass computes, rendered by the panel as "Its own confidence: High" beside a
              speaker that was never asked. Worse than invented: `CONTRADICTED` and
              `SINGLE_SOURCE` both mapped to 0.7 and therefore to one band, so the single most
              important thing this pass can find — a document contradicted by another — was
              displayed identically to a value only one document happens to mention. That
              distinction now travels as itself, in `payload.corroboration` and in the summary.
            */
            now,
          }),
        ),
      );
    }
  }

  const reportId = newId('analysis');
  const report: CaseAnalysis = {
    id: reportId,
    ownerId,
    caseId,
    // The report is its own job reference until a job record exists; `requestCaseAnalysis`
    // writes one and points it back here through `resultPath`.
    jobId: reportId,
    schemaVersion: '1',
    summary,
    claims: claimAssessments,
    agreements,
    contradictions,
    timeline,
    entities,
    limitations,
    coverage: {
      totalEvidence,
      processedEvidence: readable.length,
      excludedEvidenceIds,
      truncated,
    },
    // No model ran. Naming one — the previous value here was `openai/gpt-oss-120b` — would
    // attribute a deterministic result to a language model that was never called, in the
    // field a reader checks to find out where a conclusion came from.
    model: 'deterministic-rule-engine',
    promptVersion: 'no-prompt-deterministic',
    createdAt: now,
    updatedAt: now,
  };

  caseAnalysisSchema.parse(report);
  changes.push(put('caseAnalyses', report));
  // No `put('cases', …)` here. `runCaseAnalysis` already stamped `lastAnalyzedAt` from the
  // same `now`; writing the case a second time from `caseRecord` would only re-send the
  // pre-analysis copy of a record that has since had its claim states recomputed around it.

  // The same guard `runCaseAiSuggestions` applies, for the same reason. The assertion pass
  // above builds its records with deterministic ids so a re-run rewrites them in place rather
  // than adding another eight — and the cost of that, unguarded, is that a `put` would
  // overwrite a proposal this person already accepted or rejected with a fresh `SUGGESTED`
  // copy. A rejected assertion would return to the top of the panel after every analysis.
  const { decidedSuggestionIds } = await import('./provenance');
  const decided = decidedSuggestionIds(workspace.aiSuggestions);
  const writable = changes.filter(
    (change) =>
      !(change.op === 'put' && change.collection === 'aiSuggestions' && decided.has(change.record.id)),
  );

  await repository.commit(ownerId, writable);
  return report;
}
