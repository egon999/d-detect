/**
 * Planning the handover of a case from this device to a signed-in account.
 *
 * ## The gap this closes
 *
 * The app is usable before anyone signs in: `RepositoryProvider` hands out the AsyncStorage
 * adapter whenever there is no cloud identity, and cases created then are stored under a
 * device-generated owner id like `user_a1b2c3`. Sign in and the provider switches to
 * Firestore, which is scoped to the Firebase uid — so the work done on the device is still
 * on the device, and is no longer anywhere the user can see it.
 *
 * That is the worst kind of bug to ship: nothing errors, nothing is deleted, and the user
 * concludes the app lost their case. This planner is the fix. It takes a workspace read out
 * of the device store and produces the change set that re-creates it under the account.
 *
 * ## Why nothing is downgraded on the way across
 *
 * A previous version of this file turned every source into a `NOTE` headed "RECOVERED
 * WORKSPACE NOTE — NOT THE ORIGINAL FILE", stripped dates off events and reset every claim
 * to `UNSUPPORTED`. That is the right conservatism for records arriving from *somewhere
 * else* — a different deployment, an unverifiable export — because their provenance cannot
 * be re-established.
 *
 * It is the wrong behaviour here, and the difference is worth stating precisely: these
 * records were produced by this build, of this app, on this device, from files that are
 * still in this device's private store. The extraction can be re-derived byte for byte, the
 * hash can be re-checked (`verifyEvidenceFile`), and the original opens. Discarding all of
 * that would destroy real evidence and real provenance to no benefit, and would teach the
 * user that signing in costs them their work.
 *
 * So the records cross intact. Two things do change, and both are forced:
 *
 * 1. **Ownership.** Every record is re-stamped with the account's owner id. `commit` calls
 *    `assertOwnership`, and Firestore's rules require `request.auth.uid == ownerId`, so a
 *    record carrying the old device id would be rejected outright — correctly.
 * 2. **Storage paths.** `evidenceStoragePath` embeds the owner id and
 *    `validatePrivateEvidencePath` enforces it on every read. The path is therefore rewritten
 *    here, and the caller moves the bytes to match. A record re-owned without its file moving
 *    is a record whose original can never be opened again.
 *
 * `lastAnalyzedAt` is cleared, which is not a downgrade: the analysis run it refers to was
 * recorded against records that no longer exist under those ids, and re-running the engine is
 * cheap and deterministic. Better a case that says "not analysed yet" and then is, than one
 * that claims a run it cannot show.
 */

import { put, MAX_ATOMIC_CHANGES, type Change } from '@data/repository';
import { deterministicId } from '@domain/ids';
import type { Case, Workspace } from '@domain/models';

/** One evidence file that has to follow its record to a new path. */
export interface EvidenceFileMove {
  evidenceId: string;
  from: string;
  to: string;
}

export interface CaseHandoverPlan {
  /** The case as it will exist in the account. */
  caseRecord: Case;
  changes: Change[];
  claimCount: number;
  eventCount: number;
  evidenceCount: number;
  /** Files whose bytes must be moved, in the same order as their evidence records. */
  fileMoves: EvidenceFileMove[];
}

/**
 * Upper bound on records in one handover.
 *
 * This is the port's atomic-commit bound, not a number of its own, and the distinction is the
 * whole point. A handover is the one operation in the app where a partial write is worse than
 * a refusal: half a case in the account and half still on the device, with the user told they
 * signed in successfully and no way to tell which records made it.
 *
 * It used to be 450 — chosen to sit "well under" Firestore's 500-operation batch limit, and
 * reasonable on its face. But the Firestore adapter slices at 400, so a case between the two
 * committed as two batches, and the second one failing left exactly the half-written outcome
 * this bound exists to prevent. Deriving it removes the possibility: whatever the adapter can
 * apply atomically is whatever a plan is allowed to contain.
 *
 * The cost is real and accepted — a case of 401 records is refused rather than moved. That is
 * the tradeoff `ARCHITECTURE.md` already describes, and the refusal is recoverable: the device
 * copy is untouched and the case stays openable exactly where it is.
 */
const MAX_CHANGES = MAX_ATOMIC_CHANGES;

/** Rewrites a storage path onto a new owner. Returns null for a record with no file. */
function repointStoragePath(path: string | null, toOwnerId: string): string | null {
  if (!path) return null;
  const pieces = path.split('/');
  // Only the shape this app writes is rewritten. Anything else is left alone and reported
  // as unmovable rather than guessed at — a path built by a different scheme could be
  // rewritten into something that resolves to another record's file.
  if (pieces.length !== 6 || pieces[0] !== 'users' || pieces[2] !== 'cases') return null;
  pieces[1] = toOwnerId;
  return pieces.join('/');
}

/**
 * Builds the change set that moves one case from `fromOwnerId` to `toOwnerId`.
 *
 * Record ids are preserved. That makes the handover idempotent — running it twice writes the
 * same records rather than a second copy of the case — and it keeps every cross-reference
 * (`claimIds`, `requiredEventIds`, relationship endpoints, `entityRefs`) valid without a
 * rewrite pass, which is where an id-remapping migration would go wrong.
 *
 * `now` reaches exactly one document: the case record's `updatedAt`, which is a mutable row
 * being genuinely rewritten and whose collection permits an ordinary owner update. It reaches
 * nothing else, and the handover audit entry below explains at length why it must not — every
 * other document in the plan is either carried across verbatim or, in the one case that is
 * built here, derived from what is moving. Two attempts at the same handover therefore differ
 * by one field of one row, in the one collection that can absorb it.
 *
 * The nine collections are handled one by one rather than in a loop over collection names.
 * That is deliberate: `put` is generic over the collection, so writing them out keeps each
 * record checked against its own schema type, and evidence needs different treatment anyway.
 */
export function planCaseHandover(
  fromOwnerId: string,
  toOwnerId: string,
  caseId: string,
  workspace: Workspace,
  now: number,
): CaseHandoverPlan {
  const record = workspace.cases.find(
    (item) => item.id === caseId && item.ownerId === fromOwnerId && item.deletedAt === null,
  );
  if (!record) throw new Error('That case is not stored on this device.');

  /** Records of this case belonging to the device owner. Everything else is left where it is. */
  const mine = <T extends { caseId: string; ownerId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => row.ownerId === fromOwnerId && row.caseId === caseId);

  const caseRecord: Case = { ...record, ownerId: toOwnerId, updatedAt: now, lastAnalyzedAt: null };
  const changes: Change[] = [put('cases', caseRecord)];
  const fileMoves: EvidenceFileMove[] = [];

  const claims = mine(workspace.claims);
  const events = mine(workspace.events);
  const evidence = mine(workspace.evidence);

  for (const item of claims) changes.push(put('claims', { ...item, ownerId: toOwnerId }));
  for (const item of events) changes.push(put('events', { ...item, ownerId: toOwnerId }));

  for (const item of evidence) {
    const to = repointStoragePath(item.storagePath, toOwnerId);
    if (item.storagePath && to) fileMoves.push({ evidenceId: item.id, from: item.storagePath, to });
    // A path this planner cannot rewrite is set to null rather than carried across pointing
    // into another account's namespace, where the ownership check would reject it. The record
    // keeps its extracted text and its findings; only the link to the file is dropped.
    changes.push(put('evidence', { ...item, ownerId: toOwnerId, storagePath: to }));
  }

  for (const item of mine(workspace.relationships)) {
    changes.push(put('relationships', { ...item, ownerId: toOwnerId }));
  }
  for (const item of mine(workspace.analysisResults)) {
    changes.push(put('analysisResults', { ...item, ownerId: toOwnerId }));
  }
  for (const item of mine(workspace.auditLogs)) {
    changes.push(put('auditLogs', { ...item, ownerId: toOwnerId, actorId: toOwnerId }));
  }
  for (const item of mine(workspace.processingJobs)) {
    changes.push(put('processingJobs', { ...item, ownerId: toOwnerId }));
  }
  for (const item of mine(workspace.aiSuggestions)) {
    changes.push(put('aiSuggestions', { ...item, ownerId: toOwnerId }));
  }
  for (const item of mine(workspace.caseAnalyses)) {
    changes.push(put('caseAnalyses', { ...item, ownerId: toOwnerId }));
  }

  /*
    ## Why the handover entry carries no clock value at all

    This entry's id was `deterministicId('audit', toOwnerId, caseId, String(now), 'device-handover')`
    and its timestamps were `now`, so every attempt at the same handover produced a different
    document. A retry is not hypothetical here: `handOverDeviceCase` can fail after the batch has
    landed but before its acknowledgement arrives, and the screen's only offer is to press Move
    again with a fresh `Date.now()`. The trail then held two entries saying the case was moved,
    and `buildAuditChain` — which hashes each entry over the one before it — chained both, so the
    history did not merely repeat itself, it asserted that the action happened twice. In a record
    whose value is that it says what was done, an event that did not happen is the whole defect.

    Deriving the id alone would have replaced that with something worse. `rules/firestore.rules`
    makes `auditLogs` append-only and permits exactly one update — `unchanged()`, deep equality of
    the entire document — and its comment states the assumption it rests on: that "a re-run of the
    same plan genuinely reproduces the same bytes rather than merely the same shape". With a stable
    id and a moving `createdAt`, the retry becomes an update that changes a field, the rule refuses
    it, the whole atomic batch is rejected, and the case is stuck on the device for good while the
    screen tells the user nothing was written to their account — which by then is false. So the
    bytes have to be stable, not just the id, and that is a claim the rules already make about this
    function.

    **The id** is the handover itself: who it is from, who it is to, which case, and the exact set
    of rows crossing. `deterministicId` sorts its parts, so each one is prefixed with what it is —
    an id can never contain `:` (`ID_PATTERN`), so `from:x` and `to:x` cannot be read for each
    other, and the sorted multiset still determines the tuple it came from. Row *contents* are
    deliberately not folded in: the case record carries `updatedAt: now`, so hashing contents would
    put the clock straight back into the id. Two attempts that move the same rows are one handover;
    a later move that carries a row the first did not is a different event and correctly gets its
    own entry.

    Note what is *not* in the id: `fileMoves.length`, which the summary quotes. If a file became
    movable between two attempts the retry would be refused by `unchanged()` rather than minting a
    second id — nothing written, device copy intact, and an error the user can act on. That is the
    right way round: a refusal is recoverable, a duplicated entry in a chained history is not.

    **The timestamp** is the latest stamp on any row being moved, which is the tightest instant
    this function can prove the handover was at or after, and the only one that is a pure function
    of the plan. The re-stamped case record is excluded because its `updatedAt` is `now`. This is
    an honest lower bound rather than the moment of the move, and that trade is deliberate: a
    retryable handover with an entry timestamped at the last thing that happened to the case beats
    an exact timestamp that makes the entry either duplicated or unwritable. It also sorts the
    entry last in the case's own history, since it is at or after every entry crossing with it.
  */
  let handoverAt = Math.max(record.createdAt, record.updatedAt);
  for (const change of changes) {
    if (change.op !== 'put' || change.collection === 'cases') continue;
    handoverAt = Math.max(handoverAt, change.record.createdAt, change.record.updatedAt);
  }

  const identity = [
    'kind:device-handover',
    `from:${fromOwnerId}`,
    `to:${toOwnerId}`,
    `case:${caseId}`,
    ...changes.map(
      (change) => `row:${change.collection}:${change.op === 'put' ? change.record.id : change.id}`,
    ),
  ];

  changes.push(
    put('auditLogs', {
      id: deterministicId('audit', ...identity),
      ownerId: toOwnerId,
      caseId,
      createdAt: handoverAt,
      updatedAt: handoverAt,
      actorId: toOwnerId,
      action: 'CASE_CREATED',
      // Deliberately factual about what moved and what did not. An audit trail that recorded
      // only "imported" would leave a reader unable to tell whether the originals came too.
      summary:
        `Moved this case from device storage into the signed-in account. ` +
        `${evidence.length} source${evidence.length === 1 ? '' : 's'} carried across, ` +
        `${fileMoves.length} with the original file.`,
      metadata: {
        source: 'device-storage',
        sources: String(evidence.length),
        filesMoved: String(fileMoves.length),
      },
      entityRefs: [],
    }),
  );

  if (changes.length > MAX_CHANGES) {
    throw new Error(
      'This case is too large to move in one step. Nothing has been changed — it is still ' +
        'available on this device.',
    );
  }

  return {
    caseRecord,
    changes,
    claimCount: claims.length,
    eventCount: events.length,
    evidenceCount: evidence.length,
    fileMoves,
  };
}
