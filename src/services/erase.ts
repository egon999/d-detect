/**
 * Erasing everything the app holds about a person.
 *
 * ## Why this exists
 *
 * Every other delete in this app is a soft delete: a `deletedAt` stamp that hides a record and
 * keeps its bytes. That is the right default for case work, where "I removed the wrong claim"
 * is an ordinary sentence and an undo is worth more than the reclaimed space. It is the wrong
 * default for the moment someone is finished. What accumulates here is a bank statement with
 * an account number on it, a salary slip, a name and a postal address typed into a draft
 * letter, and the full extracted text of every document that was ever read. A person who wants
 * that gone is not asking for it to be hidden, and `SECURITY.md` has recorded the gap between
 * those two things as an open one since the soft deletes were written.
 *
 * ## Why a sweep, and not a list of targeted deletes
 *
 * The obvious implementation walks the case list and deletes what it finds. It would be wrong
 * in three separate ways, and each one leaves real material behind:
 *
 * - The case list hides soft-deleted cases, so every case the user has already discarded —
 *   the ones they most likely wanted gone — would survive the erase that was meant to be final.
 * - Data on this device is keyed by *owner id*, and a handset accumulates several. Work done
 *   before signing in belongs to a generated device identity; a second account signing in adds
 *   another. Scoping to the signed-in id leaves the offline session intact and unreachable.
 * - Files and records are stored separately and can already be out of step. An original whose
 *   commit failed is invisible to every record-driven path in the codebase, and would be
 *   invisible to a record-driven erase too.
 *
 * So the device side is a prefix sweep of everything this app wrote, and the account side is
 * `Repository.clear`, which each adapter implements as a total removal or refuses outright.
 *
 * ## What survives, and why that is not a loophole
 *
 * The colour scheme and the "tour already seen" flag stay. Neither says anything about a
 * person: one is `dark`, `light` or `system`, the other is the literal string `true`. Keeping
 * them means the app after an erase looks like the app before it rather than a fresh install,
 * which matters because the most likely user of this screen is someone clearing a finished
 * case off their own phone, not someone abandoning the product.
 *
 * The sign-in itself also survives — this removes data, not the account. The screen that calls
 * this says so in those words, because a user who believed their login was gone and later
 * found it working would have been misled by us rather than by Firebase.
 *
 * One thing survives that nobody chose. Firestore's persistent cache is dropped at the end of
 * the sweep, but Firestore's own documentation is explicit that doing so "does not attempt to
 * securely overwrite or otherwise make cached data unrecoverable", and recommends not enabling
 * persistence at all where that matters. So an erase ends the app's access to those copies; it
 * is not a guarantee against someone holding the device and a forensic tool. The alternative is
 * to turn persistence off, which costs every offline read — a case is most often wanted in a
 * meeting or on a train — so it is a product decision rather than a bug to quietly fix here.
 * It is written down so that the next reader does not assume a stronger promise than the one
 * this file can keep.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { deleteCase, type MutationContext } from '@data/mutations';
import type { Repository } from '@data/repository';
import type { Workspace } from '@domain/models';

import { AI_PROVIDER_IDS, clearKey } from './ai/credentials';
import { deleteEvidenceFile, eraseStoredEvidence, evidenceStoreUsage } from './storage/evidence-storage';

/** Every key this app writes carries this prefix. The sweep is defined by it. */
const APP_KEY_PREFIX = 'detact:';

/**
 * Keys that outlive an erase.
 *
 * Listed explicitly rather than pattern-matched: an allow-list fails closed, so a key added
 * in a later version is erased by default instead of being quietly preserved because nobody
 * remembered to think about it.
 */
const KEYS_KEPT: readonly string[] = ['detact:v1:theme', 'detact:v1:onboarding-seen'];

/**
 * Keys from versions that predate the prefix.
 *
 * Only one so far — an unowned recent-search list. It is named here rather than left to the
 * sweep because nothing about its shape marks it as ours.
 */
const LEGACY_KEYS: readonly string[] = ['@ddetact_recent_searches'];

/** What an erase is about to take, so the confirmation can name it instead of gesturing at it. */
export interface StoredDataSummary {
  /** Cases the signed-in account can open right now. Excludes ones already discarded. */
  cases: number;
  /** Original files held on this device, across every account that has used it. */
  bytes: number;
}

/**
 * Measures what is stored, for the sentence shown above the erase button.
 *
 * Neither figure is allowed to fail the screen. A user who cannot be told the size still needs
 * the button, and a zero is a safe thing to show next to an action whose whole job is to make
 * the number zero — it understates, never overstates, what is at stake.
 */
export async function storedDataSummary(
  repository: Repository,
  ownerId: string,
): Promise<StoredDataSummary> {
  const [cases, usage] = await Promise.all([
    repository.listCases(ownerId).then(
      (list) => list.length,
      () => 0,
    ),
    evidenceStoreUsage().then(
      (value) => value.usedBytes,
      () => 0,
    ),
  ]);
  return { cases, bytes: usage };
}

/**
 * Removes the account's records, then everything this app has written to this device.
 *
 * ## The order is the safety property
 *
 * The account goes first. It is the only step that can refuse — `RemoteRepository` has no
 * endpoint for it and says so — and the only one that reaches data the device cannot rebuild.
 * Putting it first means a refusal costs the user nothing: they still have every case, on a
 * device that was never touched, and can be told plainly why.
 *
 * The reverse order is the one that destroys something. Wiping the device first and then
 * failing on the account leaves a user whose local work is gone and whose cloud copy is
 * intact-but-half-deleted, with no way to tell which of their cases survived.
 *
 * Files come before keys for the same reason at a smaller scale. A failed file delete with the
 * records still present is a visible, retryable state; the same failure after the records are
 * gone leaves orphaned bytes that no screen in the app can find, name or remove.
 *
 * ## Failures are raised, not swallowed
 *
 * Anything that goes wrong throws, and the caller reports it. The single tolerated exception is
 * the credential store: `clearKey` already absorbs a missing key and an unavailable keystore,
 * because "there was no key to delete" and "the key is deleted" are the same outcome for the
 * user and neither is worth failing an otherwise complete erase over.
 */
export async function eraseEverything(repository: Repository, ownerId: string): Promise<void> {
  await repository.clear(ownerId);

  await eraseStoredEvidence();

  const keys = await AsyncStorage.getAllKeys();
  const doomed = keys.filter(
    (key) =>
      (key.startsWith(APP_KEY_PREFIX) && !KEYS_KEPT.includes(key)) || LEGACY_KEYS.includes(key),
  );
  if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);

  // Provider keys live in the platform keystore, which `getAllKeys` cannot see.
  for (const provider of AI_PROVIDER_IDS) await clearKey(provider);

  // Last, and last for a reason. The Firestore adapter keeps an on-disk copy of every
  // document it has read — the extracted text of every source included — which none of the
  // sweeps above can reach: it is not a file this app wrote and not a key `getAllKeys`
  // returns. Dropping it also drops any write still queued in it, which is why it cannot run
  // before `clear` has been acknowledged; see `Repository.dropLocalCache`. Adapters that
  // cache nothing do not implement it, so the call is optional rather than a no-op method
  // on each of them.
  //
  // It also ends this repository instance. `eraseEverything` is only ever followed by a
  // sign-out, which rebuilds one — see the caller in the profile screen.
  await repository.dropLocalCache?.();
}

/**
 * Removes the stored originals behind records that have just been tombstoned.
 *
 * ## Why a tombstone should still take the bytes with it
 *
 * `deleteEvidence` in `@data/mutations` stamps `deletedAt` and keeps the row, which is correct:
 * the audit trail has to go on showing that a document once supported a claim, or the history of
 * the case becomes unreadable. But nothing about that argument applies to the file itself. Every
 * read path in the app filters `deletedAt` out, there is no restore anywhere in the codebase, and
 * the record retains the title, the hash and the extracted summary — so the original is bytes
 * that no screen can reach and no feature will ever ask for again. On a phone that means a bank
 * statement the user believes they deleted is still sitting in the app's private directory.
 *
 * ## Why this one does not throw, when `eraseEverything` does
 *
 * The difference is what has already happened when it runs. `eraseEverything` is the whole
 * action, so a failure means the action did not happen and the user must be told. This runs
 * *after* a tombstone has been committed — the deletion the user asked for has already succeeded,
 * and the record is gone from every list. Raising here would report a failure for an action that
 * worked, and a caller that rolled back on it would resurrect a document the user deleted.
 *
 * So each file is attempted independently and the count of survivors is returned rather than
 * thrown. A caller with nowhere to put that number may ignore it; the bytes it represents are
 * reachable again by the account-wide erase, which sweeps the directory rather than the records.
 *
 * @returns how many originals could not be removed. `0` means the shred was complete.
 */
export async function eraseOriginals(
  storagePaths: readonly (string | null | undefined)[],
): Promise<number> {
  // A record whose upload never completed has no path, and a set rather than a list because
  // re-pointing a file during a sign-in handover can leave two records naming one original.
  const paths = new Set(storagePaths.filter((path): path is string => Boolean(path)));
  if (paths.size === 0) return 0;

  const outcomes = await Promise.all(
    [...paths].map((path) =>
      deleteEvidenceFile(path).then(
        () => true,
        () => false,
      ),
    ),
  );
  return outcomes.filter((removed) => !removed).length;
}

/**
 * Removes a case and shreds the originals of everything that was attached to it.
 *
 * ## Why this is a service and not four lines in a screen
 *
 * `deleteCase` tombstones one row: the case. Its evidence, claims and events keep
 * `deletedAt: null` and simply become unreachable, because every read path resolves evidence
 * *through* a visible case. That is a defensible data model — the audit trail stays intact and
 * the history of the case remains readable — but it means the domain mutation on its own leaves
 * every original file on the phone, with no record left in any list that could ever name them
 * again. A user deleting the case they built out of a bank statement, a salary slip and three
 * screenshots would be shown an empty case list with all five files still in the app's private
 * directory. `eraseEverything` would eventually sweep them, but that is the nuclear option and
 * nobody reaches for it to discard one case.
 *
 * So the deletion a user asks for is two operations that must not come apart, and putting them
 * behind one function is what stops the second one being forgotten by the next screen that
 * needs to delete a case.
 *
 * ## The order is the same as the evidence screen's, for the same reason
 *
 * Commit first, shred second. Shredding first is the version that loses data: if the commit then
 * failed, the case would still be listed, still openable, and every document inside it would be
 * a row pointing at bytes that no longer exist — a case that looks intact and is not. Committing
 * first means the worst case is a file that outlives its record, which is invisible, harmless,
 * and swept by the account-wide erase.
 *
 * ## Already-tombstoned evidence is included deliberately
 *
 * The filter is on `caseId` alone, not on `deletedAt`. A document the user removed from the case
 * earlier should already have been shredded by the evidence screen, but "already" is doing a lot
 * of work in that sentence: records written before that shred existed still have their originals,
 * and `eraseOriginals` returns rather than throws on a file that has already gone. Re-attempting
 * a file that is missing costs one rejected promise; skipping one that is present leaves a
 * document on the phone forever. The asymmetry decides it.
 *
 * @returns how many originals could not be removed. `0` means the shred was complete. The case
 *   itself is gone either way — a non-zero count is not a failed deletion.
 */
export async function removeCase(
  repository: Repository,
  workspace: Workspace,
  context: MutationContext,
  caseId: string,
): Promise<number> {
  const { changes } = deleteCase(workspace, context, caseId);
  await repository.commit(context.ownerId, changes);

  return eraseOriginals(
    workspace.evidence.filter((item) => item.caseId === caseId).map((item) => item.storagePath),
  );
}
