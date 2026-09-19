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
 * That last sentence used to be documentation only, while the code carried on offering the
 * callable to every signed-in user and turning each tap into a warning toast. It is now a
 * value — `FIREBASE_SEAL_CALLABLE_DEPLOYED` — that `sealAvailability` reads, so the screen
 * and the request agree with this comment instead of contradicting it.
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

/**
 * Whether a signer can be reached for a case — which is not the question of where the case
 * is stored, and the whole reason this type exists.
 *
 * The ribbon used to ask the storage question (`repositoryKind !== 'local'`) and read the
 * answer as the signing one. For the Firebase adapter the two answers differ: the records are
 * on a server, so a "Seal this record" button appeared on every case in the default build,
 * and no `sealCase` is deployed there, so every tap came back as a warning toast. Three
 * states instead of a boolean, because the two unsealable ones are unsealable for unrelated
 * reasons and the copy has to be able to tell a reader which one they are in.
 */
export type SealAvailability =
  /** A signer answers: `POST /api/cases/{id}/seal` on the platform server, which holds a key. */
  | 'available'
  /** The case exists only in this device's storage, so no server has ever read it. */
  | 'device-only'
  /** The case is on a server, and no signer is deployed for this build to ask. */
  | 'no-service';

/**
 * Whether a `sealCase` callable is deployed on the Firebase project this build talks to.
 *
 * `false`, and not as a placeholder awaiting wiring: the project is on the Spark plan, where
 * Cloud Functions cannot be deployed at all. The callable transport below is complete and
 * correct; there is simply nothing on the other end of it. So the honest answer for a Firebase
 * workspace is that no signer exists to ask, rather than that a request might work.
 *
 * Compiled in rather than read from an `EXPO_PUBLIC_*` variable, in the same spirit as
 * `ACTIVE_SEAL_KEY_ID`: it is a fact about what was deployed alongside this binary, and a
 * build that learns it from the environment can be handed a `true` that no deployment backs —
 * which puts the button back, and the button is the defect.
 *
 * Change to `true` only once `firebase deploy --only functions:sealCase` has actually
 * succeeded against the project named in `app.json`, which means moving that project to the
 * Blaze plan first. Nothing else needs changing: the callable path is still here, its status
 * mapping is still `interpretCallableError`, and the copy for a reachable signer is the copy
 * the `remote` transport already shows.
 */
export const FIREBASE_SEAL_CALLABLE_DEPLOYED: boolean = false;

/**
 * Whether anything can sign a case in this session.
 *
 * Takes the repository kind because that is what a screen has to hand, and deliberately
 * answers a different question from the one it was asked. Kept here rather than in the copy
 * layer so that the button and the request cannot disagree: `requestSeal` consults the same
 * function, so a state that shows no button is also a state that opens no socket.
 */
export function sealAvailability(repositoryKind: RepositoryKind): SealAvailability {
  switch (repositoryKind) {
    case 'local':
      return 'device-only';
    case 'remote':
      return 'available';
    case 'firebase':
      return FIREBASE_SEAL_CALLABLE_DEPLOYED ? 'available' : 'no-service';
  }
}

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
 * Says what is actually known — this build has no signer to ask — and what is not: nothing
 * about this record was read, judged or rejected. It also says the history is untouched,
 * because "sealing failed" on an integrity screen reads as though something happened to the
 * records, and nothing did.
 *
 * Reached two ways, and true of both. `FIREBASE_SEAL_CALLABLE_DEPLOYED` is false, so a
 * Firebase workspace gets this sentence without a request leaving the device; a platform
 * server with no sealing route answers 404 and gets it after one. The wording does not name a
 * request either way, because in the first case there was none.
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
  // Both unsealable states are known before any work is done, and both end in a fixed
  // sentence, so the request is not made. A round trip whose every outcome is the same
  // outcome is latency spent to learn nothing — and on the Firebase path it is also a call
  // this module already knows lands on no function at all.
  //
  // Decided here rather than trusted from the caller: the ribbon reads the same
  // `sealAvailability`, but a screen that got it wrong should still not be able to get a
  // request out of this module.
  const availability = sealAvailability(options.repositoryKind);
  if (availability === 'device-only') return { kind: 'unavailable', reason: LOCAL_ONLY };
  if (availability === 'no-service') return { kind: 'unavailable', reason: NO_SEALING_SERVICE };
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
    return interpretCallableError(error);
  }
}

/**
 * Sealing over the platform API, which is the path that actually runs today.
 *
 * `POST /api/cases/{id}/seal` reaches the same `sealCase` the Cloud Function wraps — one
 * implementation, two transports — so a seal made here is the same bytes over the same
 * payload, checked by the same `verifySealedHistory` on the way back in.
 *
 * What differs is who ran it, and that difference is not carried by this function. It is
 * carried by the `keyId` the signer stamps on the seal: a self-hosted `local-server.js` reads
 * its key from `functions/.env.local` and signs as `dev1`, which `@domain/crucible/keys`
 * registers as a key no deployed server holds. The ribbon reads that id — `sealHeadline` and
 * `sealNotice` in `@features/crucible/seal-copy` both branch on it — so the reader is told
 * which kind of signature they are looking at. This comment used to name a `sealSignerNote`
 * that has never existed, which mattered: it asserted the distinction was surfaced at a time
 * when nothing read the id at all.
 *
 * Routing it through the record rather than through the caller is deliberate. This function's
 * knowledge of which transport it used is gone by the time a stranger opens the export; the
 * key id is still on the seal.
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
 *
 * ## Why this is exported
 *
 * `requestSeal` cannot reach it while `FIREBASE_SEAL_CALLABLE_DEPLOYED` is false, so the only
 * way `tests/crucible-request-seal.test.ts` can still hold this mapping to its word is to
 * call it. The alternative was to let it ship untested until the day someone deploys the
 * callable, which is the worst possible day to find out it is wrong.
 */
export function interpretCallableError(error: unknown): SealOutcome {
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
 * Written out rather than folded into `interpretCallableError` by stripping `functions/`,
 * because the two transports do not carry the server's words equally well and pretending
 * otherwise would lose the difference. `api-client` substitutes its own generic sentence for
 * every status except 400, 409 and 413 — so a 409, which is what every considered refusal from
 * `sealCase` arrives as, reaches the user in the server's own wording, and a 404 does not. A
 * 404 here therefore says only what is certain: no seal was made, and nothing was changed.
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
