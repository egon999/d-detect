import {
  COLLECTIONS,
  aiSuggestionSchema,
  analysisResultSchema,
  auditLogSchema,
  caseAnalysisSchema,
  caseEventSchema,
  caseSchema,
  claimSchema,
  emptyWorkspace,
  evidenceSchema,
  processingJobSchema,
  relationshipSchema,
  sealSchema,
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

/**
 * The largest change set `commit` applies as one unit.
 *
 * Firestore caps a `WriteBatch` at 500 operations, so the Firestore adapter splits anything
 * longer across several batches. That is the only thing it can do, but it costs the guarantee
 * in `commit`'s contract: above this bound an early batch can land and a later one be rejected,
 * leaving a half-written result that no adapter can roll back and no caller is told about.
 *
 * The bound lives on the port, not inside the adapter, because a caller that *depends* on
 * atomicity has to be able to size its work against it — and when the number was duplicated
 * instead, the two copies drifted. Exactly one caller is anywhere near it: the device-case
 * handover (`src/services/migration-plan.ts`), which refuses an oversized case outright rather
 * than move half of it into the account. Every other commit in the app is a handful of records.
 */
export const MAX_ATOMIC_CHANGES = 400;

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

  /**
   * Applies changes as one unit, up to `MAX_ATOMIC_CHANGES`. A longer change set is split by
   * the Firestore adapter and is no longer all-or-nothing, so a caller that needs atomicity
   * must size its work against that bound rather than assume it. Throws if any record's
   * `ownerId` is not `ownerId`.
   */
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
   * Drops whatever this adapter has cached on the device, for adapters that cache at all.
   *
   * `clear` removes an owner's records from the store of record. That is not the same as
   * removing them from this device: the Firestore adapter keeps an on-disk cache of every
   * document it has ever read, which is how a case opened once stays readable with no
   * connection — and which means the full extracted text of a user's evidence outlives the
   * erase that was supposed to end it. `eraseEverything` already sweeps the app's own files
   * and keys; this is the part of the device it could not otherwise reach.
   *
   * **Two things a caller has to honour.**
   *
   * It runs last. Dropping the cache also drops any write still queued in it, so calling this
   * before `clear` has been acknowledged by the server would discard the very deletions the
   * erase depends on and leave the account intact while telling the user it was emptied.
   *
   * The adapter is unusable afterwards. Implementations may terminate their client to release
   * the store, so the caller must sign out or otherwise rebuild the repository rather than
   * keep using this instance.
   *
   * **What it does not buy.** Firestore's own documentation is explicit that clearing
   * persistence "does not attempt to securely overwrite or otherwise make cached data
   * unrecoverable", and recommends not enabling persistence at all where that matters. So this
   * ends the app's access to the data; it is not a guarantee against someone with the device
   * and a forensic tool. Closing that gap means giving up offline reads, which is a product
   * decision and not one an adapter should make quietly.
   */
  dropLocalCache?(): Promise<void>;

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

/** What a boundary parse needs of a zod schema, and nothing more. */
export interface Parseable<T = unknown> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

/**
 * The schema each collection's records are read back through.
 *
 * `workspaceSchema` validates the assembled object, which is all-or-nothing: one record
 * written by an older build fails the parse and takes the entire case — or, through
 * `loadAllWorkspace`, the entire account — with it. Reading a collection through its own
 * record schema is what lets a single bad row be skipped the way `listCases` already skips
 * one.
 *
 * It sits on the port rather than inside an adapter because both stores face the same
 * problem and neither can migrate its way out: Firestore is schemaless, and the device keys
 * are versioned `v1` with nothing behind that version, so a record written by any past build
 * is read back exactly as it was written, indefinitely. Keeping one table is what stops the
 * two answers diverging — they already had, and the device adapter's answer was to validate
 * nothing at all, which let a renamed enum member reach the UI lookup tables that index it
 * (`RELATIONSHIP_TONE`, `ACTION_META`) as a value TypeScript had promised was present.
 */
export const RECORD_SCHEMAS: { [K in WorkspaceCollection]: Parseable<RecordOf<K>> } = {
  cases: caseSchema,
  claims: claimSchema,
  events: caseEventSchema,
  evidence: evidenceSchema,
  relationships: relationshipSchema,
  analysisResults: analysisResultSchema,
  auditLogs: auditLogSchema,
  processingJobs: processingJobSchema,
  aiSuggestions: aiSuggestionSchema,
  caseAnalyses: caseAnalysisSchema,
  seals: sealSchema,
};

/**
 * What an adapter calls the rows it reads, which is the only thing the three disagree about.
 *
 * Kept as data rather than as three copies of a log line, because the wording is the part that
 * has to differ — a developer reading `[local] skipping malformed record` against
 * `[firestore] skipping malformed document` can tell which store lost the row, and that is the
 * first thing worth knowing. Everything else about the decision is identical, so it is shared.
 */
export interface SkipSource {
  /** The bracketed prefix every line carries: `local`, `firestore`, `remote`. */
  readonly adapter: string;
  /** One row, as this store names it. Firestore has documents; the other two have records. */
  readonly noun: string;
}

/**
 * Drops the rows of a read that will not parse, and keeps a tally of them.
 *
 * The boundary all three adapters hold, and it lives next to `RECORD_SCHEMAS` for the reason
 * that docblock already argues at length: both stores face the same drift with no migration
 * behind either of them, and the moment the answer to it was written per adapter the answers
 * diverged — the device adapter's was to validate nothing at all. This had since become three
 * copies of the same twenty lines, which is the same defect one turn further along: a fix to
 * the tolerance below, or to what a warning is allowed to say, would have had to be made three
 * times and would have been made once.
 *
 * **Per row, not per read.** `workspaceSchema` validates an assembled workspace, which is
 * all-or-nothing: one record written by an older build fails the parse and takes the entire
 * case — or, through `loadAllWorkspace`, the entire account — with it. That failure is not
 * recoverable from any screen, because there is nowhere in this app to reach a document the app
 * refuses to read. Skipping the row makes the cost of drift the row.
 *
 * **A warning names the collection and the count, and nothing else.** This is an evidence app.
 * The row carries the title of a case a user is in a dispute over and the text of the documents
 * they uploaded to prove it; the storage key, the document path and the request all carry the
 * owner id. None of that is needed to act on a skipped row, so none of it is logged.
 *
 * **The tally is the number worth acting on.** One skipped row and four hundred of them read
 * identically in a log, and only the second means a case has quietly lost most of itself.
 */
export class Skipped {
  private count = 0;

  constructor(private readonly source: SkipSource) {}

  /**
   * `rows` is whatever the store handed back under this key, which is not necessarily a list.
   *
   * A slot holding an object keyed by id, or a string, is drift of exactly the kind being caught
   * here — and iterating it would throw where the entire point is to skip it, turning the
   * boundary that makes a case readable into the reason it is not. The Firestore adapter cannot
   * reach that branch, since it only ever passes the result of mapping a query snapshot's docs;
   * it costs that adapter nothing to be safe, and the other two are read straight out of storage
   * and off the wire.
   *
   * A slot that is absent is not a skipped row. Warning on one would put a line in the log for
   * every case stored before `seals` existed.
   */
  keep<K extends WorkspaceCollection>(collection: K, rows: unknown): Array<RecordOf<K>> {
    if (!Array.isArray(rows)) {
      if (rows !== undefined && rows !== null) this.drop(collection);
      return [];
    }
    const kept: Array<RecordOf<K>> = [];
    for (const row of rows) {
      const parsed = RECORD_SCHEMAS[collection].safeParse(row);
      if (parsed.success) kept.push(parsed.data);
      else this.drop(collection);
    }
    return kept;
  }

  /**
   * Says once that a read lost rows, and how many.
   *
   * `scope` names what was being read — a case, an account, the case list — and is passed per
   * call rather than fixed per adapter because one adapter read can span several: the device
   * adapter opens a case out of both a shard and the case index, and a log that called both of
   * them "a case" would leave a developer unable to tell which of the two is losing rows.
   * It never names which case, or whose.
   */
  report(scope: string): void {
    if (this.count === 0) return;
    console.warn(
      `[${this.source.adapter}] read ${scope} with ${this.count} unreadable ${this.source.noun}(s) ` +
        'skipped; those records are not visible in the app',
    );
  }

  private drop(collection: WorkspaceCollection): void {
    this.count += 1;
    console.warn(`[${this.source.adapter}] skipping malformed ${this.source.noun} in ${collection}`);
  }
}

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
