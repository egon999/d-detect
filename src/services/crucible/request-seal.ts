/**
 * Asking the server to seal a case.
 *
 * The one operation in this app that a device cannot perform, because the whole value of a
 * seal is that the device could not have produced it. Everything else — extraction, the rule
 * engine, the chain itself — runs locally on purpose, and `@services/ai/case-analysis`
 * documents at length why the earlier `httpsCallable` attempts were deleted rather than
 * repaired. This call is not a regression from that; it is the exception the rule was drawn
 * around.
 *
 * ## Two transports, one implementation
 *
 * `sealCase` in `functions/src/seal.js` is reached two ways: as a Cloud Function callable
 * when the workspace is on Firestore, and as `POST /api/cases/{id}/seal` on the hand-written
 * platform server when the workspace is on the platform API. The signing, the chain, and the
 * refusals are the same code in both — only the envelope differs, so the two paths cannot
 * drift into signing different things. The API path is the one that runs today: the Firebase
 * project is on the Spark plan, where Cloud Functions cannot be deployed at all.
 *
 * ## What is sent, and why it is so little
 *
 * A case id. Nothing else. Not the chain head, not the entry count, not a key id — the
 * server reads the audit log itself and computes the head with the same `buildAuditChain`
 * this app renders from (cross-compiled; see `functions/tsconfig.domain.json`). A request
 * that carried the head would make the function a signing oracle: name any digest, receive
 * an attestation for it. `functions/test/seal.test.js` pins that a caller's head is ignored.
 *
 * ## Every failure is a sentence, not a thrown error
 *
 * The caller is a button on a screen, and the honest outcomes here are numerous and
 * uninteresting to distinguish in a `catch`: no Firebase config, a local-only workspace, a
 * case with nothing in it yet, an offline device. Each is returned as a `kind` plus the
 * sentence to show, because a seal that cannot be made is not an error state — it is
 * information about the record, and the user is entitled to the actual reason rather than a
 * greyed-out control.
 */

import type { RepositoryKind } from '../repository-provider';

export interface SealReceipt {
  sealId: string;
  chainHead: string;
  entryCount: number;
  sealedAt: number;
}

export type SealOutcome =
  /** A new seal was written over `entryCount` entries. */
  | { kind: 'sealed'; receipt: SealReceipt }
  /**
   * Nothing has happened to the case since the last seal, so the existing one still covers
   * it. Deliberately distinct from `sealed`: telling a user their record was just sealed
   * when no signature was made would be a small lie that the seal's own timestamp contradicts.
   */
  | { kind: 'unchanged'; receipt: SealReceipt }
  /** Sealing is not reachable at all. `reason` is shown as-is. */
  | { kind: 'unavailable'; reason: string }
  /** The server declined, and said why in words meant to be read. */
  | { kind: 'refused'; reason: string };

const REGION = 'us-central1';

const OFFLINE =
  'The record could not be sealed because the server could not be reached. Nothing in the case has changed; try again when you are online.';

/**
 * Local-only workspaces cannot be sealed, and pretending otherwise would be the worse
 * option.
 *
 * The signing key is on the server and the server reads Firestore, so a case that exists
 * only in this device's storage is a case the signer has never seen. There is no partial
 * version of this: uploading the case in order to seal it would change what the user is
 * storing locally, which is a decision for them and not a side effect of tapping a button.
 */
const LOCAL_ONLY =
  'This case is stored only on this device, so there is nothing for the server to sign. Sign in to sync it before sealing.';

/**
 * No `sealCase` on the other end.
 *
 * Says what is actually known — the request reached Firebase and Firebase had no such
 * function — and what is not: nothing about this record was read, judged or rejected. It also
 * says the history is untouched, because "sealing failed" on an integrity screen reads as
 * though something happened to the records, and nothing did.
 */
const NO_SEALING_SERVICE =
  'This build has no sealing server to ask, so no signature could be made. Nothing was read and nothing in the case has changed — the history and the chain above are exactly as they were.';

/**
 * A reply this build cannot read.
 *
 * Reported as `unavailable` rather than `sealed`, because the alternative is announcing a
 * signature on the strength of a response we could not parse. If a seal was in fact written,
 * the next read of the case will find it and the ribbon will show it — the screen recovers
 * from being too cautious, and cannot recover from having claimed a seal that is not there.
 */
const UNREADABLE =
  'The sealing service replied in a form this version of the app cannot read, so no result can be shown. Reopen the case to see whether a seal was recorded.';

export async function requestSeal(
  caseId: string,
  options: { repositoryKind: RepositoryKind },
): Promise<SealOutcome> {
  // The local adapter has no signer by construction: the case exists only in this device's
  // storage, so there is nothing a server could have read.
  if (options.repositoryKind === 'local') return { kind: 'unavailable', reason: LOCAL_ONLY };
  if (options.repositoryKind === 'remote') return sealOverApi(caseId);

  try {
    const { firebaseApp } = await import('../../data/firebase/auth');
    const app = firebaseApp();
    if (!app) {
      return {
        kind: 'unavailable',
        reason: 'Sealing needs a configured Firebase project, and this build does not have one.',
      };
    }

    const { getFunctions, httpsCallable, connectFunctionsEmulator } = await import('firebase/functions');
    const { useFirebaseEmulator, firebaseEmulatorHost } = await import('../../data/firebase/config');
    const functions = getFunctions(app, REGION);
    if (useFirebaseEmulator()) connectFunctionsEmulator(functions, firebaseEmulatorHost(), 5001);

    const call = httpsCallable<{ caseId: string }, SealReceipt & { created: boolean }>(functions, 'sealCase');
    const { data } = await call({ caseId });

    return outcomeFrom(data);
  } catch (error) {
    return interpret(error);
  }
}

/**
 * Sealing over the platform API, which is the path that actually runs today.
 *
 * `POST /api/cases/{id}/seal` reaches the same `sealCase` the Cloud Function wraps — one
 * implementation, two transports — so a seal made here is the same bytes over the same
 * payload, checked by the same `verifySealedHistory` on the way back in. What differs is who
 * ran it, and the ribbon says so: see `sealSignerNote` in `@features/crucible/seal-copy`.
 *
 * The id is encoded even though `ID_PATTERN` admits no character that needs it. A path built
 * by concatenation is a path traversal waiting for the pattern to be relaxed by someone who
 * does not know this line exists.
 */
async function sealOverApi(caseId: string): Promise<SealOutcome> {
  try {
    const { apiJson } = await import('../api-client');
    const data = (await apiJson(`/api/cases/${encodeURIComponent(caseId)}/seal`, { method: 'POST' })) as
      SealReceipt & { created?: unknown };
    return outcomeFrom(data);
  } catch (error) {
    return interpretApi(error);
  }
}

/**
 * The receipt, and which of the two honest successes it is.
 *
 * `created` decides, and it is read as a strict boolean rather than for truthiness: a server
 * that omitted the field would otherwise be read as "no new signature", which is the safer
 * of the two misreadings but still a guess. A missing field means the response did not come
 * from a version of the API this build understands.
 */
function outcomeFrom(data: SealReceipt & { created?: unknown }): SealOutcome {
  const receipt: SealReceipt = {
    sealId: data.sealId,
    chainHead: data.chainHead,
    entryCount: data.entryCount,
    sealedAt: data.sealedAt,
  };
  if (typeof data.created !== 'boolean') {
    return { kind: 'unavailable', reason: UNREADABLE };
  }
  return data.created ? { kind: 'sealed', receipt } : { kind: 'unchanged', receipt };
}

/**
 * Turns a callable failure into something worth reading.
 *
 * `failed-precondition` carries the server's own sentence, which is written for this screen
 * — "There is nothing recorded in this case to seal yet." is more use than any wording this
 * layer could invent for it. Everything else is deliberately flattened: an `internal` error
 * and a dropped connection are the same fact to the user (no seal was made, the record is
 * untouched), and guessing between them here would mean inventing a diagnosis.
 *
 * ## The one code that has to be split apart
 *
 * `not-found` arrives from two unrelated places. `functions/src/seal.js` raises it with a
 * sentence of its own when the case is not the caller's to seal; the Functions SDK raises it
 * with a bare `NOT_FOUND` when there is no function of that name deployed at all. Reporting
 * the second as a refusal would tell a user the server read their record and declined, when
 * nothing on the other end was listening — a refusal that never happened, attributed to a
 * server that never spoke. This feature's whole claim is that it does not assert things it
 * cannot establish, and that has to hold for its error paths too.
 */
function interpret(error: unknown): SealOutcome {
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';

  // Every sentence `seal.js` raises is prose: several words, ending in a full stop. A bare
  // status token is the SDK's, not the server's, and carries no verdict to pass on.
  const serverSpoke = /\S\s\S/.test(message) && message.trim().endsWith('.');

  if (code === 'functions/not-found' && !serverSpoke) {
    return { kind: 'unavailable', reason: NO_SEALING_SERVICE };
  }
  if (code === 'functions/failed-precondition' || code === 'functions/not-found' || code === 'functions/invalid-argument') {
    return { kind: 'refused', reason: message || 'The server declined to seal this record.' };
  }
  if (code === 'functions/unauthenticated') {
    return { kind: 'unavailable', reason: 'Sign in again to seal this record.' };
  }
  if (code === 'functions/resource-exhausted') {
    return { kind: 'refused', reason: 'This account has sealed too many records recently. Try again later.' };
  }
  return { kind: 'unavailable', reason: OFFLINE };
}

/**
 * The same job for the platform API, whose codes are the callable's without the prefix.
 *
 * Written out rather than folded into `interpret` by stripping `functions/`, because the two
 * transports do not carry the server's words equally well and pretending otherwise would lose
 * the difference. `api-client` substitutes its own generic sentence for every status except
 * 400, 409 and 413 — so a 409, which is what every considered refusal from `sealCase` arrives
 * as, reaches the user in the server's own wording, and a 404 does not. A 404 here therefore
 * says only what is certain: no seal was made, and nothing was changed.
 */
function interpretApi(error: unknown): SealOutcome {
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';

  if (code === 'failed-precondition') {
    return { kind: 'refused', reason: message || 'The server declined to seal this record.' };
  }
  if (code === 'not-found') {
    // Covers both "this case is not yours" and "this server has no sealing route", which the
    // status alone cannot separate. Neither is a verdict on the record, so neither is reported
    // as one.
    return { kind: 'unavailable', reason: NO_SEALING_SERVICE };
  }
  if (code === 'unauthenticated') {
    return { kind: 'unavailable', reason: 'Sign in again to seal this record.' };
  }
  if (code === 'permission-denied') {
    return { kind: 'refused', reason: 'This case is not available to seal from this account.' };
  }
  if (code === 'resource-exhausted') {
    return { kind: 'refused', reason: 'This account has sealed too many records recently. Try again later.' };
  }
  return { kind: 'unavailable', reason: OFFLINE };
}
