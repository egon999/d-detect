import {
  COLLECTIONS,
  emptyWorkspace,
  type CollectionName,
  type Case,
  type UserProfile,
  type Workspace,
} from '../domain/models';

/**
 * The persistence port.
 *
 * Two adapters implement it: one backed by AsyncStorage on the device, one by
 * Firestore. Screens depend on this interface and never on either, which is what
 * allows the whole application to be built, demonstrated and tested before a Firebase
 * project exists — and to keep working offline once one does.
 *
 * The port is deliberately narrow. Writes go through a single `commit` that takes a
 * list of changes, because that is the only shape both adapters can honour atomically:
 * Firestore gets a `writeBatch`, the local adapter gets one serialised save. Anything
 * richer would either be a lie on one side or a performance trap on the other.
 */

/** Workspace keys are exactly the case-scoped collection names. */
export type WorkspaceCollection = keyof Workspace;

/** Compile-time proof that no workspace key can drift away from a real collection. */
type AssertCollectionsMatch = WorkspaceCollection extends CollectionName ? true : never;
const _collectionsMatch: AssertCollectionsMatch = true;
void _collectionsMatch;

export type RecordOf<K extends WorkspaceCollection> = Workspace[K][number];

/** Everything persisted carries these, which is what makes the generic helpers safe. */
export interface StoredRecord {
  id: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export type PutChange = {
  [K in WorkspaceCollection]: { op: 'put'; collection: K; record: RecordOf<K> };
}[WorkspaceCollection];

export type DeleteChange = { op: 'delete'; collection: WorkspaceCollection; id: string };

/**
 * A single persisted change.
 *
 * Note there is no `update`: every write is a whole record. Partial updates would make
 * the local adapter and Firestore disagree the moment two fields changed at once, and
 * records here are small enough that rewriting one costs nothing.
 */
export type Change = PutChange | DeleteChange;

export function put<K extends WorkspaceCollection>(collection: K, record: RecordOf<K>): Change {
  return { op: 'put', collection, record } as Change;
}

export function remove(collection: WorkspaceCollection, id: string): Change {
  return { op: 'delete', collection, id };
}

export type Unsubscribe = () => void;

/**
 * How far a returned `commit` actually got.
 *
 * Every adapter but the Firestore one has a single answer: the write is finished when the
 * call returns. Firestore is the exception, and not incidentally — it applies a batch to
 * its own on-disk cache immediately and resolves the promise it hands back only once the
 * server has acknowledged it, so a commit made with no connection is durable on the device
 * long before anything can confirm it landed anywhere else.
 *
 * `LOCAL_PENDING` is that state, and it is a success, not a soft failure: the records are
 * saved, and the SDK replays them when the device reconnects. It is on the port so a screen
 * can say "saved on this device" rather than either claiming a server it never reached or
 * showing an error over data that is in no danger.
 */
export type CommitDurability = 'SERVER' | 'LOCAL_PENDING';

export interface CommitOutcome {
  durability: CommitDurability;
}

export interface Repository {
  /** Which adapter this is. Shown in the developer/diagnostics screen, never branched on. */
  readonly kind: 'local' | 'firebase' | 'remote';

  loadProfile(userId: string): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<void>;

  /** Case summaries for the case list. Excludes soft-deleted cases. */
  listCases(ownerId: string): Promise<Case[]>;

  /**
   * Everything belonging to one case, in memory. Cases here are documents-and-notes
   * scale, not gigabytes, so the reasoning engine gets the whole picture at once
   * rather than paginating — which is also what lets it stay a pure function.
   */
  loadWorkspace(ownerId: string, caseId: string): Promise<Workspace>;

  /** Owner-scoped data for account search and activity, when the adapter can fetch it once. */
  loadAllWorkspace?(ownerId: string): Promise<Workspace>;

  /** Applies changes as one unit. Throws if any record's `ownerId` is not `ownerId`. */
  commit(ownerId: string, changes: readonly Change[]): Promise<CommitOutcome>;

  /**
   * Removes everything belonging to one owner, including records a soft delete has
   * already hidden.
   *
   * This is the one operation that cannot be expressed as a list of `Change`s, which is
   * why it earns a place on the port rather than living on an adapter. `commit` can only
   * delete records the caller can name, and the caller names them through `listCases` and
   * `loadWorkspace` — both of which filter out anything carrying `deletedAt`. An erase
   * assembled from those would leave behind the soft-deleted remains of every case the
   * user ever discarded, which is precisely the material they are asking to be rid of.
   *
   * An adapter must make this total for the owner or throw. A partial erase reported as
   * success is worse than a refusal, because the user stops looking for what is left.
   */
  clear(ownerId: string): Promise<void>;

  /**
   * Calls back whenever the case changes. The Firestore adapter uses snapshot
   * listeners; the local adapter emits after its own commits. Screens therefore use
   * one reactive model regardless of where the data lives.
   */
  watchWorkspace(
    ownerId: string,
    caseId: string,
    onChange: (workspace: Workspace) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe;

  watchCases(
    ownerId: string,
    onChange: (cases: Case[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Shared helpers, used by both adapters and by tests
// ---------------------------------------------------------------------------

export const WORKSPACE_COLLECTIONS: readonly WorkspaceCollection[] = [
  COLLECTIONS.cases,
  COLLECTIONS.claims,
  COLLECTIONS.events,
  COLLECTIONS.evidence,
  COLLECTIONS.relationships,
  COLLECTIONS.analysisResults,
  COLLECTIONS.auditLogs,
  COLLECTIONS.processingJobs,
  COLLECTIONS.aiSuggestions,
  COLLECTIONS.caseAnalyses,
  COLLECTIONS.seals,
];

/**
 * Applies changes to an in-memory workspace.
 *
 * Used by the local adapter to persist, and by the UI to show a write immediately
 * rather than waiting for a round trip. Both call the same function, so what the user
 * sees during the write is what gets stored.
 */
export function applyChanges(workspace: Workspace, changes: readonly Change[]): Workspace {
  const next: Workspace = { ...workspace };
  // Group first so that ten evidence writes rebuild the evidence array once, not ten
  // times. Analysis runs commit a few dozen records at a time.
  const touched = new Set<WorkspaceCollection>();
  for (const change of changes) touched.add(change.collection);

  for (const collection of touched) {
    const existing = next[collection] as StoredRecord[];
    const byId = new Map(existing.map((record) => [record.id, record]));

    for (const change of changes) {
      if (change.collection !== collection) continue;
      if (change.op === 'delete') byId.delete(change.id);
      else byId.set(change.record.id, change.record as StoredRecord);
    }

    // Stable order by id so that a re-render never reshuffles a list for no reason.
    const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    (next as Record<WorkspaceCollection, StoredRecord[]>)[collection] = merged;
  }

  return next;
}

/** Narrows a full store to the records of one case, which is what a screen ever needs. */
export function workspaceForCase(workspace: Workspace, caseId: string): Workspace {
  const scoped = emptyWorkspace();
  scoped.cases = workspace.cases.filter((item) => item.id === caseId);
  for (const collection of WORKSPACE_COLLECTIONS) {
    if (collection === 'cases') continue;
    const records = workspace[collection] as Array<StoredRecord & { caseId: string }>;
    (scoped as Record<WorkspaceCollection, StoredRecord[]>)[collection] = records.filter(
      (record) => record.caseId === caseId,
    );
  }
  return scoped;
}

/**
 * Rejects a commit that would write another user's data.
 *
 * Security Rules are the real boundary and this check cannot replace them — a client
 * check is advice, not enforcement. It exists so that a bug in a mutation surfaces
 * here, with a readable message, instead of as a permission-denied error from
 * Firestore that gives no hint which record was wrong.
 */
export function assertOwnership(ownerId: string, changes: readonly Change[]): void {
  for (const change of changes) {
    if (change.op !== 'put') continue;
    const record = change.record as StoredRecord;
    if (record.ownerId !== ownerId) {
      throw new Error(
        `Refusing to write ${change.collection}/${record.id}: owned by ${record.ownerId}, not ${ownerId}`,
      );
    }
  }
}
