import {
  emptyWorkspace,
  userProfileSchema,
  type Case,
  type UserProfile,
  type Workspace,
} from '../../domain/models';
import {
  applyChanges,
  assertOwnership,
  Skipped,
  WORKSPACE_COLLECTIONS,
  type Change,
  type CommitOutcome,
  type Repository,
  type SkipSource,
  type StoredRecord,
  type Unsubscribe,
  type WorkspaceCollection,
} from '../repository';
import type { KeyValueStore } from './key-value-store';

/**
 * On-device repository.
 *
 * Backs the whole application when the user is offline, and backs the demonstration
 * outright so the app can be shown on a phone with no Firebase project, no network and
 * no hosting. It implements the same port as the Firestore adapter, so no screen knows
 * which one it is talking to.
 *
 * Storage is sharded one key per case rather than one blob per user. AsyncStorage on
 * Android has a bounded total size, and a case carries the source text of every
 * document in it; keeping each write to a single case keeps both the payload and the
 * parse cost proportional to what actually changed.
 */

const VERSION = 'v1';
const prefix = (userId: string) => `detact:${VERSION}:${userId}`;
const profileKey = (userId: string) => `${prefix(userId)}:profile`;
const indexKey = (userId: string) => `${prefix(userId)}:cases`;
const caseKey = (userId: string, caseId: string) => `${prefix(userId)}:case:${caseId}`;

/** The case-scoped collections. `cases` lives in the index, not in the per-case shard. */
type ScopedCollection = Exclude<WorkspaceCollection, 'cases'>;

const SCOPED_COLLECTIONS = WORKSPACE_COLLECTIONS.filter(
  (name): name is ScopedCollection => name !== 'cases',
);

type Shard = Record<ScopedCollection, StoredRecord[]>;

function emptyShard(): Shard {
  const shard = {} as Shard;
  for (const collection of SCOPED_COLLECTIONS) shard[collection] = [];
  return shard;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupted shard is recoverable: the user loses that case's local copy, not the
    // app. Throwing here would make the whole case list unopenable.
    return fallback;
  }
}

/** Every persisted record carries a caseId except the `Case` document itself. */
const caseIdOf = (record: StoredRecord): string => (record as { caseId?: string }).caseId ?? '';

/**
 * How a skipped row is named in a log line from this adapter.
 *
 * The tallying itself is `Skipped`, on the port beside `RECORD_SCHEMAS`, because the device
 * store and the two remote ones face the same drift and had already answered it differently
 * once — this adapter's answer, before the shard boundary existed, was to validate nothing.
 * What stays here is the wording: `[local]` is how a developer reading a log tells a row this
 * phone lost from one a server did.
 */
const LOCAL_SKIPS: SkipSource = { adapter: 'local', noun: 'record' };

export class LocalRepository implements Repository {
  readonly kind = 'local' as const;

  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly store: KeyValueStore) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async loadProfile(userId: string): Promise<UserProfile | null> {
    const raw = await this.store.get(profileKey(userId));
    if (!raw) return null;
    const parsed = userProfileSchema.safeParse(parseJson<unknown>(raw, null));
    return parsed.success ? parsed.data : null;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    await this.store.setMany([[profileKey(profile.id), JSON.stringify(profile)]]);
  }

  async listCases(ownerId: string): Promise<Case[]> {
    const cases = await this.readIndex(ownerId);
    return cases
      .filter((item) => !item.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadWorkspace(ownerId: string, caseId: string): Promise<Workspace> {
    const [cases, shard] = await Promise.all([this.readIndex(ownerId), this.readShard(ownerId, caseId)]);
    const workspace = emptyWorkspace();
    workspace.cases = cases.filter((item) => item.id === caseId);
    for (const collection of SCOPED_COLLECTIONS) {
      (workspace as Record<WorkspaceCollection, StoredRecord[]>)[collection] = shard[collection];
    }
    return workspace;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  private commitChain: Promise<unknown> = Promise.resolve();

  /**
   * Applies a change set.
   *
   * AsyncStorage offers no cross-key transaction, so a commit spanning the case index
   * and a case shard is two writes. They are issued as one `multiSet` — the closest
   * thing to atomic the platform gives — and the shards are independent, so a torn
   * write can leave a case stale but never leaves a record half-written.
   *
   * Writes are serialized through a promise-based mutex chain so concurrent writes
   * cannot race each other during shard read-modify-write cycles.
   *
   * Always `SERVER`: this device *is* the store of record here, so there is no second copy
   * for a returned commit to still be waiting on.
   */
  async commit(ownerId: string, changes: readonly Change[]): Promise<CommitOutcome> {
    if (!changes.length) return { durability: 'SERVER' };
    const run = () => this.executeCommit(ownerId, changes);
    const next = this.commitChain.then(run, run);
    this.commitChain = next.catch(() => {});
    return next;
  }

  private async executeCommit(ownerId: string, changes: readonly Change[]): Promise<CommitOutcome> {
    assertOwnership(ownerId, changes);

    const caseChanges = changes.filter((change) => change.collection === 'cases');
    const scopedChanges = changes.filter((change) => change.collection !== 'cases');

    const entries: Array<[string, string]> = [];
    const touchedCaseIds = new Set<string>();

    // Resolve which shard each change belongs to. Puts carry their caseId; deletes
    // carry only an id, so the current shard contents are searched for it.
    const shardsNeeded = new Set<string>();
    for (const change of scopedChanges) {
      if (change.op === 'put') shardsNeeded.add(caseIdOf(change.record as StoredRecord));
    }
    const unresolvedDeletes = scopedChanges.filter((change) => change.op === 'delete');
    if (unresolvedDeletes.length) {
      // A delete without a known case has to be searched for, which is why callers
      // should keep change sets scoped to one case — they almost always are.
      for (const caseId of await this.caseIdsFor(ownerId)) shardsNeeded.add(caseId);
    }

    const shards = new Map<string, Shard>();
    await Promise.all(
      [...shardsNeeded].filter(Boolean).map(async (caseId) => {
        shards.set(caseId, await this.readShard(ownerId, caseId));
      }),
    );

    for (const change of scopedChanges) {
      if (change.op === 'put') {
        const caseId = caseIdOf(change.record as StoredRecord);
        const shard = shards.get(caseId) ?? emptyShard();
        shards.set(caseId, shard);
        const collection = change.collection as ScopedCollection;
        const without = shard[collection].filter((item) => item.id !== change.record.id);
        shard[collection] = [...without, change.record as StoredRecord].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        touchedCaseIds.add(caseId);
      } else {
        const collection = change.collection as ScopedCollection;
        for (const [caseId, shard] of shards) {
          if (!shard[collection].some((item) => item.id === change.id)) continue;
          shard[collection] = shard[collection].filter((item) => item.id !== change.id);
          touchedCaseIds.add(caseId);
        }
      }
    }

    for (const caseId of touchedCaseIds) {
      const shard = shards.get(caseId);
      if (shard) entries.push([caseKey(ownerId, caseId), JSON.stringify(shard)]);
    }

    if (caseChanges.length) {
      const index = applyChanges({ ...emptyWorkspace(), cases: await this.readIndex(ownerId) }, caseChanges);
      entries.push([indexKey(ownerId), JSON.stringify(index.cases)]);
      for (const change of caseChanges) {
        touchedCaseIds.add(change.op === 'put' ? change.record.id : change.id);
      }
    }

    await this.store.setMany(entries);
    this.emit(ownerId, touchedCaseIds);
    return { durability: 'SERVER' };
  }

  // -------------------------------------------------------------------------
  // Change notification
  // -------------------------------------------------------------------------

  /**
   * Local data only changes because this process changed it, so "watching" is an
   * in-process emitter rather than a poll. Screens get the same push model they get
   * from Firestore snapshots, and the initial value is delivered immediately.
   */
  watchWorkspace(
    ownerId: string,
    caseId: string,
    onChange: (workspace: Workspace) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    return this.watch(`${ownerId}:${caseId}`, () => this.loadWorkspace(ownerId, caseId), onChange, onError);
  }

  watchCases(
    ownerId: string,
    onChange: (cases: Case[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    return this.watch(`${ownerId}:*`, () => this.listCases(ownerId), onChange, onError);
  }

  /**
   * Shared subscription mechanics.
   *
   * A read is already in flight when `unsubscribe` is called during the first tick, so
   * delivery is gated on a cancellation flag as well as on removal from the emitter.
   * Firestore's `onSnapshot` makes the same guarantee, and a screen that has navigated
   * away must not have stale data pushed into it.
   */
  private watch<T>(
    key: string,
    read: () => Promise<T>,
    onChange: (value: T) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    let active = true;
    const deliver = () => {
      read().then(
        (value) => {
          if (active) onChange(value);
        },
        (error: unknown) => {
          if (active) onError?.(toError(error));
        },
      );
    };
    deliver();
    const unsubscribe = this.subscribe(key, deliver);
    return () => {
      active = false;
      unsubscribe();
    };
  }

  /**
   * Removes every local record for a user.
   *
   * Key-prefix deletion rather than a walk of the case index, which is what makes it
   * total: a shard whose case row was soft-deleted, or one the index lost track of,
   * shares the same `detact:v1:{ownerId}:` prefix and goes with the rest.
   */
  async clear(ownerId: string): Promise<void> {
    const keys = (await this.store.keys()).filter((key) => key.startsWith(`${prefix(ownerId)}:`));
    await this.store.remove(keys);
    this.emit(ownerId, new Set(['*']));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async readIndex(ownerId: string): Promise<Case[]> {
    const raw = await this.store.get(indexKey(ownerId));
    // The same boundary the shard below holds, on the same terms, which it did not used to be.
    // Dropping the drifted row was already right — a case written by an older build must not
    // flow into the reasoning engine half-shaped — but it was done in silence and only ever
    // over a list.
    //
    // Silence is the wrong answer to a case that has disappeared. It is the most alarming thing
    // this app can do to a user, it is the one screen they cannot navigate around, and there was
    // no line anywhere saying it had happened or how many times.
    //
    // And the list was assumed, not checked: `parseJson` was asked for an `unknown[]` and casts
    // to it without looking, so an index a build had written as an object keyed by id reached
    // `.flatMap` and threw a `TypeError` straight out of `listCases`. That is a strictly worse
    // failure than the shard equivalent it mirrors — a shard that will not read costs one case,
    // while this backs the screen the app opens on, so every case in the account becomes
    // unreachable at once. `keep` answers with an empty list instead.
    const skipped = new Skipped(LOCAL_SKIPS);
    const cases = skipped.keep('cases', parseJson<unknown>(raw, []));
    // Named apart from the shard's scope on purpose: `loadWorkspace` reads both in one call, and
    // a log that called them both "a case" could not say which of the two lost the row.
    skipped.report('the case list');
    return cases;
  }

  private async caseIdsFor(ownerId: string): Promise<string[]> {
    return (await this.readIndex(ownerId)).map((item) => item.id);
  }

  private async readShard(ownerId: string, caseId: string): Promise<Shard> {
    const raw = await this.store.get(caseKey(ownerId, caseId));
    const parsed = parseJson<Partial<Record<ScopedCollection, unknown>>>(raw, {});
    const shard = emptyShard();
    // The same boundary `readIndex` holds, over the collections every screen renders from.
    // `parseJson` above rejects only a shard that is not JSON; a row that is valid JSON and
    // the wrong shape passed straight through — and the keys are versioned `v1` with no
    // migration behind them, so a record written by any build this phone has ever run is
    // read back exactly as it was written, for as long as the app stays installed.
    //
    // Per row rather than per shard, because the alternative is an unopenable case: one
    // stale claim would otherwise take the case's evidence, links and audit trail with it,
    // and there is no screen from which a user can reach a case the app refuses to read.
    const skipped = new Skipped(LOCAL_SKIPS);
    for (const collection of SCOPED_COLLECTIONS) {
      shard[collection] = skipped.keep(collection, parsed[collection]);
    }
    skipped.report('a case');
    return shard;
  }

  private subscribe(key: string, listener: () => void): Unsubscribe {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  private emit(ownerId: string, caseIds: ReadonlySet<string>): void {
    // Case-list watchers always fire: any case-scoped write can change a case's
    // updatedAt ordering or its finding counts.
    for (const listener of this.listeners.get(`${ownerId}:*`) ?? []) listener();
    if (caseIds.has('*')) {
      for (const [key, set] of this.listeners) {
        if (key.startsWith(`${ownerId}:`)) for (const listener of set) listener();
      }
      return;
    }
    for (const caseId of caseIds) {
      for (const listener of this.listeners.get(`${ownerId}:${caseId}`) ?? []) listener();
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
