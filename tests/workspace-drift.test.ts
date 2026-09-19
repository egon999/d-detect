/**
 * What one unreadable row is allowed to cost.
 *
 * Records here outlive the build that wrote them: Firestore is schemaless, the platform API
 * serves whatever was stored, and neither has a migration behind it. So a renamed enum member
 * or a half-written row is not a hypothetical — it is the normal end state of shipping twice.
 *
 * The question these tests settle is how much of an account that costs. Validating an assembled
 * workspace makes the answer "all of it", and the failure is not recoverable from any screen:
 * there is nowhere in the app to reach a document the app refuses to read. Validating a record
 * makes the answer "that record", which is the only answer a user can act on.
 *
 * `LocalRepository` already worked this way and is covered in `data-layer.test.ts`; these cover
 * the two adapters that did not, and assert the line on the other side of it too — a listener
 * that really is finished still has to say so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The snapshot listeners, keyed by the collection they were opened against.
 *
 * Firestore's own client is left in place and only its query surface is replaced, so the
 * adapter is exercised through the same calls it makes in production. `live` counts
 * registrations against unsubscribes, which is how the teardown assertions below can tell a
 * subscription that reported a failure from one that also stopped listening.
 */
const firestore = vi.hoisted(() => {
  interface Listener {
    next: (snapshot: unknown) => void;
    fail: (error: unknown) => void;
  }
  const listeners = new Map<string, Listener[]>();
  const live = { count: 0 };
  return {
    listeners,
    live,
    reset(): void {
      listeners.clear();
      live.count = 0;
    },
    at(name: string): Listener {
      const registered = listeners.get(name);
      if (!registered?.length) throw new Error(`no listener was opened on ${name}`);
      return registered[registered.length - 1]!;
    },
  };
});

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  collection: (_db: unknown, name: string) => ({ name }),
  doc: (_db: unknown, name: string, id: string) => ({ name, id }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (target: { name: string }, ...clauses: unknown[]) => ({ name: target.name, clauses }),
  onSnapshot: (
    target: { name: string },
    next: (snapshot: unknown) => void,
    fail: (error: unknown) => void,
  ) => {
    const registered = firestore.listeners.get(target.name) ?? [];
    registered.push({ next, fail });
    firestore.listeners.set(target.name, registered);
    firestore.live.count += 1;
    return () => {
      firestore.live.count -= 1;
    };
  },
}));

const api = vi.hoisted(() => vi.fn());
vi.mock('@services/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@services/api-client')>()),
  apiJson: api,
}));

// Hand-listed rather than spread from `importOriginal`, the exception this repo allows for a
// native module: `expo-constants` reaches `expo-modules-core`, which indexes a global the Expo
// runtime installs and Node does not, so importing the original in order to spread it is the
// thing the mock exists to avoid. The adapter pulls it in through `firebase/config` and reads
// only `expoConfig.extra`, on a path no test here takes — nothing constructs a real client.
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));

import type { Firestore } from 'firebase/firestore';
import { FirebaseRepository } from '@data/firebase/firebase-repository';
import { RemoteRepository } from '@data/remote/remote-repository';
import { runCaseAnalysis, type MutationContext } from '@data/mutations';
import { WORKSPACE_COLLECTIONS, workspaceForCase, type WorkspaceCollection } from '@data/repository';
import { buildGraph } from '@domain/analysis/graph';
import { emptyWorkspace, type Workspace } from '@domain/models';
import { CASE_ID, claim, evidence, link, OWNER, ref, resetIds, testCase } from './helpers';

const NOW = 1_700_000_000_000;

/** Drains the promise chain a poll-driven read settles on. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let sequence = 0;
const context = (): MutationContext => ({
  ownerId: OWNER,
  now: NOW,
  nextId: (prefix) => `${prefix}_m${(sequence += 1)}`,
});

/**
 * A claim written by a build whose enum had a member since renamed.
 *
 * The shape drift actually takes. A hand-broken row — a missing `id`, a string where a number
 * belongs — would fail the schema for reasons no shipped build ever produced.
 */
const drifted = (source: ReturnType<typeof claim>, id: string) => ({ ...source, id, state: 'PROBABLY_TRUE' });

let warnings: string[] = [];

beforeEach(() => {
  resetIds();
  sequence = 0;
  firestore.reset();
  api.mockReset();
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a Firestore subscription over rows an older build wrote', () => {
  const subscribe = () => {
    const seen: Workspace[] = [];
    const failures: Error[] = [];
    const stop = new FirebaseRepository(null as unknown as Firestore).watchWorkspace(
      OWNER,
      CASE_ID,
      (workspace) => seen.push(workspace),
      (error) => failures.push(error),
    );
    return { seen, failures, stop };
  };

  /** Delivers one collection's snapshot in the shape the adapter reads it back in. */
  const push = (name: WorkspaceCollection, rows: readonly unknown[]) => {
    const listener = firestore.at(name);
    if (name === 'cases') listener.next({ exists: () => rows.length > 0, data: () => rows[0] });
    else listener.next({ docs: rows.map((row) => ({ data: () => row })) });
  };

  /**
   * Brings a subscription to its first emission.
   *
   * Every collection has to report before anything is delivered, so a test that only pushes the
   * one it cares about would assert against a workspace that never arrived.
   */
  const settle = (rows: Partial<Record<WorkspaceCollection, readonly unknown[]>> = {}) => {
    for (const name of WORKSPACE_COLLECTIONS) {
      push(name, rows[name] ?? (name === 'cases' ? [testCase()] : []));
    }
  };

  it('delivers the case with the unreadable row dropped and the rest of it intact', () => {
    const good = claim('Still readable', { id: 'clm_good' });
    const { seen, failures } = subscribe();

    settle({ claims: [good, drifted(good, 'clm_stale')], evidence: [evidence('Invoice No: INV-1', { id: 'evd_1' })] });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.claims.map((item) => item.id)).toEqual(['clm_good']);
    expect(seen[0]!.evidence.map((item) => item.id)).toEqual(['evd_1']);
    expect(seen[0]!.cases.map((item) => item.id)).toEqual([CASE_ID]);
    // The whole point: drift is not a failure. A case `loadWorkspace` opened by skipping this
    // same row must not be replaced by an error screen on its first snapshot.
    expect(failures).toEqual([]);
  });

  it('keeps delivering later snapshots instead of stopping at the first drifted one', () => {
    const good = claim('Still readable', { id: 'clm_good' });
    const note = evidence('Invoice No: INV-2024-018', { id: 'evd_note' });
    const { seen, failures } = subscribe();

    settle({ claims: [drifted(good, 'clm_stale')], evidence: [note] });
    expect(seen[0]!.claims).toEqual([]);

    push('claims', [good, drifted(good, 'clm_stale')]);
    push('claims', [good]);

    expect(seen).toHaveLength(3);
    expect(seen[1]!.claims.map((item) => item.id)).toEqual(['clm_good']);
    expect(seen[2]!.claims.map((item) => item.id)).toEqual(['clm_good']);
    // The slices a snapshot did not touch carry forward; only the collection that changed is
    // re-read, which is what keeps a one-document edit from re-parsing every document's text.
    expect(seen[2]!.evidence.map((item) => item.id)).toEqual(['evd_note']);
    // Carried forward by value, not by reference. The other two adapters re-read their store
    // per emission, so a consumer that sorts a list in place must not be able to reach back
    // into a workspace this one already delivered.
    expect(seen[2]!.evidence).not.toBe(seen[1]!.evidence);
    expect(failures).toEqual([]);
  });

  it('still reports a listener that will never deliver, and takes the others down with it', () => {
    const { seen, failures } = subscribe();

    firestore.at('evidence').fail(new Error('Missing or insufficient permissions.'));

    expect(failures.map((error) => error.message)).toEqual(['Missing or insufficient permissions.']);
    expect(seen).toEqual([]);
    // Nothing was ever delivered, so a surviving listener would hold the screen on a skeleton
    // that can never resolve.
    expect(firestore.live.count).toBe(0);
  });

  it('reports a listener that fails after the case is on screen without tearing the case down', () => {
    const { seen, failures, stop } = subscribe();
    settle();
    expect(seen).toHaveLength(1);

    firestore.at('auditLogs').fail(new Error('Missing or insufficient permissions.'));

    expect(failures.map((error) => error.message)).toEqual(['Missing or insufficient permissions.']);
    expect(firestore.live.count).toBe(WORKSPACE_COLLECTIONS.length);
    stop();
    expect(firestore.live.count).toBe(0);
  });

  it('names the collection and the count, and neither the record nor the owner', () => {
    const good = claim('Still readable', { id: 'clm_good' });
    const { seen } = subscribe();

    settle({ claims: [good, drifted(good, 'clm_stale')] });

    expect(seen).toHaveLength(1);
    expect(warnings.some((line) => line.includes('claims'))).toBe(true);
    expect(warnings.some((line) => line.includes('1 unreadable document'))).toBe(true);
    const logged = warnings.join('\n');
    expect(logged).not.toContain('clm_stale');
    expect(logged).not.toContain(OWNER);
    expect(logged).not.toContain('Still readable');
  });

  /**
   * The tallying is shared with the other two adapters; the voice is not.
   *
   * `Skipped` lives on the port because all three answer drift the same way, and the wording is
   * the one thing that has to stay apart: this app runs against a device store, Firestore and a
   * platform server, and the first question asked of a log line that says rows went missing is
   * which of the three lost them. Pinned here because a shared class is exactly where that
   * distinction gets flattened into one prefix by someone tidying up.
   */
  it('still says which store lost the row, in that store own words', () => {
    const good = claim('Still readable', { id: 'clm_good' });
    subscribe();

    settle({ claims: [good, drifted(good, 'clm_stale')] });

    expect(warnings.every((line) => line.startsWith('[firestore]'))).toBe(true);
    // Firestore stores documents. The device store and the platform API store records, and
    // calling a Firestore document a record in a log sends a developer to the wrong adapter.
    expect(warnings.some((line) => line === '[firestore] skipping malformed document in claims')).toBe(true);
    expect(warnings.join('\n')).not.toContain('record in claims');
  });

  it('says nothing about a case whose every row still parses', () => {
    const { seen, failures } = subscribe();
    settle({ claims: [claim('Fine', { id: 'clm_ok' })] });

    expect(seen[0]!.claims).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  /**
   * The cost of dropping a row is a reference nothing resolves, which `src/ui/theme.tsx`
   * documents as a real crash class: a value read back out of storage indexes a lookup table
   * TypeScript has already promised is populated, and the miss becomes a render-phase
   * TypeError that the navigation ErrorBoundary answers by replacing the whole app.
   *
   * So the dropped row is only half the fix. These run the workspace the adapter actually
   * emitted through the two consumers that walk relationships — the graph a screen renders and
   * the rule engine an analysis run drives — with the far end of an edge missing.
   */
  it('leaves a dangling edge that the graph and the rule engine both survive', () => {
    const note = evidence('Invoice No: INV-2024-018', { id: 'evd_note' });
    const target = claim('The balance is outstanding', { id: 'clm_target' });
    const edge = link(ref.evidence('evd_note'), ref.claim('clm_target'), 'SUPPORTS', { id: 'rel_edge' });
    const { seen } = subscribe();

    settle({ evidence: [note], claims: [drifted(target, 'clm_target')], relationships: [edge] });

    const emitted = workspaceForCase(seen[0]!, CASE_ID);
    expect(emitted.claims).toEqual([]);
    expect(emitted.relationships.map((item) => item.id)).toEqual(['rel_edge']);

    const graph = buildGraph(emitted, CASE_ID);
    expect(graph.nodes.map((node) => node.id)).toEqual(['evd_note']);
    // Rendered as an absent edge rather than an edge to nothing. A node that is not there
    // cannot be positioned, and a screen that tried would be the crash this avoids.
    expect(graph.edges).toEqual([]);
    expect(() => runCaseAnalysis(emitted, context(), CASE_ID)).not.toThrow();
  });
});

describe('a platform response holding rows an older build wrote', () => {
  const body = (parts: Partial<Record<string, unknown>>) => ({ ...emptyWorkspace(), cases: [testCase()], ...parts });

  it('serves the account with the unreadable row dropped and the rest of it intact', async () => {
    const good = claim('Still readable', { id: 'clm_good' });
    api.mockResolvedValue(body({ claims: [good, drifted(good, 'clm_stale')] }));

    const loaded = await new RemoteRepository().loadWorkspace(OWNER, CASE_ID);

    expect(loaded.claims.map((item) => item.id)).toEqual(['clm_good']);
    expect(loaded.cases.map((item) => item.id)).toEqual([CASE_ID]);
  });

  it('still lists the cases of an account one of whose rows will not parse', async () => {
    const good = claim('Still readable', { id: 'clm_good' });
    api.mockResolvedValue(body({ claims: [drifted(good, 'clm_stale')] }));

    expect((await new RemoteRepository().listCases(OWNER)).map((item) => item.id)).toEqual([CASE_ID]);
    expect(warnings.some((line) => line.includes('1 unreadable record'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('clm_stale');
  });

  /** The other half of the pinning above: the shared tally must not answer in one voice. */
  it('still says the platform server lost the row, not the phone', async () => {
    const good = claim('Still readable', { id: 'clm_good' });
    api.mockResolvedValue(body({ claims: [drifted(good, 'clm_stale')] }));

    await new RemoteRepository().listCases(OWNER);

    expect(warnings.every((line) => line.startsWith('[remote]'))).toBe(true);
    expect(warnings.some((line) => line === '[remote] skipping malformed record in claims')).toBe(true);
    // An account, not a case. This adapter fetches the whole account in one request, so a
    // per-case scope would understate how much a tally of four hundred rows covers.
    expect(warnings.some((line) => line.includes('read an account with 1 unreadable record'))).toBe(true);
  });

  it('skips a collection the server did not send as a list', async () => {
    api.mockResolvedValue(body({ claims: { clm_a: claim('Keyed by id', { id: 'clm_a' }) } }));

    const loaded = await new RemoteRepository().loadWorkspace(OWNER, CASE_ID);

    expect(loaded.claims).toEqual([]);
    expect(loaded.cases).toHaveLength(1);
  });

  it('refuses a body that is not a workspace at all', async () => {
    api.mockResolvedValue(null);
    await expect(new RemoteRepository().listCases(OWNER)).rejects.toThrow('could not be read');

    api.mockResolvedValue([testCase()]);
    await expect(new RemoteRepository().listCases(OWNER)).rejects.toThrow('could not be read');
  });

  it('still refuses an account containing another owner records', async () => {
    api.mockResolvedValue(body({ cases: [testCase(), testCase({ id: 'case_other', ownerId: 'user_other' })] }));
    await expect(new RemoteRepository().listCases(OWNER)).rejects.toThrow('another account');
  });

  it('keeps a watcher running over a drifted row and still reports a dead request', async () => {
    const good = claim('Still readable', { id: 'clm_good' });
    api.mockResolvedValue(body({ claims: [good, drifted(good, 'clm_stale')] }));
    const seen: Workspace[] = [];
    const failures: Error[] = [];

    const repository = new RemoteRepository();
    const stop = repository.watchWorkspace(OWNER, CASE_ID, (value) => seen.push(value), (error) => failures.push(error));
    await flush();
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.claims.map((item) => item.id)).toEqual(['clm_good']);
    expect(failures).toEqual([]);

    // And the channel still carries what it is for. A refused or unreachable request is not
    // drift, and a watcher that had stopped reporting those would leave a screen showing a case
    // that has silently stopped refreshing.
    api.mockRejectedValue(new Error('The platform service could not be reached.'));
    const dead: Error[] = [];
    const stopDead = repository.watchCases(OWNER, () => {}, (error) => dead.push(error));
    await flush();
    stopDead();

    expect(dead.map((error) => error.message)).toEqual(['The platform service could not be reached.']);
  });
});
