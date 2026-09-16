/**
 * Moving work from device storage into a signed-in account.
 *
 * The reasoning behind the whole feature — why the gap exists and why records cross intact —
 * is in `./migration-plan.ts`. This module is the part that touches storage: it finds what is
 * on the device, reads one case out of it, commits that case to the account through the
 * active repository, and moves the original files to follow their records.
 *
 * ## Order of operations, and why it is this order
 *
 * The commit lands first, then the files move, then the device copy is cleared — and only if
 * the caller asks. Each step is safe to fail at:
 *
 * - Commit fails: nothing has moved, the device copy is untouched, retry is free.
 * - A file move fails: the case exists in the account with its extracted text and findings,
 *   and the record says its original is missing. Recoverable by re-adding one file, and
 *   reported rather than swallowed.
 * - Clearing fails: the case exists in both places. Harmless, and visible.
 *
 * The reverse order — clear first, or move files first — turns any failure into data loss.
 */

import { createAsyncStorageStore } from '@data/local/async-storage-store';
import { LocalRepository } from '@data/local/local-repository';
import type { Repository } from '@data/repository';
import type { Case, Workspace } from '@domain/models';

import { planCaseHandover, type CaseHandoverPlan } from './migration-plan';

/** The key shape `LocalRepository` writes: `detact:v1:{ownerId}:cases`. */
const CASE_INDEX_KEY = /^detact:v1:(.+):cases$/;

/** A case sitting in device storage, with the local owner id needed to read it. */
export interface DeviceCase {
  record: Case;
  /** The device-generated owner id the case was created under. */
  deviceOwnerId: string;
}

function deviceRepository(): LocalRepository {
  return new LocalRepository(createAsyncStorageStore());
}

/**
 * Every owner id with a case index in device storage.
 *
 * Enumerated from the keys rather than remembered, because the point of this feature is to
 * find work whose owner id the app has since stopped using. A device that has been used
 * anonymously more than once has more than one.
 */
async function deviceOwnerIds(): Promise<string[]> {
  const keys = await createAsyncStorageStore().keys();
  const owners = new Set<string>();
  for (const key of keys) {
    const owner = CASE_INDEX_KEY.exec(key)?.[1];
    // A key with a colon in the owner segment would be malformed; the regex is greedy, so
    // guard against matching a longer key shape added later.
    if (owner && !owner.includes(':')) owners.add(owner);
  }
  return [...owners];
}

/**
 * Cases held in device storage that are not the account's own.
 *
 * `exceptOwnerId` is the signed-in uid. Its own local records are excluded because those are
 * the account's offline cache, not orphaned work — offering to "move" them into the account
 * they already belong to would be nonsense.
 */
export async function listDeviceCases(exceptOwnerId: string): Promise<DeviceCase[]> {
  const repository = deviceRepository();
  const owners = (await deviceOwnerIds()).filter((owner) => owner !== exceptOwnerId);

  const groups = await Promise.all(
    owners.map(async (deviceOwnerId) => {
      const cases = await repository.listCases(deviceOwnerId);
      return cases.map((record) => ({ record, deviceOwnerId }));
    }),
  );

  // Most recently worked on first: the case someone is trying to recover is almost always
  // the one they were last in.
  return groups.flat().sort((a, b) => b.record.updatedAt - a.record.updatedAt);
}

/** Reads one case out of device storage, for review before anything is written. */
export async function loadDeviceCase(deviceOwnerId: string, caseId: string): Promise<Workspace> {
  return deviceRepository().loadWorkspace(deviceOwnerId, caseId);
}

/**
 * Deletes everything device storage holds under one device owner id.
 *
 * Separated from `handOverDeviceCase` so the UI can offer it as its own decision, taken after
 * the account copy is visibly confirmed. A single tap that writes to the account *and* deletes
 * the only other copy leaves no state in which the user can check the move worked.
 *
 * Note the granularity: the device owner id, not the case. `LocalRepository.clear` works on the
 * owner prefix, and an anonymous session's owner id covers exactly the cases created in that
 * session — so the caller must only offer this once nothing else under that id is left to move.
 */
export async function clearDeviceCases(deviceOwnerId: string): Promise<void> {
  await deviceRepository().clear(deviceOwnerId);
}

export interface HandoverOutcome {
  caseId: string;
  /** Sources whose original file arrived with them. */
  filesMoved: number;
  /**
   * Sources whose file could not be found on disk.
   *
   * Not an error: a case can legitimately reach this point with a missing original — the
   * device store was cleared, or the record was a typed note all along. The count is
   * surfaced so the user is told rather than left to discover it in the viewer.
   */
  filesMissing: number;
}

export interface HandoverOptions {
  /** Where the case is going. Must be the repository the app is currently reading from. */
  repository: Repository;
  /** The signed-in account's owner id. */
  toOwnerId: string;
  deviceOwnerId: string;
  caseId: string;
  /** The workspace already read by `loadDeviceCase`, so the review and the write agree. */
  workspace: Workspace;
  /** Remove the device copy once the account copy is confirmed. Off by default. */
  clearDeviceCopy?: boolean;
  now?: number;
}

/** Plans a handover without performing it, for the review step. */
export function previewHandover(options: Omit<HandoverOptions, 'repository' | 'clearDeviceCopy'>): CaseHandoverPlan {
  return planCaseHandover(
    options.deviceOwnerId,
    options.toOwnerId,
    options.caseId,
    options.workspace,
    options.now ?? Date.now(),
  );
}

/**
 * Moves one case from device storage into the account.
 *
 * Throws only when nothing has been written. Past the commit, problems are returned in the
 * outcome instead — by then the case exists in the account and the correct thing to do is
 * tell the user what arrived, not raise an exception that makes a partial success look like a
 * total failure.
 */
export async function handOverDeviceCase(options: HandoverOptions): Promise<HandoverOutcome> {
  const plan = planCaseHandover(
    options.deviceOwnerId,
    options.toOwnerId,
    options.caseId,
    options.workspace,
    options.now ?? Date.now(),
  );

  await options.repository.commit(options.toOwnerId, plan.changes);

  // Imported lazily: the storage module reaches expo-file-system, and this module is
  // otherwise pure enough to test in Node.
  const { moveEvidenceFile } = await import('./storage/evidence-storage');

  let filesMoved = 0;
  let filesMissing = 0;
  for (const move of plan.fileMoves) {
    try {
      if (await moveEvidenceFile(move.from, move.to)) filesMoved++;
      else filesMissing++;
    } catch {
      // One unmovable file must not abandon the rest. The record's path now points at a
      // location with nothing in it, which the viewer reports as a missing original — the
      // honest outcome, and the same one the user would see after clearing app storage.
      filesMissing++;
    }
  }

  if (options.clearDeviceCopy) {
    try {
      await deviceRepository().clear(options.deviceOwnerId);
    } catch {
      // The account copy is the one that matters and it is already written. A leftover
      // device copy costs storage, not correctness.
    }
  }

  return { caseId: options.caseId, filesMoved, filesMissing };
}
