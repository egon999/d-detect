/**
 * Cloud repository.
 *
 * The Firestore implementation of the `Repository` port. No screen imports this file
 * directly; `src/services/repository-provider.tsx` picks between this and the local
 * adapter, and everything above that line is written against the port.
 *
 * ## Document layout
 *
 * One top-level collection per entity type (`cases`, `claims`, `events`, …), not
 * subcollections under each case. Two reasons:
 *
 *   - Security Rules can authorise a document by reading its own `ownerId` field. A
 *     subcollection layout would force a `get()` on the parent case for every read, and
 *     Firestore bills those.
 *   - The per-case view is one query with a `where('caseId', '==', …)`, which is exactly
 *     what the port's `loadWorkspace` needs.
 *
 * The cost is that a case-scoped query needs a composite index on `(caseId, id)`, which is
 * declared in `firestore.indexes.json` rather than created by hand in the console.
 *
 * ## Why every read is validated
 *
 * Documents are parsed through the zod schemas in `src/domain/models.ts` on the way in.
 * Firestore is schemaless, so a document written by an older build, a console edit or a
 * Cloud Function bug would otherwise enter the app as a shape the domain layer believes is
 * impossible — and fail three screens later with an unrelated error. Failing at the
 * boundary names the actual problem.
 */

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  where,
  writeBatch,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

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
  userProfileSchema,
  workspaceSchema,
  type Case,
  type UserProfile,
  type Workspace,
} from '../../domain/models';
import {
  assertOwnership,
  WORKSPACE_COLLECTIONS,
  type Change,
  type CommitDurability,
  type CommitOutcome,
  type Repository,
  type Unsubscribe,
  type WorkspaceCollection,
} from '../repository';
import {
  firebaseEmulatorHost,
  getFirebaseConfig,
  useFirebaseEmulator,
  type FirebaseConfig,
} from './config';

/**
 * Firestore's hard limit is 500 writes per batch. Staying well under it leaves room for
 * the audit entry a mutation appends, and a smaller batch is also a smaller retry on
 * failure — the pipeline is idempotent, so a partial commit is recoverable.
 */
const MAX_BATCH_WRITES = 400;

/**
 * How long a commit waits for the server before it reports the write as queued.
 *
 * `WriteBatch.commit()` resolves on *server acknowledgement*, not on the local write. The
 * local write has already happened by then — Firestore applies a batch to its own
 * persistent cache as the batch is issued, and replays it when the device reconnects — so
 * with no connection the returned promise does not fail, it simply never settles. Every
 * caller that awaits it inherits that: `useMutator` holds its spinner up, and the upload
 * screen holds a mutex nothing can release.
 *
 * Ten seconds is the compromise. Long enough that a slow but live connection still gets to
 * report `SERVER`, short enough that someone on a train is not watching a spinner spin over
 * data that is already safely on their phone.
 */
export const COMMIT_ACK_TIMEOUT_MS = 10_000;

/**
 * The schema each workspace collection's documents are read through.
 *
 * `workspaceSchema` validates the assembled object, which is all-or-nothing: one document
 * written by an older build fails the parse and takes the entire case — or, through
 * `loadAllWorkspace`, the entire account — with it. Reading a collection through its own
 * record schema is what lets a single bad row be skipped the way `listCases` and
 * `watchCases` already skip one.
 */
const RECORD_SCHEMAS: Record<WorkspaceCollection, Parseable> = {
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

export class FirebaseRepository implements Repository {
  readonly kind = 'firebase' as const;

  constructor(private readonly db: Firestore) {}

  /**
   * The Firestore handle. Exposed read-only for the storage layer and for diagnostics;
   * nothing in the UI layer should reach for it.
   */
  get database(): Firestore {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async loadProfile(userId: string): Promise<UserProfile | null> {
    const snapshot = await getDoc(doc(this.db, COLLECTIONS.users, userId));
    if (!snapshot.exists()) return null;
    return parseOrNull(userProfileSchema, snapshot.data(), `users/${userId}`);
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const parsed = userProfileSchema.parse(profile);
    const batch = writeBatch(this.db);
    batch.set(doc(this.db, COLLECTIONS.users, parsed.id), cleanForFirestore(parsed) as object, { merge: true });
    await batch.commit();
  }

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------

  async listCases(ownerId: string): Promise<Case[]> {
    // Ordered by the client and filtered in code rather than with a `deletedAt == null`
    // clause: the soft-delete filter is a product rule, and keeping it in one place means
    // a change to it does not require a new index.
    const snapshot = await getDocs(
      query(collection(this.db, COLLECTIONS.cases), where('ownerId', '==', ownerId)),
    );

    const cases: Case[] = [];
    for (const document of snapshot.docs) {
      const parsed = parseOrNull(caseSchema, document.data(), `${COLLECTIONS.cases}/${document.id}`);
      if (parsed && parsed.deletedAt === null) cases.push(parsed);
    }

    // Newest first. Done here rather than with `orderBy` to avoid requiring the client to
    // have the index before it can show anything at all.
    return cases.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // -------------------------------------------------------------------------
  // Workspace
  // -------------------------------------------------------------------------

  /**
   * One case, whole.
   *
   * Documents are parsed one at a time rather than as an assembled workspace. The
   * difference matters: `workspaceSchema` is all-or-nothing, so a single record written by
   * an older build used to make the case permanently unopenable — and there is no screen
   * from which a user can reach a document the app refuses to read, so "permanently" meant
   * exactly that. Skipping the row is the same choice `listCases` makes, and the count is
   * reported so a case that quietly lost records is visible in a log rather than only in a
   * confused support thread.
   *
   * Each slice is parsed inside its own query rather than after all of them have landed, so
   * a collection's raw snapshot becomes collectable as soon as it has been read instead of
   * eleven of them being held to the end. On a case with a hundred documents of source text
   * that is the difference that matters on a phone.
   */
  async loadWorkspace(ownerId: string, caseId: string): Promise<Workspace> {
    const skipped = new Skipped();

    const [caseDocument, scoped] = await Promise.all([
      getDoc(doc(this.db, COLLECTIONS.cases, caseId)),
      Promise.all(
        WORKSPACE_COLLECTIONS.filter((name) => name !== COLLECTIONS.cases).map(async (name) => {
          const snapshot = await getDocs(
            query(
              collection(this.db, name),
              where('caseId', '==', caseId),
              where('ownerId', '==', ownerId),
            ),
          );
          return [name, skipped.keep(name, snapshot.docs.map((document) => document.data()))] as const;
        }),
      ),
    ]);

    // Assembled directly rather than handed back to `workspaceSchema`. Every record here has
    // already been through its own schema, so a second full parse would only re-walk the
    // source text of every document in the case to reach a conclusion already reached.
    const workspace = emptyWorkspace();
    const slots = workspace as Record<WorkspaceCollection, unknown[]>;
    for (const [name, records] of scoped) slots[name] = records;
    slots[COLLECTIONS.cases] = skipped.keep(
      COLLECTIONS.cases,
      caseDocument.exists() ? [caseDocument.data()] : [],
    );

    skipped.report('a case');
    return workspace;
  }

  /**
   * Everything one owner has, in a single pass.
   *
   * Search and the activity list need every case at once. Without this method they fall
   * back to `listCases` followed by a `loadWorkspace` per case — ten case-scoped queries
   * each, so ten per case on an account, and every case's records materialised twice: once
   * as its own workspace and again in the merged copy the screen actually reads. Filtering
   * on `ownerId` instead of `caseId` collapses that to one query per collection, eleven in
   * total, however many cases the account holds, and builds the result once.
   *
   * No new index is involved. `ownerId` equality is served by the single-field index
   * Firestore maintains for every field automatically — it is the same query `clear()`
   * already runs over all eleven collections — so this needs nothing added to
   * `firestore.indexes.json`. The composite `(caseId, ownerId)` indexes stay where they
   * are; `loadWorkspace` still uses them.
   *
   * Soft-deleted cases and anything belonging to one are dropped here rather than in the
   * screens. That keeps the result identical to what the per-case fallback would have
   * produced — it only ever queried cases `listCases` returned — and it is also the point
   * of doing this at all: a discarded case's evidence carries its full source text, and
   * there is no reason to hold that in a phone's memory to build an index nothing in it
   * can match.
   */
  async loadAllWorkspace(ownerId: string): Promise<Workspace> {
    const skipped = new Skipped();

    const owned = await Promise.all(
      WORKSPACE_COLLECTIONS.map(async (name) => {
        const snapshot = await getDocs(
          query(collection(this.db, name), where('ownerId', '==', ownerId)),
        );
        return [name, skipped.keep(name, snapshot.docs.map((document) => document.data()))] as const;
      }),
    );
    skipped.report('an account');

    const byCollection = new Map(owned);
    const cases = (byCollection.get(COLLECTIONS.cases) ?? []) as Case[];
    const live = new Set(
      cases.filter((record) => record.deletedAt === null).map((record) => record.id),
    );

    const workspace = emptyWorkspace();
    const slots = workspace as Record<WorkspaceCollection, unknown[]>;
    workspace.cases = cases.filter((record) => live.has(record.id));
    for (const name of WORKSPACE_COLLECTIONS) {
      if (name === COLLECTIONS.cases) continue;
      // Every collection but `cases` is case-scoped, which `workspaceForCase` in the port
      // relies on too — so a record whose case is gone is an orphan, not a special case.
      const records = (byCollection.get(name) ?? []) as Array<{ caseId: string }>;
      slots[name] = records.filter((record) => live.has(record.caseId));
    }

    return workspace;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Applies changes as one unit.
   *
   * Ownership is asserted before anything is sent. Security Rules are the real boundary
   * and will reject a foreign write regardless — this exists so the failure is a clear
   * developer error naming the record, rather than an opaque permission-denied.
   *
   * The wait for the server is bounded; see `COMMIT_ACK_TIMEOUT_MS`. A timeout is reported
   * as `LOCAL_PENDING` and not as an error, because by the time it expires the records are
   * already in Firestore's persistent cache and will be sent on reconnect — failing here
   * would show the user an error over data that is in no danger, and there is nothing to
   * roll back even if that were wanted. A *rejection* is a different thing entirely and
   * still propagates: a permission denial or an invalid document is a real failure.
   */
  async commit(ownerId: string, changes: readonly Change[]): Promise<CommitOutcome> {
    if (changes.length === 0) return { durability: 'SERVER' };
    assertOwnership(ownerId, changes);

    let durability: CommitDurability = 'SERVER';

    for (let index = 0; index < changes.length; index += MAX_BATCH_WRITES) {
      const slice = changes.slice(index, index + MAX_BATCH_WRITES);
      const batch = writeBatch(this.db);

      for (const change of slice) {
        if (change.op === 'put') {
          const sanitized = cleanForFirestore(change.record);
          batch.set(doc(this.db, change.collection, change.record.id), sanitized as object);
        } else {
          batch.delete(doc(this.db, change.collection, change.id));
        }
      }

      // Issuing the batch is what writes it to the cache; the promise is only the server's
      // answer about it. Both still have to happen for every slice — skipping the rest of
      // them after a timeout would drop those records on the floor.
      const acknowledgement = batch.commit();

      if (durability === 'LOCAL_PENDING') {
        // An earlier slice already timed out, so this one will too. Its records are in the
        // cache with the rest and replay with them; waiting the full timeout again per
        // slice would only lengthen the spinner to re-learn something already known.
        absorbLateFailure(acknowledgement);
        continue;
      }

      durability = await acknowledgedWithin(acknowledgement);
    }

    return { durability };
  }

  /**
   * Deletes every document this owner has, in every collection, plus their profile.
   *
   * Firestore gives a client no recursive delete, so this is one query per collection and
   * one batched delete per page of results. `where('ownerId', '==', …)` is the same filter
   * the security rules enforce, so nothing outside the owner's data is reachable here even
   * if this loop were wrong. Two things differ from every other read in this file, both
   * deliberate: there is no `deletedAt` filter, because an erase that skipped soft-deleted
   * records would leave exactly the material the user wants gone; and the page is re-queried
   * rather than cursored, because each pass deletes the rows it just read, so the next query
   * for the same filter returns what remains.
   *
   * `page.size < MAX_BATCH_WRITES` ends the loop on a short page. A full page means there may
   * be more, so it queries again — and the loop is safe against an empty result either way.
   *
   * Nothing here waits on `COMMIT_ACK_TIMEOUT_MS` the way `commit` does, and that is the
   * point: a queued delete is a document still on the server. The port promises an erase is
   * total or it throws, and "we have told the cache to forget it" is not total. A user
   * erasing their account offline gets a failure and can try again where there is signal.
   */
  async clear(ownerId: string): Promise<void> {
    // Case-scoped collections first, `cases` last. `WORKSPACE_COLLECTIONS` leads with
    // `cases` because that is the order a workspace is assembled in and other callers read
    // it that way, so the order is derived here rather than changed there. What it buys is
    // a coherent halfway point: if the run dies — signal drops, the OS kills the app — what
    // is left is cases that have lost some of their records, an account that still opens
    // and can be erased again. Taking the cases out first leaves the opposite, an app that
    // looks empty while every claim, document and audit entry behind it is still stored.
    const order: readonly WorkspaceCollection[] = [
      ...WORKSPACE_COLLECTIONS.filter((name) => name !== COLLECTIONS.cases),
      COLLECTIONS.cases,
    ];

    let cleared = 0;
    for (const name of order) {
      try {
        for (;;) {
          const page = await getDocs(
            query(
              collection(this.db, name),
              where('ownerId', '==', ownerId),
              limit(MAX_BATCH_WRITES),
            ),
          );
          if (page.empty) break;

          const batch = writeBatch(this.db);
          for (const document of page.docs) batch.delete(document.ref);
          await batch.commit();

          if (page.size < MAX_BATCH_WRITES) break;
        }
      } catch (error) {
        // Re-thrown, because a partial erase reported as success is the one outcome the
        // port forbids — but re-thrown saying how far it got. The user's next move is the
        // same either way (try again, and the retry re-queries what remains), so this is
        // for whoever reads the report of it. The collection name is a schema name; no
        // record id or document body goes into the message.
        throw new Error(
          `Your data could not be fully deleted: ${cleared} of ${order.length} collections ` +
            `were cleared before ${name} failed. Nothing already deleted comes back — try ` +
            `again to remove the rest. (${toError(error).message})`,
        );
      }
      cleared += 1;
    }

    // The profile is keyed by the user id and carries no `ownerId` field, so the loop above
    // cannot see it. Deleting a document that is already gone is not an error in Firestore.
    await deleteDoc(doc(this.db, COLLECTIONS.users, ownerId));
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Watches every collection belonging to a case and re-emits the assembled workspace.
   *
   * Firestore has no query across multiple collections, so this is one listener per
   * collection. Each listener holds its slice in a local map and emits on change; the
   * workspace is assembled from those slices rather than re-read, which keeps the cost of
   * a single edit to one document re-render.
   *
   * The first emission therefore arrives once every listener has reported. Until then the
   * screen shows a skeleton, which is the honest state — a partially loaded case would
   * show a claim with no evidence attached to it.
   *
   * Which makes the failure path load-bearing. A listener that errors is finished —
   * Firestore does not retry one — so the report it owed never arrives, and without the
   * settle below the first emission never happens no matter how many of the other ten
   * collections are fine. `settled` is the latch over that: the load ends exactly once,
   * either because every slice arrived or because one collection said it never would.
   */
  watchWorkspace(
    ownerId: string,
    caseId: string,
    onChange: (workspace: Workspace) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    const slices = new Map<WorkspaceCollection, unknown[]>();
    let settled = false;
    let active = true;
    let pending = WORKSPACE_COLLECTIONS.length;
    const unsubscribes: Unsubscribe[] = [];

    /**
     * Takes every listener down.
     *
     * Safe to call twice — the failure path and the caller's own unsubscribe both arrive
     * here — and safe to call while the listeners are still being registered, because it
     * drains the list rather than walking it.
     */
    const stop = () => {
      active = false;
      while (unsubscribes.length > 0) unsubscribes.pop()?.();
    };

    const emit = () => {
      if (!active || !settled) return;
      const shape: Record<string, unknown> = {};
      for (const [name, records] of slices) shape[name] = records;

      const parsed = workspaceSchema.safeParse(shape);
      if (!parsed.success) {
        onError?.(new Error('A change arrived that does not match the expected shape'));
        return;
      }
      onChange(parsed.data);
    };

    /** Records one collection's slice, then emits once every collection has reported. */
    const receive = (name: WorkspaceCollection, records: unknown[]) => {
      if (!active) return;
      slices.set(name, records);
      if (!settled) {
        pending -= 1;
        if (pending === 0) settled = true;
      }
      emit();
    };

    const fail = (error: unknown) => {
      if (!active) return;

      if (settled) {
        // The case is already on screen. One collection going quiet is worth a banner, but
        // not worth tearing down ten working listeners over.
        onError?.(toError(error));
        return;
      }

      // Nothing has been delivered yet, and now nothing ever will be from this listener.
      // Ending the load here — and taking the rest down with it — is what turns an error
      // into an answer instead of a permanent skeleton. `stop()` first, so the survivors
      // are gone before the callback runs and cannot race a resubscribe into emitting into
      // a load the screen has already been told failed.
      settled = true;
      stop();
      onError?.(toError(error));
    };

    // The case itself is a single document; every other entity is a case-scoped query.
    unsubscribes.push(
      onSnapshot(
        doc(this.db, COLLECTIONS.cases, caseId),
        (snapshot) => receive(COLLECTIONS.cases, snapshot.exists() ? [snapshot.data()] : []),
        fail,
      ),
    );

    for (const name of WORKSPACE_COLLECTIONS) {
      if (name === COLLECTIONS.cases) continue;

      unsubscribes.push(
        onSnapshot(
          query(
            collection(this.db, name),
            where('caseId', '==', caseId),
            where('ownerId', '==', ownerId),
          ),
          (snapshot) => receive(name, snapshot.docs.map((document) => document.data())),
          fail,
        ),
      );
    }

    // A listener can fail while the loop above is still registering the rest, in which case
    // `stop()` has already drained a list that was still growing. Draining what arrived
    // after it is what keeps that race from leaving a live snapshot listener behind.
    if (!active) stop();

    return stop;
  }

  /**
   * Watches the case list.
   *
   * Filtered to non-deleted cases before emitting, matching `listCases`.
   */
  watchCases(
    ownerId: string,
    onChange: (cases: Case[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    let active = true;

    // `where('ownerId', '==', ownerId)` is the one filter every read carries. It is what
    // the Security Rules check, and it keeps the query within what a single-field index
    // covers, so the case list works before any composite index has been created.
    const target = query(
      collection(this.db, COLLECTIONS.cases),
      where('ownerId', '==', ownerId),
    );

    const unsubscribe = onSnapshot(
      target,
      (snapshot) => {
        if (!active) return;
        const records: Case[] = [];
        for (const document of snapshot.docs) {
          const parsed = parseOrNull(
            caseSchema,
            document.data(),
            `${COLLECTIONS.cases}/${document.id}`,
          );
          if (parsed && parsed.deletedAt === null) records.push(parsed);
        }
        onChange(records.sort((a, b) => b.updatedAt - a.updatedAt));
      },
      (error) => {
        if (active) onError?.(toError(error));
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let cached: FirebaseRepository | null = null;

/** `connectFirestoreEmulator` throws if called twice on one instance. */
let firestoreEmulatorConnected = false;

/**
 * Builds the adapter, reusing the app instance if one already exists.
 *
 * Firestore is initialised with a persistent on-disk cache so a case opened once is still
 * readable with no connection. That matters for this product specifically: the moment a
 * user is most likely to want to check a document is in a meeting, on a train, or in a room
 * with bad signal.
 */
export async function createFirebaseRepository(): Promise<FirebaseRepository> {
  if (cached) return cached;

  const config = getFirebaseConfig();
  if (!config) {
    throw new Error('Firebase is not configured. Set the EXPO_PUBLIC_FIREBASE_* variables.');
  }

  const app = getAppOrInitialize(config);

  // The persistent cache is a want, not a need. `initializeFirestore` throws
  // `failed-precondition` if Firestore was already initialised for this app — which happens
  // on a Fast Refresh, and would otherwise take the whole app down — and the persistence
  // layer itself is the part of the SDK most sensitive to the host environment. Degrading
  // to the in-memory cache costs offline reads; failing here costs the entire backend.
  let db: Firestore;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
  } catch (error) {
    console.warn(
      '[firestore] persistent cache unavailable, using in-memory:',
      error instanceof Error ? error.message : 'unknown',
    );
    db = getFirestore(app);
  }

  // `.env` documents this flag as routing "Auth/Firestore/Storage" at the Emulator Suite,
  // and until now only Auth read it — so a developer who set it got a split brain: sign-in
  // against the emulator, every document read and write against the **live** project.
  // Pointing at an emulator is an all-or-nothing choice, and a half-applied one is worse
  // than none, because the writes that escape go somewhere real.
  if (useFirebaseEmulator() && !firestoreEmulatorConnected) {
    try {
      const { connectFirestoreEmulator } = await import('firebase/firestore');
      connectFirestoreEmulator(db, firebaseEmulatorHost(), 8080);
      firestoreEmulatorConnected = true;
    } catch (error) {
      // A failed connect leaves the instance pointed at production, which is exactly the
      // situation the flag was set to avoid — so this refuses to hand back a repository
      // rather than quietly writing live data.
      throw new Error(
        'The Firestore emulator could not be reached, and this build is configured to use it. ' +
          'Start the Emulator Suite or unset EXPO_PUBLIC_USE_FIREBASE_EMULATOR. ' +
          (error instanceof Error ? error.message : ''),
      );
    }
  }

  cached = new FirebaseRepository(db);
  return cached;
}

function getAppOrInitialize(config: FirebaseConfig): FirebaseApp {
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;
  return initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  });
}

/** The underlying Firestore handle, for the few places that need it directly (e.g. batch jobs). */
export function firestoreInstanceOf(repository: FirebaseRepository): Firestore {
  return repository.database;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a document, returning `null` on failure.
 *
 * A single malformed document is skipped rather than failing the whole query: one bad row
 * must not make a case unopenable. The path is named so the warning is actionable, and the
 * document body is never included.
 */
function parseOrNull<T>(schema: Parseable<T>, data: unknown, path: string): T | null {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  // The collection, not the path. A full document path carries the owner id and the record
  // id, and a skipped-document warning does not need either to be actionable.
  console.warn(`[firestore] skipping malformed document in ${path.split('/')[0] ?? 'workspace'}`);
  return null;
}

/** What a boundary parse needs of a zod schema, and nothing more. */
interface Parseable<T = unknown> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

/**
 * Reads a collection's documents, dropping the ones that will not parse, and keeps a tally.
 *
 * `parseOrNull` already warns per document, which names the collection but says nothing
 * about scale — one skipped row and four hundred read the same in a log. The tally is the
 * number that tells those apart, and it is the number worth acting on.
 */
class Skipped {
  count = 0;

  keep(name: WorkspaceCollection, records: readonly unknown[]): unknown[] {
    const kept: unknown[] = [];
    for (const record of records) {
      const parsed = parseOrNull(RECORD_SCHEMAS[name], record, name);
      if (parsed === null) this.count += 1;
      else kept.push(parsed);
    }
    return kept;
  }

  /** `scope` names what was being read, never which case or whose. */
  report(scope: string): void {
    if (this.count === 0) return;
    console.warn(
      `[firestore] read ${scope} with ${this.count} unreadable document(s) skipped; ` +
        'those records are not visible in the app',
    );
  }
}

/**
 * Waits for a batch's server acknowledgement, giving up after `COMMIT_ACK_TIMEOUT_MS`.
 *
 * A rejection is re-thrown, because a permission denial or an invalid document is a real
 * failure the caller has to see. Only the silence is bounded — and offline, silence is the
 * normal case rather than an error.
 */
async function acknowledgedWithin(acknowledgement: Promise<void>): Promise<CommitDurability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<CommitDurability>((resolve) => {
    timer = setTimeout(() => resolve('LOCAL_PENDING'), COMMIT_ACK_TIMEOUT_MS);
  });

  try {
    const durability = await Promise.race([
      acknowledgement.then((): CommitDurability => 'SERVER'),
      expiry,
    ]);
    if (durability === 'LOCAL_PENDING') absorbLateFailure(acknowledgement);
    return durability;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keeps a late rejection from surfacing as an unhandled promise rejection.
 *
 * The caller has already been told the write is queued and Firestore replays a queued batch
 * itself, so there is nothing left for anyone to act on — but a rejection arriving after the
 * race is decided would otherwise be reported by the runtime as unhandled, which in a
 * release build reads like a crash. The message is the SDK's own and names no record.
 */
function absorbLateFailure(acknowledgement: Promise<void>): void {
  void acknowledgement.catch((error: unknown) => {
    console.warn(`[firestore] a queued batch was rejected after it was reported as pending: ${toError(error).message}`);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Recursively strips undefined values and normalizes objects/arrays for Firestore batch operations.
 * Prevents "Function WriteBatch.set() called with invalid data. Unsupported field value: undefined" errors.
 */
function cleanForFirestore(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => cleanForFirestore(item));
  }
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) {
      cleaned[k] = cleanForFirestore(v);
    }
  }
  return cleaned;
}

export { emptyWorkspace };
